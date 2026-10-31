#!/usr/bin/env node
/**
 * Doc Toolkit runtime (UPP reference productivity plugin, zero dependencies).
 *
 * Local-first: files are inspected on this machine; nothing leaves the process
 * unless the caller explicitly extracts a bounded window. Two tools only, so the
 * always-loaded model surface stays tiny:
 *   digest  -> compact facts + sample (no full content)
 *   extract -> bounded window on demand (text slice / row window)
 *
 * Dual mode:
 *   - MCP stdio server : node server.mjs
 *   - CLI              : node server.mjs --cli <tool> --json '{...}'
 *   - introspection    : node server.mjs --info | --list
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(resolve(HERE, 'tools.json'), 'utf8'));
const SERVER_NAME = MANIFEST.serverName;
const SERVER_VERSION = MANIFEST.version;
const HOST = process.env.UPP_HOST || 'unknown';
const CHANNEL = process.argv[2] === '--cli' ? 'cli' : 'mcp';

function log(...args) {
  process.stderr.write(`[upp:${SERVER_NAME}] ${args.join(' ')}\n`);
}

class UppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------ zip
/** Read a ZIP container without dependencies (docx/xlsx are ZIP + XML). */
function readZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new UppError('INVALID_ARGS', 'file is not a ZIP container (docx/xlsx expected)');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < total; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (localOff + 30 > buf.length) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOff, dataOff + csize);
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
  }
  return entries;
}

function findEocd(buf) {
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&amp;/g, '&');
}

// ------------------------------------------------------------------ docx
function docxDigest(buf) {
  const zip = readZip(buf);
  const doc = zip.get('word/document.xml');
  if (!doc) throw new UppError('INVALID_ARGS', 'not a Word document (word/document.xml missing)');
  const xml = doc.toString('utf8');
  const paragraphs = [];
  for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const inner = match[1];
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(inner)?.[1] ?? '';
    const text = decodeXml(
      inner
        .replace(/<w:tab\s*\/>/g, '\t')
        .replace(/<w:br\s*\/>/g, '\n')
        .replace(/<[^>]+>/g, ''),
    );
    if (!text.trim()) continue;
    const heading = /^heading\s*(\d)$/i.exec(style) ?? /^标题\s*(\d)$/i.exec(style);
    paragraphs.push(heading ? { level: Number(heading[1]), text: text.trim() } : { text: text.trim() });
  }
  const text = paragraphs.map((p) => (p.level ? '#'.repeat(p.level) + ' ' + p.text : p.text)).join('\n');
  return {
    kind: 'docx',
    paragraphs: paragraphs.length,
    headings: paragraphs.filter((p) => p.level).length,
    chars: text.length,
    words: countWords(text),
    outline: paragraphs.filter((p) => p.level).slice(0, 20).map((p) => ({ level: p.level, text: p.text.slice(0, 120) })),
    head: text.slice(0, 600),
    text,
  };
}

function countWords(text) {
  const latin = (text.match(/[A-Za-z0-9_]+/g) ?? []).length;
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return latin + cjk;
}

// ------------------------------------------------------------------ xlsx
function xlsxRows(buf) {
  const zip = readZip(buf);
  const workbook = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map();
  for (const rel of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(rel[0])?.[1];
    const target = /Target="([^"]+)"/.exec(rel[0])?.[1];
    if (id && target) relMap.set(id, target);
  }
  const shared = [];
  const sst = zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(decodeXml([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
  }
  const sheets = [];
  for (const tag of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = tag[1];
    const name = /name="([^"]+)"/.exec(attrs)?.[1] ?? `sheet${sheets.length + 1}`;
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1] ?? '';
    let target = relMap.get(rid) ?? '';
    target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    if (!target.startsWith('worksheets/')) target = 'worksheets/' + basename(target);
    const xml = zip.get('xl/' + target)?.toString('utf8') ?? '';
    const rows = [];
    for (const rowTag of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellTag of rowTag[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrsCell = cellTag[1];
        const type = /t="([^"]+)"/.exec(attrsCell)?.[1] ?? 'n';
        const ref = /r="([A-Z]+)(\d+)"/.exec(attrsCell)?.[2];
        const col = ref ? columnIndex(/r="([A-Z]+)/.exec(attrsCell)[1]) : cells.length;
        let value = '';
        if (type === 's') {
          const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(cellTag[2])?.[1] ?? -1);
          value = shared[idx] ?? '';
        } else if (type === 'inlineStr') {
          value = decodeXml([...cellTag[2].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
        } else {
          value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(cellTag[2])?.[1] ?? '');
        }
        cells[col] = value;
      }
      if (cells.length) rows.push(Array.from(cells, (v) => (v === undefined ? '' : v)));
    }
    const width = Math.max(0, ...rows.map((r) => r.length));
    sheets.push({
      name,
      rows,
      cols: width,
      header: (rows[0] ?? []).slice(0, 12),
    });
  }
  return sheets;
}

function xlsxDigest(buf, sampleRows) {
  const detail = xlsxRows(buf).map((sheet) => ({
    name: sheet.name,
    rows: sheet.rows.length,
    cols: sheet.cols,
    header: sheet.header,
    sample: sheet.rows.slice(0, sampleRows).map((row) => row.slice(0, 12)),
  }));
  return { kind: 'xlsx', sheets: detail.length, detail };
}

function columnIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ------------------------------------------------------------------ csv / text / html
/** Minimal RFC4180 parser: quotes, escaped quotes, CRLF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvDigest(text, sampleRows) {
  const rows = parseCsv(text);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const header = (rows[0] ?? []).slice(0, 20);
  const columns = header.map((name, index) => {
    let numeric = 0;
    let filled = 0;
    for (const row of rows.slice(1, 501)) {
      const value = row[index] ?? '';
      if (String(value).trim() === '') continue;
      filled += 1;
      if (!Number.isNaN(Number(String(value).replace(/[,\s¥$%]/g, '')))) numeric += 1;
    }
    return { name, type: filled && numeric / filled >= 0.6 ? 'number' : 'text' };
  });
  return {
    kind: 'csv',
    rows: rows.length,
    cols: width,
    header,
    columns,
    sample: rows.slice(0, sampleRows).map((r) => r.slice(0, 12)),
  };
}

function textDigest(text) {
  const lines = text.split(/\r?\n/);
  const markdown = /(^|\n)\s{0,3}(#{1,6})\s+/.test(text);
  const headings = lines
    .map((line) => /^(#{1,6})\s+(.+)$/.exec(line.trim()))
    .filter(Boolean)
    .slice(0, 30)
    .map((m) => ({ level: m[1].length, text: m[2].slice(0, 120) }));
  return {
    kind: markdown ? 'markdown' : 'text',
    chars: text.length,
    words: countWords(text),
    lines: lines.length,
    headings,
    head: text.slice(0, 600),
  };
}

function htmlDigest(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const links = (html.match(/<a\b/gi) ?? []).length;
  const images = (html.match(/<img\b/gi) ?? []).length;
  const text = htmlToText(html);
  return { kind: 'html', title: decodeXml(title), links, images, chars: text.length, words: countWords(text), head: text.slice(0, 600) };
}

function htmlToText(html) {
  return decodeXml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------ handlers
function resolveFile(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new UppError('INVALID_ARGS', 'path must be a non-empty string');
  const path = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info || !info.isFile()) throw new UppError('NOT_FOUND', `file not found: ${path}`);
  return { path, size: info.size };
}

function load(path) {
  const file = resolveFile(path);
  const buf = readFileSync(file.path);
  const ext = extname(file.path).toLowerCase();
  return { buf, ext, path: file.path, bytes: buf.length };
}

const MAX_EXTRACT_CHARS = 48000;

const HANDLERS = {
  digest(args) {
    const sampleRows = Math.min(Math.max(Number(args.sampleRows ?? 5) || 5, 1), 20);
    const { buf, ext, path, bytes } = load(args.path);
    let info;
    if (ext === '.docx') info = docxDigest(buf);
    else if (ext === '.xlsx' || ext === '.xlsm') info = xlsxDigest(buf, sampleRows);
    else if (ext === '.csv') info = csvDigest(buf.toString('utf8'), sampleRows);
    else if (ext === '.html' || ext === '.htm') info = htmlDigest(buf.toString('utf8'));
    else if (['.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.yaml', '.yml'].includes(ext)) info = textDigest(buf.toString('utf8'));
    else throw new UppError('INVALID_ARGS', `unsupported file type: ${ext || '(none)'} (docx/xlsx/csv/md/txt/html)`);
    const data = { path, bytes, ...info };
    delete data.text;
    return { ...data, digestBytes: Buffer.byteLength(JSON.stringify(data)) };
  },

  extract(args) {
    const { buf, ext, path, bytes } = load(args.path);
    const maxChars = Math.min(Math.max(Number(args.maxChars ?? 4000) || 4000, 200), MAX_EXTRACT_CHARS);
    if (ext === '.csv') {
      const rows = parseCsv(buf.toString('utf8'));
      const startRow = Math.min(Math.max(Number(args.startRow ?? 0) || 0, 0), Math.max(rows.length - 1, 0));
      const maxRows = Math.min(Math.max(Number(args.maxRows ?? 20) || 20, 1), 200);
      const slice = rows.slice(startRow, startRow + maxRows);
      return {
        path,
        bytes,
        kind: 'csv',
        totalRows: rows.length,
        startRow,
        rows: slice,
        nextStartRow: startRow + slice.length < rows.length ? startRow + slice.length : null,
      };
    }
    if (ext === '.xlsx' || ext === '.xlsm') {
      const all = xlsxRows(buf);
      const sheet = args.sheet ? all.find((s) => s.name === String(args.sheet)) : all[0];
      if (!sheet) throw new UppError('NOT_FOUND', `sheet not found: ${args.sheet}`);
      const startRow = Math.min(Math.max(Number(args.startRow ?? 0) || 0, 0), Math.max(sheet.rows.length - 1, 0));
      const maxRows = Math.min(Math.max(Number(args.maxRows ?? 20) || 20, 1), 200);
      const rows = sheet.rows.slice(startRow, startRow + maxRows).map((row) => row.slice(0, 20));
      const next = startRow + rows.length;
      return {
        path,
        bytes,
        kind: 'xlsx',
        sheet: sheet.name,
        totalRows: sheet.rows.length,
        startRow,
        rows,
        nextStartRow: next < sheet.rows.length ? next : null,
      };
    }
    let text = '';
    let kind = ext.replace('.', '') || 'text';
    if (ext === '.docx') {
      const d = docxDigest(buf);
      text = d.text;
      kind = 'docx';
    } else if (ext === '.html' || ext === '.htm') {
      text = htmlToText(buf.toString('utf8'));
      kind = 'html';
    } else if (ext === '.md' || ext === '.markdown' || ext === '.txt' || ext === '.log' || ext === '.json' || ext === '.jsonl' || ext === '.yaml' || ext === '.yml') {
      text = buf.toString('utf8');
    } else throw new UppError('INVALID_ARGS', `unsupported file type: ${ext || '(none)'}`);
    const start = Math.min(Math.max(Number(args.start ?? 0) || 0, 0), Math.max(text.length - 1, 0));
    const slice = text.slice(start, start + maxChars);
    return {
      path,
      bytes,
      kind,
      totalChars: text.length,
      start,
      chars: slice.length,
      text: slice,
      nextStart: start + slice.length < text.length ? start + slice.length : null,
    };
  },
};

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
    if (expected === 'number') {
      if (typeof value[key] !== 'number' || Number.isNaN(value[key])) throw new UppError('INVALID_ARGS', `${key} must be a number`);
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

function callTool(name, args) {
  const tool = MANIFEST.tools.find((t) => t.name === name);
  if (!tool) throw new UppError('NOT_FOUND', `unknown tool: ${name}`);
  const clean = validate(tool, args ?? {});
  const started = Date.now();
  const data = HANDLERS[name](clean) ?? {};
  return { ok: true, data, channel: CHANNEL, host: HOST, elapsedMs: Date.now() - started };
}

function errorEnvelope(error) {
  return { ok: false, code: error?.code ?? 'INTERNAL', message: error?.message ?? String(error), channel: CHANNEL, host: HOST, elapsedMs: 0 };
}

function toolList() {
  return MANIFEST.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

function printJSON(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------- CLI mode
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

const argv = process.argv.slice(2);
if (argv[0] === '--info') {
  printJSON({ id: SERVER_NAME, version: SERVER_VERSION, host: HOST, tools: toolList().map((t) => t.name) });
  process.exit(0);
}
if (argv[0] === '--list') {
  printJSON(toolList());
  process.exit(0);
}
if (argv[0] === '--cli') {
  const name = argv[1];
  if (!name) {
    printJSON(errorEnvelope(new UppError('INVALID_ARGS', 'usage: --cli <tool> [--json <object>]')));
    process.exit(2);
  }
  try {
    printJSON({ ...callTool(name, cliArgs(argv.slice(2))), tool: name });
    process.exit(0);
  } catch (error) {
    printJSON(errorEnvelope(error));
    process.exit(error?.code === 'INTERNAL' ? 1 : 2);
  }
}

// ------------------------------------------------------- MCP stdio server
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
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
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'Local document toolkit. Call digest first, then extract bounded windows on demand. Envelope: {ok, data, channel, host, elapsedMs}.',
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
          reply(id, { content: [{ type: 'text', text: JSON.stringify(callTool(name, args)) }], isError: false });
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
        if (isNotification) return;
        replyError(id, -32601, `method not found: ${String(method)}`);
    }
  } catch (error) {
    if (!isNotification) replyError(id, -32603, `internal error: ${error.message}`);
    log('handler error:', error.message);
  }
});

rl.on('close', () => process.exit(0));
log('ready on stdio');
