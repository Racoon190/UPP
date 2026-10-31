#!/usr/bin/env node
// doc-toolkit regression: local document parsing (docx/xlsx/csv/html) over the CLI channel,
// windowed extraction, deterministic error codes, and the tokenBudget gate.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PKG = join(REPO, 'examples', 'doc-toolkit');
const SERVER = join(PKG, 'runtime', 'server.mjs');
const DOC = join(HERE, 'fixtures', 'doc');
const UPP = join(REPO, 'tools', 'upp.mjs');

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

const env = { ...process.env, UPP_HOST: 'test' };
const cli = (tool, args) =>
  spawnSync(process.execPath, [SERVER, '--cli', tool, '--json', JSON.stringify(args)], {
    encoding: 'utf8',
    env,
  });
const upp = (args) => spawnSync(process.execPath, [UPP, ...args], { encoding: 'utf8', env });

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const run = (name, tool, args) => {
  const r = cli(tool, args);
  const json = lastJson(r.stdout);
  check(name, r.status === 0 && json?.ok === true, `exit=${r.status} ${json?.ok ? 'ok' : json?.error?.code ?? 'no-json'}`);
  return json?.data ?? null;
};

// ---- digest: every supported format
const docx = run('docx.digest', 'digest', { path: join(DOC, 'sample.docx') });
check('docx.structure', docx?.kind === 'docx' && docx?.paragraphs === 16 && docx?.headings === 3, `paragraphs=${docx?.paragraphs} headings=${docx?.headings}`);
check('docx.outline', Array.isArray(docx?.outline) && docx.outline[0]?.text === 'UPP 文档工具测试', `first=${docx?.outline?.[0]?.text ?? 'n/a'}`);
check('docx.digestBytes', docx?.digestBytes > 0 && docx.digestBytes < 4096, `digestBytes=${docx?.digestBytes}`);

const xlsx = run('xlsx.digest', 'digest', { path: join(DOC, 'sample.xlsx'), sampleRows: 2 });
const sales = xlsx?.detail?.find((s) => s.name === 'Sales');
check('xlsx.structure', xlsx?.kind === 'xlsx' && xlsx?.sheets === 2 && sales?.rows === 11 && sales?.cols === 5, `sheets=${xlsx?.sheets} rows=${sales?.rows} cols=${sales?.cols}`);
check('xlsx.header', sales?.header?.[0] === 'Date' && sales?.sample?.length === 2, `header=${sales?.header?.[0]} sample=${sales?.sample?.length}`);

const csv = run('csv.digest', 'digest', { path: join(DOC, 'sample.csv') });
check('csv.structure', csv?.kind === 'csv' && csv?.rows === 6 && csv?.cols === 4, `rows=${csv?.rows} cols=${csv?.cols}`);
check('csv.types', csv?.columns?.find((c) => c.name === 'score')?.type === 'number', `score=${csv?.columns?.find((c) => c.name === 'score')?.type ?? 'n/a'}`);

const html = run('html.digest', 'digest', { path: join(DOC, 'sample.html') });
check('html.structure', html?.kind === 'html' && html?.title === 'Sample Scraped Page' && html?.links === 2 && html?.images === 1, `title=${html?.title} links=${html?.links} images=${html?.images}`);

// ---- windowed extraction (only the requested slice is returned)
const win1 = run('docx.extract.window', 'extract', { path: join(DOC, 'sample.docx'), start: 60, maxChars: 400 });
check('docx.window.trimmed', win1?.start === 60 && win1?.chars === 136 && win1?.nextStart === null, `start=${win1?.start} chars=${win1?.chars} next=${win1?.nextStart}`);
const win2 = run('docx.extract.next', 'extract', { path: join(DOC, 'sample.docx'), start: 0, maxChars: 200 });
check('docx.window.remainder', win2?.chars === 196 && win2?.nextStart === null && win2?.totalChars === 196, `chars=${win2?.chars} next=${win2?.nextStart} total=${win2?.totalChars}`);

const xr = run('xlsx.extract.rows', 'extract', { path: join(DOC, 'sample.xlsx'), startRow: 1, maxRows: 2 });
check('xlsx.rowWindow', xr?.rows?.length === 2 && xr?.nextStartRow === 3 && xr?.totalRows === 11 && xr?.rows?.[0]?.[0] === '2026-01-05', `rows=${xr?.rows?.length} next=${xr?.nextStartRow} first=${xr?.rows?.[0]?.[0]}`);
const xr2 = run('xlsx.extract.sheet', 'extract', { path: join(DOC, 'sample.xlsx'), sheet: 'Notes' });
check('xlsx.sheetSelect', xr2?.sheet === 'Notes' && xr2?.totalRows === 2, `sheet=${xr2?.sheet} total=${xr2?.totalRows}`);

const cr = run('csv.extract.rows', 'extract', { path: join(DOC, 'sample.csv'), startRow: 2, maxRows: 2 });
check('csv.rowWindow', cr?.rows?.length === 2 && cr?.nextStartRow === 4, `rows=${cr?.rows?.length} next=${cr?.nextStartRow}`);

// ---- deterministic errors through the same envelope
const missing = cli('digest', { path: join(DOC, 'no-such-file.docx') });
const missingJson = lastJson(missing.stdout);
check('error.notFound', missing.status === 2 && missingJson?.code === 'NOT_FOUND', `exit=${missing.status} code=${missingJson?.code}`);
const wrongType = cli('digest', { path: UPP });
const wrongJson = lastJson(wrongType.stdout);
check('error.invalidType', wrongType.status === 2 && wrongJson?.code === 'INVALID_ARGS', `exit=${wrongType.status} code=${wrongJson?.code}`);

// ---- spec gate: tokenBudget + plugin validates cleanly
const validated = lastJson(upp(['validate', '--pkg', PKG]).stdout);
check('spec.validate', validated?.failed === 0, `failed=${validated?.failed ?? 'n/a'} checks=${validated?.checks?.length ?? '?'}`);

// ---- local-first accounting: the digest is tiny compared with the source file
const rawBytes = readFileSync(join(DOC, 'sample.xlsx')).length;
check('savings.digestSmall', Number(xlsx?.digestBytes) > 0 && Number(xlsx?.digestBytes) * 4 < rawBytes, `digest=${xlsx?.digestBytes}B raw=${rawBytes}B`);

const failed = checks.filter((c) => !c.ok).length;
process.stdout.write(`${JSON.stringify({ checks, passed: checks.length - failed, failed }, null, 2)}${NL}`);
process.exitCode = failed ? 1 : 0;
