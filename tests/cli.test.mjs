#!/usr/bin/env node
// CLI shim test: `upp setup-cli --prefix <tmp> --no-path` then the shims must work.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const CLI = join(REPO, 'tools', 'upp.mjs');
const PKG = join(REPO, 'examples', 'hello-upp');
const TMP = mkdtempSync(join(tmpdir(), 'upp-cli-'));

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ?? null });

function lastJson(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().startsWith('{')) {
      try {
        return JSON.parse(lines.slice(i).join('\n'));
      } catch {}
    }
  }
  return null;
}

const setup = spawnSync(process.execPath, [CLI, 'setup-cli', '--prefix', TMP, '--no-path'], { encoding: 'utf8', cwd: REPO });
const report = lastJson(setup.stdout);
add('setup-cli.exit', setup.status === 0, `exit ${setup.status}`);
add('setup-cli.json', Boolean(report?.cli?.dir), report?.cli?.dir);
add('setup-cli.script', existsSync(join(TMP, 'upp.mjs')), join(TMP, 'upp.mjs'));
add('setup-cli.cmd', existsSync(join(TMP, 'upp.cmd')), join(TMP, 'upp.cmd'));
add('setup-cli.sh', existsSync(join(TMP, 'upp')), join(TMP, 'upp'));

const shim = process.platform === 'win32' ? join(TMP, 'upp.cmd') : join(TMP, 'upp');
const shimRun = spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : 'sh',
  process.platform === 'win32' ? ['/d', '/c', shim, 'detect'] : [shim, 'detect'],
  { encoding: 'utf8', cwd: REPO },
);
const detected = lastJson(shimRun.stdout);
add('shim.detect.exit', shimRun.status === 0, `exit ${shimRun.status} ${(shimRun.stderr ?? '').slice(0, 160)}`);
add('shim.detect.json', Boolean(detected?.node), detected?.node);

const direct = spawnSync(process.execPath, [join(TMP, 'upp.mjs'), 'validate', '--pkg', PKG], { encoding: 'utf8', cwd: REPO });
const validated = lastJson(direct.stdout);
add('copied.validate', direct.status === 0 && validated?.failed === 0, `failed=${validated?.failed ?? 'n/a'}`);

rmSync(TMP, { recursive: true, force: true });
const failed = checks.filter((c) => !c.ok).length;
process.stdout.write(`${JSON.stringify({ checks, passed: checks.length - failed, failed }, null, 2)}\n`);
process.exit(failed ? 1 : 0);
