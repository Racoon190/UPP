#!/usr/bin/env node
// Minimal UPP runtime (MCP stdio + CLI). Fixture only: one tool, no dependencies.
import { createInterface } from 'node:readline';

const SERVER = 'upp-min';
const TOOLS = {
  ping: {
    description: 'Return a small JSON envelope proving the runtime is alive.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: [], additionalProperties: false },
    handler: (input) => ({ ok: true, data: { server: SERVER, note: input.note ?? null, ts: new Date().toISOString() } }),
  },
};
const call = (name, input) => {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: { code: 'NOT_FOUND', message: `unknown tool: ${name}` } };
  return tool.handler(input ?? {});
};
const envelope = (data) => ({ ok: true, data, channel: 'mcp', host: process.env.UPP_HOST ?? 'unknown', elapsedMs: 1 });

if (process.argv.includes('--cli')) {
  const i = process.argv.indexOf('--cli');
  const name = process.argv[i + 1];
  const j = process.argv.indexOf('--json');
  const input = j === -1 ? {} : JSON.parse(process.argv[j + 1]);
  const r = call(name, input);
  console.log(JSON.stringify(r.ok ? { ...r, channel: 'cli', host: process.env.UPP_HOST ?? 'unknown', elapsedMs: 1 } : r));
  process.exit(r.ok ? 0 : 2);
}

const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}
`);
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return send(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: SERVER, version: '0.1.0' } });
  if (msg.method === 'tools/list') return send(msg.id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
  if (msg.method === 'tools/call') {
    const r = call(msg.params?.name, msg.params?.arguments);
    return send(msg.id, { content: [{ type: 'text', text: JSON.stringify(r.ok ? envelope(r.data) : r) }] });
  }
  if (msg.method === 'ping') return send(msg.id, {});
  if (msg.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })}
`);
});
