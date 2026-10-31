#!/usr/bin/env node
// One command that gates a release: spec, build idempotency, MCP+CLI protocol, import, signing, offline bundle.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const UPP = join(REPO, 'tools', 'upp.mjs');
const PKG = join(REPO, 'examples', 'hello-upp');
const TMP = join(HERE, '.tmp-runall');

const node = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const upp = (args) => node(UPP, args);

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

const steps = [];
const step = (name, ok, detail) => steps.push({ step: name, ok: Boolean(ok), detail });

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// 1. spec + build idempotency
const v = lastJson(upp(['validate', '--pkg', PKG]).stdout);
step('validate', v?.failed === 0, `failed=${v?.failed ?? 'n/a'}`);
const b = lastJson(upp(['build', '--pkg', PKG, '--check']).stdout);
step('build-check', Array.isArray(b?.drift) && b.drift.length === 0, `drift=${b?.drift?.length ?? 'n/a'}`);

// 2. MCP + CLI parity
const smoke = node(join(HERE, 'mcp-smoke.mjs'), [PKG]);
const sm = lastJson(smoke.stdout);
step('mcp-smoke', smoke.status === 0 && sm?.failed === 0, `passed=${sm?.passed ?? '?'} failed=${sm?.failed ?? '?'}`);

// 3. import fixtures
const imp = node(join(HERE, 'import.test.mjs'), []);
const impReport = lastJson(imp.stdout);
step('import-fixtures', imp.status === 0 && impReport?.failed === 0, `fixtures=${impReport?.fixtures?.length ?? 0} failed=${impReport?.failed ?? 'n/a'}`);

// 3b. optional LLM polish (offline mock, opt-in)
const polish = node(join(HERE, 'polish.test.mjs'), []);
const polishReport = lastJson(polish.stdout);
step('analyze-polish', polish.status === 0 && polishReport?.failed === 0, `checks=${polishReport?.passed ?? '?'} failed=${polishReport?.failed ?? 'n/a'}`);

// 3c. DSH client-UI generation (static checks; loading needs a restart, see docs/10 §P1.4)
const uiDsh = node(join(HERE, 'ui-dsh.test.mjs'), []);
const uiDshReport = lastJson(uiDsh.stdout);
step('ui-dsh-bundle', uiDsh.status === 0 && uiDshReport?.failed === 0, `checks=${uiDshReport?.passed ?? '?'} failed=${uiDshReport?.failed ?? 'n/a'}`);

// 4. conformance (host-independent part)
const conf = lastJson(upp(['conformance', '--pkg', PKG]).stdout);
step('conformance', conf?.failed === 0, `passed=${conf?.passed ?? '?'} failed=${conf?.failed ?? '?'}`);

// 5. signing + tamper detection
const keys = join(TMP, 'keys');
const kg = lastJson(upp(['keygen', '--out', keys]).stdout);
const keyFile = kg?.key;
const packed = lastJson(upp(['pack', '--pkg', PKG, '--out', join(TMP, 'pack'), '--sign', '--key', keyFile]).stdout);
const pkgFile = packed ? join(TMP, 'pack', `${packed.id}-${packed.version}.upp`) : null;
step('pack-sign', Boolean(packed?.signature?.fingerprint) && existsSync(String(pkgFile)), `fingerprint=${packed?.signature?.fingerprint ?? 'n/a'}`);
const vs = lastJson(upp(['verify-signature', '--from', String(pkgFile), '--require']).stdout);
step('verify-signature', vs?.failed === 0, `failed=${vs?.failed ?? 'n/a'}`);

rmSync(join(TMP, 'tamper'), { recursive: true, force: true });
mkdirSync(join(TMP, 'tamper'), { recursive: true });
const tampered = join(TMP, 'tamper', 't.upp');
copyFileSync(String(pkgFile), tampered);
copyFileSync(`${pkgFile}.sha256`, `${tampered}.sha256`);
copyFileSync(`${pkgFile}.sig.json`, `${tampered}.sig.json`);
const bytes = readFileSync(tampered);
bytes[bytes.length - 30] ^= 0xff;
writeFileSync(tampered, bytes);
const tamperRun = upp(['verify-signature', '--from', tampered]);
const tamperJson = lastJson(tamperRun.stdout);
step('tamper-detected', tamperRun.status === 1 && (tamperJson?.failed ?? 0) > 0, `exit=${tamperRun.status} failed=${tamperJson?.failed ?? 'n/a'}`);

// 6. offline bundle
const offline = lastJson(
  upp(['bundle-offline', '--pkg', PKG, '--out', join(TMP, 'offline'), '--sign', '--key', keyFile, '--zip']).stdout,
);
const offDir = offline?.offline ?? '';
const offOk =
  existsSync(join(offDir, 'OFFLINE-MANIFEST.json')) &&
  existsSync(join(offDir, 'install.cmd')) &&
  existsSync(join(offDir, 'install.sh')) &&
  existsSync(join(offDir, 'tools', 'upp.mjs'));
step('offline-bundle', Boolean(offline?.signature) && offOk, `dir=${offDir || 'n/a'}`);

const failed = steps.filter((s) => !s.ok).length;
process.stdout.write(`${JSON.stringify({ steps, passed: steps.length - failed, failed }, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
