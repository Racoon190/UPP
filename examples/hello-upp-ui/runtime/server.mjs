#!/usr/bin/env node
/**
 * UPP runtime (reference implementation, zero dependencies).
 *
 * Dual mode, one handler table, one result envelope:
 *   - MCP stdio server : node server.mjs
 *   - CLI              : node server.mjs --cli <tool> --json '{...}'
 *   - introspection    : node server.mjs --info | --list
 *
 * `runtime/tools.json` is generated from the package `upp.json` and is the only
 * tool interface every host sees. stdout carries protocol/envelope JSON only;
 * every diagnostic goes to stderr.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(HERE, 'tools.json'), 'utf8'));
const SERVER_NAME = MANIFEST.serverName;
const SERVER_VERSION = MANIFEST.version;
const HOST = process.env.UPP_HOST || 'unknown';
const CHANNEL = process.argv[2] === '--cli' ? 'cli' : 'mcp';

function log(...args) {
  process.stderr.write(`[upp:${SERVER_NAME}] ${args.join(' ')}\n`);
}

/** Business logic. Pure and host-agnostic: no host SDK may ever appear here. */
const HANDLERS = {
  hello(args) {
    const raw = typeof args?.name === 'string' ? args.name.trim() : '';
    return {
      message: `Hello, ${raw || 'world'}!`,
      server: SERVER_NAME,
      version: SERVER_VERSION,
      host: HOST,
      pid: process.pid,
      ts: new Date().toISOString(),
    };
  },
};

class UppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

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
  const code = error?.code ?? 'INTERNAL';
  return { ok: false, code, message: error?.message ?? String(error), channel: CHANNEL, host: HOST, elapsedMs: 0 };
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
      } else {
        out[key] = true;
      }
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
          instructions: 'UPP runtime. Every tool returns one JSON envelope: {ok, data, channel, host, elapsedMs}.',
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
