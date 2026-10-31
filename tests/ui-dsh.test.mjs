#!/usr/bin/env node
// DSH client-UI generation test: a UI bundle must be a classic-script client + empty host half.
// Static checks only (loading a new client bundle requires a DSH restart; see docs/10 §P1.4).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const UPP = join(REPO, 'tools', 'upp.mjs');
const PKG = join(REPO, 'examples', 'hello-upp-ui');

function lastJson(text) {
  const lines = String(text ?? '').split(NL);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().startsWith('{')) {
      try {
        return JSON.parse(lines.slice(i).join(NL));
      } catch {}
    }
  }
  return null;
}
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const v = lastJson(run(UPP, ['validate', '--pkg', PKG]).stdout);
check('validate', v?.failed === 0, `failed=${v?.failed ?? 'n/a'}`);
const b = lastJson(run(UPP, ['build', '--pkg', PKG]).stdout);
check('build', Boolean(b) && Array.isArray(b.files), `files=${b?.files?.length ?? 'n/a'}`);

const pkgJson = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
check('manifest.dsh.client', pkgJson?.dsh?.client?.platform === 'web', JSON.stringify(pkgJson?.dsh?.client ?? null));
check('manifest.exports.client', pkgJson?.exports?.['./client'] === './client.js', String(pkgJson?.exports?.['./client']));
check('manifest.exports.host', pkgJson?.exports?.['.'] === './index.js', String(pkgJson?.exports?.['.']));

const client = existsSync(join(PKG, 'client.js')) ? readFileSync(join(PKG, 'client.js'), 'utf8') : '';
const firstCode = client.split(NL).map((l) => l.trim()).find((l) => l && !l.startsWith('//')) ?? '';
check('client.iife', firstCode.startsWith('window.__ModuleLoader__.load('), firstCode.slice(0, 40));
check('client.no-esm', !/^\s*(import|export)\s/m.test(client), 'classic script only');
check('client.slot', client.includes("inject('conversation.input.dock'"), 'registers above the composer card');
check('client.card', client.includes("'data-upp-panel'") && client.includes('flexDirection'), 'renders a card body');

const host = existsSync(join(PKG, 'index.js')) ? readFileSync(join(PKG, 'index.js'), 'utf8') : '';
check('host.apply', /export\s+function\s+apply\s*\(\s*\)\s*\{\s*\}/.test(host), 'empty host half');

const patch = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8');
check('patch.self-row', patch.includes(`name: '${pkgJson.name}'`), 'bundle row for UI scanning');
check('patch.mcp-row', patch.includes('@deepseek-ai/dsh-mcp-client') && patch.includes('upp-hello-ui'), 'MCP row preserved');

const syn = spawnSync(process.execPath, ['--check', join(PKG, 'client.js')], { encoding: 'utf8' });
check('client.node-check', syn.status === 0, (syn.stderr || '').trim().slice(0, 120));
const synHost = spawnSync(process.execPath, ['--check', join(PKG, 'index.js')], { encoding: 'utf8' });
check('host.node-check', synHost.status === 0, (synHost.stderr || '').trim().slice(0, 120));

const failed = checks.filter((x) => !x.ok).length;
process.stdout.write(`${JSON.stringify({ checks, passed: checks.length - failed, failed }, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
