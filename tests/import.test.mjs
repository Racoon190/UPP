#!/usr/bin/env node
// Import regression: every fixture must import -> validate -> build -> smoke, with zero manual steps.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const FIXTURES = join(REPO, 'fixtures');
const TMP = join(HERE, '.tmp-import');
const UPP = join(REPO, 'tools', 'upp.mjs');
const run = (args) => spawnSync(process.execPath, [UPP, ...args], { encoding: 'utf8' });

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

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const isFixture = (name) =>
  existsSync(join(FIXTURES, name, 'upp.json')) ||
  existsSync(join(FIXTURES, name, '.claude-plugin')) ||
  existsSync(join(FIXTURES, name, '.codebuddy-plugin')) ||
  existsSync(join(FIXTURES, name, 'plugin.json'));
const names = readdirSync(FIXTURES).filter(isFixture);

const report = { fixtures: [], failed: 0 };
const check = (fixture, ok, detail) => {
  report.fixtures.push({ fixture, check: ok ? 'ok' : 'FAIL', detail });
  if (!ok) report.failed += 1;
};

for (const name of names) {
  const out = join(TMP, name);

  const imported = run(['import', join(FIXTURES, name), '--out', out]);
  const info = lastJson(imported.stdout);
  check(name, imported.status === 0 && Boolean(info?.imported), `import exit=${imported.status} kind=${info?.imported?.kind ?? 'n/a'}`);

  const validated = lastJson(run(['validate', '--pkg', out]).stdout);
  check(name, validated?.failed === 0, `validate failed=${validated?.failed ?? 'n/a'}`);

  const built = lastJson(run(['build', '--pkg', out]).stdout);
  check(name, Array.isArray(built?.files) && built.files.length > 0, `build files=${built?.files?.length ?? 'n/a'}`);

  const smoke = spawnSync(process.execPath, [join(HERE, 'mcp-smoke.mjs'), out], { encoding: 'utf8' });
  const smokeReport = lastJson(smoke.stdout);
  check(name, smoke.status === 0 && smokeReport?.failed === 0, `smoke passed=${smokeReport?.passed ?? '?'} failed=${smokeReport?.failed ?? '?'}`);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.failed ? 1 : 0;
