#!/usr/bin/env node
// log-toolkit regression: log_scan level/timestamp aggregation, log_grep pattern +
// context + tail semantics, log_window bounds, deterministic error codes, the
// ~16 KB answer cap, empty files, and the package's own cost contract.
//
// No test framework: every check prints PASS/FAIL and the process exits non-zero
// when anything fails. Run the fixture generator once if fixtures are missing:
//   python tests/_make_log_fixtures.py
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PKG = join(REPO, 'examples', 'log-toolkit');
const SERVER = join(PKG, 'runtime', 'server.mjs');
const LOG = join(HERE, 'fixtures', 'log');
const ENV = { ...process.env, UPP_HOST: 'test' };

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}`;
  process.stdout.write(detail ? `${line} — ${detail}${NL}` : `${line}${NL}`);
}

/** Last JSON object in a stream (CLI tools print exactly one). */
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

/** Call a tool through the CLI channel, exactly like a host that cannot speak MCP. */
function run(tool, args) {
  const res = spawnSync(process.execPath, [SERVER, '--cli', tool, '--json', JSON.stringify(args)], {
    encoding: 'utf8',
    env: ENV,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, envelope: lastJson(res.stdout) };
}

const sample = join(LOG, 'sample.log');
const empty = join(LOG, 'empty.log');
const longline = join(LOG, 'longline.log');
const big = join(LOG, 'big.log');
const stream = join(LOG, 'stream.log');
const fixturesPresent = [sample, empty, longline, big, stream].every((file) => existsSync(file));
check('fixtures.present', fixturesPresent, fixturesPresent ? '5 log fixtures' : 'run: python tests/_make_log_fixtures.py');
if (!fixturesPresent) {
  process.stdout.write(`${JSON.stringify({ checks: checks.length, passed: 0, failed: checks.length })}${NL}`);
  process.exit(1);
}

// ------------------------------------------------------------------ log_scan
{
  const { status, envelope: e } = run('log_scan', { path: sample });
  const d = e?.data ?? {};
  check('scan.envelope', status === 0 && e?.ok === true && e.channel === 'cli' && e.host === 'test' && Number.isInteger(e.elapsedMs),
    `status=${status} ok=${e?.ok} channel=${e?.channel} host=${e?.host}`);
  check('scan.file', isAbsolute(d.file ?? '') && d.file.endsWith('sample.log'), d.file);
  check('scan.bytes', d.bytes === statSync(sample).size, `bytes=${d.bytes}`);
  check('scan.linesScanned', d.linesScanned === 30, `linesScanned=${d.linesScanned}`);
  const counts = d.levelCounts ?? {};
  const expected = { error: 6, warn: 6, info: 12, debug: 5, other: 1 };
  const levelsOk = Object.keys(expected).every((key) => counts[key] === expected[key]);
  check('scan.levelCounts', levelsOk, JSON.stringify(counts));
  check('scan.levelCounts.sum', Object.values(counts).reduce((a, b) => a + b, 0) === 30, `sum=${Object.values(counts).reduce((a, b) => a + b, 0)}`);
  check('scan.firstTs', d.firstTs === '2026-11-01T10:00:00.000Z', d.firstTs);
  check('scan.lastTs', d.lastTs === '2026-11-01T10:00:29.000Z', d.lastTs);
  const tops = d.topMessages ?? [];
  check('scan.topMessages.limit', tops.length === 10, `topMessages=${tops.length}`);
  const dup = tops[0] ?? {};
  check('scan.topMessages.dedup',
    dup.count === 2 && dup.message === '[ERROR] failed to connect to upstream db timeout after <n> ms',
    JSON.stringify(dup));
  check('scan.topMessages.normalized',
    /<n>/.test(dup.message ?? '') && !/2026|3000/.test(dup.message ?? ''),
    dup.message);
  check('scan.topMessages.hex', tops.some((m) => /<hex>/.test(m.message)), (tops.find((m) => /<hex>/.test(m.message)) ?? {}).message);
}

{
  const tailed = run('log_scan', { path: stream, maxLines: 100 }).envelope?.data ?? {};
  const headed = run('log_scan', { path: stream, maxLines: 100, tail: false }).envelope?.data ?? {};
  check('scan.tail.default',
    tailed.linesScanned === 100 && tailed.levelCounts?.error === 2 && tailed.levelCounts?.info === 98,
    `linesScanned=${tailed.linesScanned} ${JSON.stringify(tailed.levelCounts)}`);
  check('scan.tail.false',
    headed.linesScanned === 100 && headed.levelCounts?.error === 0 && headed.levelCounts?.info === 100,
    `linesScanned=${headed.linesScanned} ${JSON.stringify(headed.levelCounts)}`);
}

{
  const d = run('log_scan', { path: empty }).envelope?.data ?? {};
  const zero = ['error', 'warn', 'info', 'debug', 'other'].every((key) => d.levelCounts?.[key] === 0);
  check('scan.empty', d.bytes === 0 && d.linesScanned === 0 && zero && d.firstTs === null && d.lastTs === null && (d.topMessages ?? []).length === 0,
    `bytes=${d.bytes} linesScanned=${d.linesScanned} firstTs=${d.firstTs} top=${(d.topMessages ?? []).length}`);
}

{
  const res = run('log_scan', { path: join(LOG, 'does-not-exist.log') });
  check('scan.notFound', res.status === 2 && res.envelope?.code === 'NOT_FOUND', `status=${res.status} code=${res.envelope?.code}`);
  const low = run('log_scan', { path: sample, maxLines: 5 });
  check('scan.maxLines.range', low.status === 2 && low.envelope?.code === 'INVALID_ARGS', low.envelope?.message);
  const typed = run('log_scan', { path: sample, maxLines: '500' });
  check('scan.maxLines.type', typed.status === 2 && typed.envelope?.code === 'INVALID_ARGS', typed.envelope?.message);
  const extra = run('log_scan', { path: sample, bogus: 1 });
  check('scan.unknownArg', extra.status === 2 && extra.envelope?.code === 'INVALID_ARGS', extra.envelope?.message);
}

// ------------------------------------------------------------------ log_grep
{
  const d = run('log_grep', { path: sample, pattern: 'upstream' }).envelope?.data ?? {};
  const lines = (d.matches ?? []).map((m) => m.line);
  check('grep.literal', JSON.stringify(lines) === '[9,10,11,14]' && d.truncated === false && d.scannedLines === 30,
    `lines=${JSON.stringify(lines)} truncated=${d.truncated} scanned=${d.scannedLines}`);
}

{
  const d = run('log_grep', { path: sample, pattern: 'timeout after \\d{3,} ms' }).envelope?.data ?? {};
  const lines = (d.matches ?? []).map((m) => m.line);
  check('grep.regex', JSON.stringify(lines) === '[9,11]', `lines=${JSON.stringify(lines)}`);
}

{
  const d = run('log_grep', { path: sample, pattern: 'retrying', contextLines: 1 }).envelope?.data ?? {};
  const ctx = d.matches?.[0]?.context ?? [];
  check('grep.context',
    ctx.length === 3 && /retrying upstream/.test(ctx[1] ?? '') && /upstream db/.test(ctx[0] ?? '') && /upstream db/.test(ctx[2] ?? ''),
    `ctx=${ctx.length}`);
}

{
  const ci = run('log_grep', { path: sample, pattern: 'error' }).envelope?.data ?? {};
  const cs = run('log_grep', { path: sample, pattern: 'error', ignoreCase: false }).envelope?.data ?? {};
  check('grep.ignoreCase.true', ci.matches?.length === 5, `matches=${ci.matches?.length}`);
  check('grep.ignoreCase.false', cs.matches?.length === 0, `matches=${cs.matches?.length}`);
}

{
  const d = run('log_grep', { path: sample, pattern: 'INFO', tail: false, maxMatches: 3 }).envelope?.data ?? {};
  check('grep.maxMatches.truncated', d.matches?.length === 3 && d.truncated === true, `matches=${d.matches?.length} truncated=${d.truncated}`);
  const tailed = run('log_grep', { path: stream, pattern: 'heartbeat lost', maxMatches: 1 }).envelope?.data ?? {};
  const headed = run('log_grep', { path: stream, pattern: 'heartbeat lost', maxMatches: 1, tail: false }).envelope?.data ?? {};
  check('grep.tailNewest', tailed.matches?.[0]?.line === 150, `newest=${tailed.matches?.[0]?.line}`);
  check('grep.headFirst', headed.matches?.[0]?.line === 120, `first=${headed.matches?.[0]?.line}`);
}

{
  const d = run('log_grep', { path: longline, pattern: 'needle' }).envelope?.data ?? {};
  const ctx = d.matches?.[0]?.context ?? [];
  check('grep.lineTruncated', d.matches?.length === 1 && ctx[0]?.length === 2000 && ctx[0].endsWith('…') && !ctx[0].includes('needle'),
    `matches=${d.matches?.length} len=${ctx[0]?.length}`);
}

{
  const d = run('log_grep', { path: big, pattern: 'spam', maxMatches: 200, tail: false }).envelope?.data ?? {};
  const bytes = Buffer.byteLength(JSON.stringify(d));
  check('grep.outputCap', bytes <= 16384 && (d.matches ?? []).length < 60 && d.truncated === true,
    `matches=${d.matches?.length} bytes=${bytes} truncated=${d.truncated}`);
}

{
  const bad = run('log_grep', { path: sample, pattern: '([' });
  check('grep.badRegex', bad.status === 2 && bad.envelope?.code === 'INVALID_ARGS' && /invalid pattern/.test(bad.envelope?.message ?? ''),
    bad.envelope?.message);
  const missing = run('log_grep', { path: sample });
  check('grep.missingPattern', missing.status === 2 && missing.envelope?.code === 'INVALID_ARGS', missing.envelope?.message);
  const ctxRange = run('log_grep', { path: sample, pattern: 'x', contextLines: 9 });
  check('grep.contextLines.range', ctxRange.status === 2 && ctxRange.envelope?.code === 'INVALID_ARGS', ctxRange.envelope?.message);
  const d = run('log_grep', { path: empty, pattern: 'anything' }).envelope?.data ?? {};
  check('grep.empty', (d.matches ?? []).length === 0 && d.scannedLines === 0 && d.truncated === false,
    `matches=${(d.matches ?? []).length} scanned=${d.scannedLines}`);
}

// ---------------------------------------------------------------- log_window
{
  const d = run('log_window', { path: sample, startLine: 10, maxLines: 3 }).envelope?.data ?? {};
  check('window.basic',
    (d.lines ?? []).length === 3 && d.startLine === 10 && d.endLine === 12 && d.totalLines === 30 && /failed to connect/.test(d.lines?.[1] ?? ''),
    `lines=${(d.lines ?? []).length} start=${d.startLine} end=${d.endLine} total=${d.totalLines}`);
}

{
  const d = run('log_window', { path: sample, startLine: 29, maxLines: 50 }).envelope?.data ?? {};
  check('window.clampEnd', (d.lines ?? []).length === 2 && d.endLine === 30 && /shutdown complete/.test(d.lines?.[1] ?? ''),
    `lines=${(d.lines ?? []).length} end=${d.endLine}`);
}

{
  const past = run('log_window', { path: sample, startLine: 31 });
  check('window.pastEnd', past.status === 2 && past.envelope?.code === 'INVALID_ARGS', past.envelope?.message);
  const zero = run('log_window', { path: sample, startLine: 0 });
  check('window.startLine.range', zero.status === 2 && zero.envelope?.code === 'INVALID_ARGS', zero.envelope?.message);
  const many = run('log_window', { path: sample, startLine: 1, maxLines: 201 });
  check('window.maxLines.range', many.status === 2 && many.envelope?.code === 'INVALID_ARGS', many.envelope?.message);
  const blank = run('log_window', { path: empty, startLine: 1 });
  check('window.empty', blank.status === 2 && blank.envelope?.code === 'INVALID_ARGS', blank.envelope?.message);
}

{
  const d = run('log_window', { path: big, startLine: 1, maxLines: 200 }).envelope?.data ?? {};
  const bytes = Buffer.byteLength(JSON.stringify(d));
  check('window.outputCap',
    (d.lines ?? []).length < 60 && d.endLine === (d.lines ?? []).length && d.totalLines === 60 && bytes <= 16384,
    `lines=${(d.lines ?? []).length} end=${d.endLine} total=${d.totalLines} bytes=${bytes}`);
}

// ------------------------------------------------------------- package shape
{
  const source = readFileSync(SERVER, 'utf8');
  const lineCount = source.replace(/\n$/, '').split(NL).length;
  check('spec.server.lineCount', lineCount <= 600, `${lineCount} lines`);
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  check('spec.server.nodeBuiltinsOnly', imports.length > 0 && imports.every((spec) => spec.startsWith('node:')), imports.join(','));
}

{
  const manifest = JSON.parse(readFileSync(join(PKG, 'upp.json'), 'utf8'));
  const shapeOk =
    manifest.id === 'log-toolkit' &&
    manifest.version === '0.1.0' &&
    manifest.capabilities?.includes('tools') &&
    manifest.capabilities?.includes('skills') &&
    manifest.permissions?.network === false &&
    manifest.permissions?.filesystem === 'workspace' &&
    manifest.permissions?.shell === false &&
    ['dsh', 'workbuddy', 'accio'].every((host) => manifest.hosts?.[host]?.serverName === 'log-toolkit');
  check('spec.manifest', shapeOk, JSON.stringify({ id: manifest.id, hosts: Object.keys(manifest.hosts ?? {}), permissions: manifest.permissions }));

  const skill = readFileSync(join(PKG, 'skills', 'log-toolkit', 'SKILL.md'), 'utf8');
  const frontmatter = skill.slice(0, skill.indexOf('\n---', 3));
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? '';
  check('spec.skill.frontmatter',
    /^name:\s*log-toolkit$/m.test(frontmatter) && description.length > 0 && description.length <= 40,
    `name ok, description ${description.length} chars`);

  const tools = JSON.parse(readFileSync(join(PKG, 'runtime', 'tools.json'), 'utf8')).tools ?? [];
  const toolBytes = Buffer.byteLength(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))));
  const skillBytes = Buffer.byteLength(`log-toolkit\n${description}\n`);
  const budget = Number(manifest.tokenBudget?.alwaysLoadedBytes ?? 2048);
  check('spec.tokenBudget', toolBytes + skillBytes <= budget, `${toolBytes + skillBytes}/${budget} B always-loaded`);

  const smoke = JSON.parse(readFileSync(join(PKG, 'smoke.json'), 'utf8'));
  const smokePath = resolve(PKG, smoke.log_scan?.path ?? '');
  check('spec.smoke', Boolean(smoke.log_scan?.path) && existsSync(smokePath) && Number.isInteger(smoke.log_scan?.maxLines),
    `log_scan -> ${smoke.log_scan?.path}`);
}

const failed = checks.filter((c) => !c.ok);
const passed = checks.length - failed.length;
process.stdout.write(`${NL}${JSON.stringify({ package: 'log-toolkit', checks: checks.length, passed, failed: failed.length })}${NL}`);
if (failed.length) {
  process.stdout.write(`FAILED: ${failed.map((c) => c.name).join(', ')}${NL}`);
  process.exitCode = 1;
}
