#!/usr/bin/env node
// CLI shim test: `upp setup-cli --prefix <tmp> --no-path` then the shims must work.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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


// self-update: bump -> upgrade, then refuse downgrade, then same-version is a no-op
const repoUpp = join(REPO, 'tools', 'upp.mjs');
const bumped = join(TMP, 'next-upp.mjs');
writeFileSync(bumped, readFileSync(repoUpp, 'utf8').replace(/const VERSION = '[^']+';/, "const VERSION = '9.9.9';"));
const up = spawnSync(process.execPath, [join(TMP, 'upp.mjs'), 'self-update', '--prefix', TMP, '--from', bumped], { encoding: 'utf8', cwd: REPO });
const upReport = lastJson(up.stdout);
add('self-update.exit', up.status === 0, `exit ${up.status} ${(up.stderr ?? '').slice(0, 120)}`);
add('self-update.version', upReport?.selfUpdate?.toVersion === '9.9.9', upReport?.selfUpdate?.toVersion);
add('self-update.backup', Boolean(upReport?.selfUpdate?.backup) && existsSync(upReport.selfUpdate.backup), upReport?.selfUpdate?.backup);

const verRun = spawnSync(process.execPath, [join(TMP, 'upp.mjs'), '--version'], { encoding: 'utf8', cwd: REPO });
add('self-update.cli-version', lastJson(verRun.stdout)?.toolchain === '9.9.9', lastJson(verRun.stdout)?.toolchain ?? verRun.stdout.slice(0, 120));

const down = spawnSync(process.execPath, [join(TMP, 'upp.mjs'), 'self-update', '--prefix', TMP, '--from', repoUpp], { encoding: 'utf8', cwd: REPO });
add('self-update.downgrade-refused', down.status === 1 && lastJson(down.stdout)?.error === 'E_DOWNGRADE', lastJson(down.stdout)?.error ?? `exit ${down.status}`);

const same = spawnSync(process.execPath, [join(TMP, 'upp.mjs'), 'self-update', '--prefix', TMP, '--from', bumped], { encoding: 'utf8', cwd: REPO });
add('self-update.up-to-date', same.status === 0 && lastJson(same.stdout)?.selfUpdate?.upToDate === true, lastJson(same.stdout)?.selfUpdate?.upToDate);

rmSync(TMP, { recursive: true, force: true });
const failed = checks.filter((c) => !c.ok).length;
process.stdout.write(`${JSON.stringify({ checks, passed: checks.length - failed, failed }, null, 2)}\n`);
process.exit(failed ? 1 : 0);
