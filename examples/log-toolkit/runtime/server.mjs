#!/usr/bin/env node
/**
 * Log Toolkit runtime (UPP productivity plugin, zero dependencies).
 *
 * Log files are streamed line by line inside this process; the model only ever
 * receives an aggregate or a bounded window:
 *   log_scan   -> level counts + first/last timestamp + top normalized messages
 *   log_grep   -> matching line numbers with optional context lines
 *   log_window -> an exact 1-based line window plus the total line count
 *
 * Modes:
 *   - MCP stdio server : node runtime/server.mjs
 *   - CLI              : node runtime/server.mjs --cli <tool> --json '{...}'
 *   - introspection    : node runtime/server.mjs --info | --list
 *
 * Every channel returns the same envelope: { ok, data, channel, host, elapsedMs }.
 */
import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'tools.json'), 'utf8'));
const SERVER_NAME = MANIFEST.serverName;
const SERVER_VERSION = MANIFEST.version;
const HOST = process.env.UPP_HOST || 'unknown';
const CHANNEL = process.argv[2] === '--cli' ? 'cli' : 'mcp';

// Contract limits: everything heavy stays local, every answer stays small.
const MAX_LINE_CHARS = 2000;
const OUTER_CAP_BYTES = 16 * 1024;
const DATA_CAP_BYTES = 15 * 1024;
const TOP_MESSAGES = 10;
const TAIL_CHUNK = 64 * 1024;

const TS_RE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)/;
const TS_RE_GLOBAL = new RegExp(TS_RE.source, 'g');

// Whole-word-ish guards: `\b` fails next to CJK, `[^a-z]` works for both scripts.
const LEVEL_PATTERNS = [
  ['error', /(?:^|[^a-z])(?:fatal|error|err|severe|critical|panic|exception|failed|failure|错误|异常|失败)s?(?![a-z])/i],
  ['warn', /(?:^|[^a-z])(?:warn|warning|caution|警告|告警|注意)s?(?![a-z])/i],
  ['info', /(?:^|[^a-z])(?:info|information|notice|信息|提示|通知)s?(?![a-z])/i],
  ['debug', /(?:^|[^a-z])(?:debug|trace|verbose|调试|跟踪)s?(?![a-z])/i],
];

// ------------------------------------------------------------------ plumbing
const log = (...parts) => process.stderr.write(`[upp:${SERVER_NAME}] ${parts.join(' ')}\n`);

class UppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function printJSON(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function intArg(value, fallback, min, max, name) {
  const n = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(n)) throw new UppError('INVALID_ARGS', `${name} must be an integer in ${min}..${max}`);
  if (n < min || n > max) throw new UppError('INVALID_ARGS', `${name} must be in ${min}..${max} (got ${n})`);
  return n;
}

function boolArg(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new UppError('INVALID_ARGS', `${name} must be a boolean`);
  return value;
}

function resolveFile(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new UppError('INVALID_ARGS', 'path must be a non-empty string');
  const path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info || !info.isFile()) throw new UppError('NOT_FOUND', `file not found: ${path}`);
  return { path, size: info.size };
}

// ------------------------------------------------------------------ log text
function cleanLine(raw) {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

function stripBom(lines) {
  if (lines.length && lines[0].charCodeAt(0) === 0xfeff) lines[0] = lines[0].slice(1);
  return lines;
}

function extractTs(line) {
  return TS_RE.exec(line)?.[1] ?? null;
}

function levelOf(line) {
  for (const [level, pattern] of LEVEL_PATTERNS) if (pattern.test(line)) return level;
  return 'other';
}

/** Collapse line-identity noise so repeated events aggregate in topMessages. */
function normalizeMessage(line) {
  let text = line.replace(TS_RE_GLOBAL, ' ');
  text = text.replace(/0x[0-9a-f]+/gi, '<hex>');
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>');
  text = text.replace(/\d+(?:[.:]\d+)*/g, '<n>');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/^[-–—:;,.|\s]+/, '').trim();
  return text.slice(0, 120) || '(empty)';
}

// -------------------------------------------------------------------- readers
/** Stream from the start, stopping after maxLines lines. */
async function readHeadLines(path, maxLines) {
  const out = [];
  const input = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      out.push(line);
      if (out.length >= maxLines) break;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return out;
}

/** Read only the last maxLines lines: walk backwards in chunks, decode once. */
function readTailLines(path, size, maxLines) {
  if (size === 0) return [];
  const fd = openSync(path, 'r');
  const chunks = [];
  let pos = size;
  let newlines = 0;
  try {
    while (pos > 0 && newlines <= maxLines) {
      const len = Math.min(TAIL_CHUNK, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, pos);
      chunks.unshift(buf);
      for (let i = 0; i < len; i += 1) if (buf[i] === 0x0a) newlines += 1;
    }
  } finally {
    closeSync(fd);
  }
  const lines = Buffer.concat(chunks).toString('utf8').split('\n');
  if (pos > 0) lines.shift(); // first line may be a partial one
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)).slice(-maxLines);
}

// ------------------------------------------------------------------- handlers
async function logScan(args) {
  const maxLines = intArg(args.maxLines, 500, 100, 5000, 'maxLines');
  const tail = boolArg(args.tail, true, 'tail');
  const { path, size } = resolveFile(args.path);
  const lines = stripBom(tail ? readTailLines(path, size, maxLines) : await readHeadLines(path, maxLines));

  const levelCounts = { error: 0, warn: 0, info: 0, debug: 0, other: 0 };
  const messages = new Map();
  let firstTs = null;
  let lastTs = null;
  for (const line of lines) {
    levelCounts[levelOf(line)] += 1;
    const ts = extractTs(line);
    if (ts !== null) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
    }
    const key = normalizeMessage(line);
    messages.set(key, (messages.get(key) ?? 0) + 1);
  }

  const topMessages = [...messages.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0))
    .slice(0, TOP_MESSAGES);

  return { file: path, bytes: size, linesScanned: lines.length, levelCounts, firstTs, lastTs, topMessages };
}

/**
 * One forward streaming pass over the file.
 *   tail=true  -> keep the newest maxMatches matches (rolling window)
 *   tail=false -> stop after the first maxMatches matches
 * Context lines come from a small rolling buffer, never from the whole file.
 */
async function grepFile(path, { regex, contextLines, maxMatches, keepLast }) {
  const found = [];
  let openAfter = [];
  let before = [];
  let dropped = 0;
  let overflow = false;
  let scanned = 0;

  const input = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const lineNo = scanned + 1;
      scanned = lineNo;
      const text = cleanLine(raw);
      if (openAfter.length) {
        for (const rec of openAfter) rec.after.push(text);
        openAfter = openAfter.filter((rec) => rec.after.length < contextLines);
      }
      if (regex.test(raw)) {
        if (!keepLast && found.length >= maxMatches) {
          overflow = true;
          break;
        }
        const rec = { line: lineNo, before: before.map((entry) => entry.text), text, after: [] };
        found.push(rec);
        if (contextLines > 0) openAfter.push(rec);
        while (keepLast && found.length > maxMatches) {
          const gone = found.shift();
          dropped += 1;
          openAfter = openAfter.filter((rec) => rec !== gone);
        }
      }
      if (contextLines > 0) {
        before.push({ text });
        if (before.length > contextLines) before.shift();
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }

  const matches = [];
  let used = 2;
  let budgetHit = false;
  for (const rec of found) {
    const context = [...rec.before, rec.text, ...rec.after].slice(0, contextLines * 2 + 1);
    const cost = Buffer.byteLength(JSON.stringify(context)) + 2;
    if (used + cost > DATA_CAP_BYTES) {
      budgetHit = true;
      break;
    }
    used += cost;
    matches.push({ line: rec.line, context });
  }
  return { matches, truncated: overflow || dropped > 0 || budgetHit, scannedLines: scanned };
}

async function logGrep(args) {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  if (!pattern) throw new UppError('INVALID_ARGS', 'pattern must be a non-empty string');
  const ignoreCase = boolArg(args.ignoreCase, true, 'ignoreCase');
  const contextLines = intArg(args.contextLines, 0, 0, 5, 'contextLines');
  const maxMatches = intArg(args.maxMatches, 50, 1, 200, 'maxMatches');
  const tail = boolArg(args.tail, true, 'tail');
  let regex;
  try {
    regex = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (error) {
    throw new UppError('INVALID_ARGS', `invalid pattern: ${error.message}`);
  }
  const { path } = resolveFile(args.path);
  return grepFile(path, { regex, contextLines, maxMatches, keepLast: tail });
}

async function logWindow(args) {
  const startLine = intArg(args.startLine, 1, 1, Number.MAX_SAFE_INTEGER, 'startLine');
  const maxLines = intArg(args.maxLines, 50, 1, 200, 'maxLines');
  const { path } = resolveFile(args.path);

  const lines = [];
  let totalLines = 0;
  let budgetHit = false;
  let used = 2;
  const input = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      totalLines += 1;
      if (totalLines < startLine || lines.length >= maxLines || budgetHit) continue;
      const text = cleanLine(raw);
      const cost = Buffer.byteLength(JSON.stringify(text)) + 2;
      if (used + cost > DATA_CAP_BYTES) {
        budgetHit = true;
        continue;
      }
      used += cost;
      lines.push(text);
    }
  } finally {
    rl.close();
    input.destroy();
  }

  if (startLine > totalLines) {
    throw new UppError('INVALID_ARGS', `startLine ${startLine} is past the end of the file (${totalLines} lines)`);
  }
  stripBom(lines);
  return { lines, startLine, endLine: startLine + lines.length - 1, totalLines };
}

const HANDLERS = { log_scan: logScan, log_grep: logGrep, log_window: logWindow };

// --------------------------------------------------------------- envelopes
/** Minimal schema-driven validation so every channel rejects the same inputs. */
function validate(tool, args) {
  const schema = tool.inputSchema ?? {};
  const value = args ?? {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UppError('INVALID_ARGS', 'arguments must be a JSON object');
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) throw new UppError('INVALID_ARGS', `missing required argument: ${key}`);
  }
  const props = schema.properties ?? {};
  for (const [key, spec] of Object.entries(props)) {
    if (!Object.hasOwn(value, key)) continue;
    const expected = spec?.type;
    if (expected === 'integer') {
      if (!Number.isInteger(value[key])) throw new UppError('INVALID_ARGS', `${key} must be an integer`);
      continue;
    }
    const actual = Array.isArray(value[key]) ? 'array' : typeof value[key];
    if (expected && expected !== actual) throw new UppError('INVALID_ARGS', `${key} must be ${expected}`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(props, key)) throw new UppError('INVALID_ARGS', `unknown argument: ${key}`);
    }
  }
  return value;
}

async function callTool(name, args) {
  const tool = MANIFEST.tools.find((entry) => entry.name === name);
  if (!tool) throw new UppError('NOT_FOUND', `unknown tool: ${name}`);
  const clean = validate(tool, args ?? {});
  const started = Date.now();
  const data = (await HANDLERS[name](clean)) ?? {};
  const size = Buffer.byteLength(JSON.stringify(data));
  if (size > OUTER_CAP_BYTES) throw new UppError('INTERNAL', `response ${size} B exceeds the ${OUTER_CAP_BYTES} B cap`);
  return { ok: true, data, channel: CHANNEL, host: HOST, elapsedMs: Date.now() - started };
}

function errorEnvelope(error) {
  return {
    ok: false,
    code: error?.code ?? 'INTERNAL',
    message: error?.message ?? String(error),
    channel: CHANNEL,
    host: HOST,
    elapsedMs: 0,
  };
}

function toolList() {
  return MANIFEST.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

// ------------------------------------------------------------------ CLI mode
function cliArgs(argv) {
  const jsonIdx = argv.indexOf('--json');
  if (jsonIdx > -1) {
    try {
      return JSON.parse(argv[jsonIdx + 1] ?? '{}');
    } catch (error) {
      throw new UppError('INVALID_ARGS', `invalid --json: ${error.message}`);
    }
  }
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else out[key] = true;
    }
  }
  return out;
}

async function runCli(argv) {
  const name = argv[1];
  if (!name) {
    printJSON(errorEnvelope(new UppError('INVALID_ARGS', 'usage: --cli <tool> [--json <object>]')));
    process.exit(2);
  }
  try {
    printJSON({ ...(await callTool(name, cliArgs(argv.slice(2)))), tool: name });
    process.exit(0);
  } catch (error) {
    printJSON(errorEnvelope(error));
    process.exit(error?.code === 'INTERNAL' ? 1 : 2);
  }
}

const argv = process.argv.slice(2);
if (argv[0] === '--info') {
  printJSON({ id: SERVER_NAME, version: SERVER_VERSION, host: HOST, tools: toolList().map((t) => t.name) });
  process.exit(0);
}
if (argv[0] === '--list') {
  printJSON(toolList());
  process.exit(0);
}
if (argv[0] === '--cli') await runCli(argv);

// --------------------------------------------------------- MCP stdio server
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let closing = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg, id) {
  const { method, params } = msg ?? {};
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'Local log toolkit. Call log_scan first for level counts and top messages, then log_grep to locate lines, then log_window for context. Envelope: {ok, data, channel, host, elapsedMs}.',
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: toolList() });
      return;
    case 'tools/call': {
      const { name, arguments: args } = params ?? {};
      try {
        reply(id, { content: [{ type: 'text', text: JSON.stringify(await callTool(name, args)) }], isError: false });
      } catch (error) {
        reply(id, { content: [{ type: 'text', text: JSON.stringify(errorEnvelope(error)) }], isError: true });
      }
      return;
    }
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    default:
      if (id === undefined || id === null) return;
      replyError(id, -32601, `method not found: ${String(method)}`);
  }
}

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch (error) {
    log('ignored non-JSON line:', error.message);
    return;
  }
  const id = msg?.id;
  pending += 1;
  handle(msg, id)
    .catch((error) => {
      if (id !== undefined && id !== null) replyError(id, -32603, `internal error: ${error.message}`);
      log('handler error:', error.message);
    })
    .finally(() => {
      pending -= 1;
      if (closing && pending === 0) process.exit(0);
    });
});

rl.on('close', () => {
  closing = true;
  if (pending === 0) process.exit(0);
});
log('ready on stdio');
