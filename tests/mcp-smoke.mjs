#!/usr/bin/env node
/**
 * Host-independent conformance smoke test for any UPP package.
 *
 * Proves the contract that makes a plugin portable: the same tool interface is
 * served over MCP and CLI, and both channels return the *same* envelope data.
 *
 *   node tests/mcp-smoke.mjs examples/hello-upp
 *
 * Exit 0 only when every check passes. Zero dependencies.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const pkgDir = resolve(args[args.indexOf('--pkg') + 1] ?? args.find((a) => !a.startsWith('-')) ?? 'examples/hello-upp');
const manifestPath = join(pkgDir, 'runtime', 'tools.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const entry = join(pkgDir, 'runtime', 'server.mjs');
// Optional package-level smoke arguments (host-neutral extra file, never part of the tool schema).
// Values that are relative paths are resolved against the package dir, so fixtures can live in the repo.
const smokePath = join(pkgDir, 'smoke.json');
const smokeArgs = existsSync(smokePath) ? JSON.parse(readFileSync(smokePath, 'utf8')) : {};
const checks = [];
const stderr = [];
const VOLATILE = new Set(['pid', 'ts', 'elapsedMs']);

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function sampleArgs(tool) {
  const out = {};
  const props = tool?.inputSchema?.properties ?? {};
  for (const [key, spec] of Object.entries(props)) {
    const type = spec?.type;
    if (type === 'string') out[key] = Array.isArray(spec.enum) ? spec.enum[0] : 'smoke';
    else if (type === 'number' || type === 'integer') out[key] = 1;
    else if (type === 'boolean') out[key] = true;
    else if (type === 'array') out[key] = [];
  }
  return out;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

function runMcp(tool, args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, UPP_HOST: 'smoke' },
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending = new Map();
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
        child.kill();
      } catch {}
      resolveRun(payload);
    };
    const timer = setTimeout(() => {
      record('mcp.handshake', false, 'no complete handshake within 8000ms');
      finish(null);
    }, 8000);

    child.stderr.on('data', (buf) => stderr.push(String(buf)));
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    });

    const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
    const request = (id, method, params) =>
      new Promise((resolveReq) => {
        pending.set(id, resolveReq);
        send({ jsonrpc: '2.0', id, method, params });
      });

    (async () => {
      const init = await request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'upp-smoke', version: '1.0.0' },
      });
      record(
        'mcp.initialize',
        init?.result?.serverInfo?.name === (manifest?.serverName ?? manifest?.hosts?.dsh?.serverName),
        `expect ${manifest?.serverName ?? manifest?.hosts?.dsh?.serverName}, got ${init?.result?.serverInfo?.name}`,
      );
      record('mcp.capabilities', init?.result?.capabilities?.tools !== undefined, 'tools capability');
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      const list = await request(2, 'tools/list', {});
      const names = (list?.result?.tools ?? []).map((t) => t.name);
      const expected = (manifest?.tools ?? []).map((t) => t.name);
      record('mcp.tools.list', JSON.stringify(names) === JSON.stringify(expected), `want ${expected}, got ${names}`);
      record(
        'mcp.tools.schema',
        (list?.result?.tools ?? []).every((t) => t?.inputSchema?.type === 'object'),
        'every tool has an object inputSchema',
      );

      const call = await request(3, 'tools/call', { name: tool.name, arguments: args });
      const envelope = JSON.parse(call?.result?.content?.[0]?.text ?? 'null');
      record('mcp.tools.call', envelope?.ok === true && envelope?.channel === 'mcp', JSON.stringify(envelope)?.slice(0, 200));
      finish(envelope);
    })().catch((error) => {
      record('mcp.unexpected', false, String(error?.message ?? error));
      finish(null);
    });
  });
}

function runCli(tool, args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [entry, '--cli', tool.name, '--json', JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, UPP_HOST: 'smoke' },
    });
    let out = '';
    child.stdout.on('data', (buf) => (out += String(buf)));
    child.on('close', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = null;
      }
      record('cli.call', parsed?.ok === true && parsed?.channel === 'cli', out.trim().slice(0, 200));
      resolveRun(parsed);
    });
  });
}

if (!manifest) {
  record('manifest.load', false, `missing ${manifestPath} (run: node tools/upp.mjs build --pkg ${pkgDir})`);
} else if (!existsSync(entry)) {
  record('runtime.entry', false, `missing ${entry}`);
} else {
  const tool = manifest.tools[0];
  const overrides = smokeArgs[tool.name] ?? smokeArgs['*'] ?? {};
  const args = { ...sampleArgs(tool), ...overrides };
  for (const key of Object.keys(args)) {
    const value = args[key];
    if (typeof value === 'string' && (value.startsWith('./') || value.startsWith('../'))) {
      args[key] = resolve(pkgDir, value);
    }
  }
  const mcpEnvelope = await runMcp(tool, args);
  const cliEnvelope = await runCli(tool, args);
  record(
    'parity.mcp_vs_cli',
    JSON.stringify(stable(mcpEnvelope?.data)) === JSON.stringify(stable(cliEnvelope?.data)),
    'same data through MCP and CLI',
  );
}

const failed = checks.filter((c) => !c.ok);
const report = {
  package: pkgDir,
  entry,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
  stderrTail: stderr.join('').split('\n').slice(-5).filter(Boolean),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
