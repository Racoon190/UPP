#!/usr/bin/env node
// sheet-toolkit regression: local xlsx (ZIP+XML) / CSV parsing over the CLI
// channel, the three tool contracts, deterministic error codes, hard output
// caps, MCP/CLI parity and the tokenBudget gate.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NL = String.fromCharCode(10);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PKG = join(REPO, 'examples', 'sheet-toolkit');
const SERVER = join(PKG, 'runtime', 'server.mjs');
const FIX = join(HERE, 'fixtures', 'sheet');
const SAMPLE = join(FIX, 'sample.xlsx');
const LARGE = join(FIX, 'large.csv');
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
const cliRaw = (tool, args) =>
  spawnSync(process.execPath, [SERVER, '--cli', tool, '--json', JSON.stringify(args)], {
    encoding: 'utf8',
    env,
  });
const upp = (args) => spawnSync(process.execPath, [UPP, ...args], { encoding: 'utf8', env });

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const run = (name, tool, args) => {
  const r = cliRaw(tool, args);
  const json = lastJson(r.stdout);
  check(name, r.status === 0 && json?.ok === true, `exit=${r.status} ${json?.ok ? 'ok' : json?.code ?? 'no-json'}`);
  return json?.data ?? null;
};
const fail = (name, tool, args, code) => {
  const r = cliRaw(tool, args);
  const json = lastJson(r.stdout);
  check(name, r.status === 2 && json?.ok === false && json?.code === code, `exit=${r.status} code=${json?.code} want=${code}`);
  return json;
};

// ---------------------------------------------------------------- sheet_profile
const profile = run('profile.ok', 'sheet_profile', { path: SAMPLE, sheet: 'Data' });
check(
  'profile.structure',
  profile?.activeSheet === 'Data' &&
    profile?.rows === 6 &&
    profile?.cols === 3 &&
    JSON.stringify(profile?.sheets) === JSON.stringify(['Data', 'Notes', 'Dated']),
  `active=${profile?.activeSheet} rows=${profile?.rows} cols=${profile?.cols} sheets=${JSON.stringify(profile?.sheets)}`,
);
const col = (data, name) => data?.columns?.find((entry) => entry.name === name);
check(
  'profile.columns',
  col(profile, 'Region')?.type === 'string' &&
    col(profile, 'Region')?.nonEmpty === 5 &&
    col(profile, 'Region')?.duplicates === 2 &&
    col(profile, 'Revenue')?.type === 'number' &&
    col(profile, 'Revenue')?.nonEmpty === 5 &&
    col(profile, 'Revenue')?.duplicates === 1,
  `Region=${JSON.stringify(col(profile, 'Region'))} Revenue=${JSON.stringify(col(profile, 'Revenue'))}`,
);
check(
  'profile.sampleBounded',
  Array.isArray(profile?.sampleRows) && profile.sampleRows.length === 5 && profile.sampleRows[0]?.[0] === 'North',
  `sampleRows=${profile?.sampleRows?.length} first=${profile?.sampleRows?.[0]?.[0]}`,
);
const notes = run('profile.sheetSelect', 'sheet_profile', { path: SAMPLE, sheet: 'Notes' });
check(
  'profile.sheetSelect.shape',
  notes?.activeSheet === 'Notes' && notes?.rows === 2 && notes?.cols === 2,
  `active=${notes?.activeSheet} rows=${notes?.rows} cols=${notes?.cols}`,
);
const dated = run('profile.dateTypes', 'sheet_profile', { path: SAMPLE, sheet: 'Dated' });
check(
  'profile.dateTypes.iso',
  col(dated, 'Day')?.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(dated?.sampleRows?.[0]?.[0] ?? ''),
  `type=${col(dated, 'Day')?.type} first=${dated?.sampleRows?.[0]?.[0]}`,
);
check(
  'profile.sampleRows.cap',
  profile?.sampleRows?.length <= 5 && profile?.truncated === true,
  `rows=${profile?.rows} sample=${profile?.sampleRows?.length} truncated=${profile?.truncated}`,
);

// ---------------------------------------------------------------- sheet_clean
const clean = run('clean.ok', 'sheet_clean', { path: SAMPLE, sheet: 'Data' });
check(
  'clean.counters',
  clean?.before === 6 &&
    clean?.after === 4 &&
    clean?.removedEmpty === 1 &&
    clean?.removedDuplicate === 1 &&
    clean?.trimmedCells === 4,
  `before=${clean?.before} after=${clean?.after} empty=${clean?.removedEmpty} dup=${clean?.removedDuplicate} trimmed=${clean?.trimmedCells}`,
);
const flat = JSON.stringify(clean?.rows ?? []);
check(
  'clean.rowsContent',
  clean?.rows?.length === 4 && flat.includes('"South"') && !flat.includes('" South "') && !flat.includes('["","",""]'),
  `rows=${clean?.rows?.length} rows=${flat.slice(0, 90)}`,
);
check(
  'clean.columnsKept',
  JSON.stringify(clean?.columns) === JSON.stringify(['Region', 'Product', 'Revenue']) && clean?.sheet === 'Data',
  `columns=${JSON.stringify(clean?.columns)} sheet=${clean?.sheet}`,
);
const cleanSmall = run('clean.maxRows', 'sheet_clean', { path: LARGE, maxRows: 3 });
check(
  'clean.maxRows.cut',
  cleanSmall?.rows?.length === 3 && cleanSmall?.truncated === true,
  `rows=${cleanSmall?.rows?.length} truncated=${cleanSmall?.truncated}`,
);
const noTrim = run('clean.trimOff', 'sheet_clean', { path: SAMPLE, sheet: 'Data', trim: false });
check('clean.trimOff.count', noTrim?.trimmedCells === 0 && noTrim?.after === 4, `trimmed=${noTrim?.trimmedCells} after=${noTrim?.after}`);
const noDedupe = run('clean.dedupeOff', 'sheet_clean', { path: SAMPLE, sheet: 'Data', dropDuplicates: false });
check(
  'clean.dedupeOff.count',
  noDedupe?.removedDuplicate === 0 && noDedupe?.after === 5,
  `dup=${noDedupe?.removedDuplicate} after=${noDedupe?.after}`,
);
const noEmpty = run('clean.emptyOff', 'sheet_clean', { path: SAMPLE, sheet: 'Data', dropEmptyRows: false });
check(
  'clean.emptyOff.count',
  noEmpty?.removedEmpty === 0 && noEmpty?.after === 5,
  `empty=${noEmpty?.removedEmpty} after=${noEmpty?.after}`,
);

// -------------------------------------------------------------- sheet_summary
const summary = run('summary.ok', 'sheet_summary', { path: SAMPLE, sheet: 'Data', groupBy: 'Region', values: ['Revenue'] });
check(
  'summary.labels',
  JSON.stringify(summary?.labels) ===
    JSON.stringify(['group', 'Revenue.sum', 'Revenue.avg', 'Revenue.min', 'Revenue.max', 'Revenue.count']),
  `labels=${JSON.stringify(summary?.labels)}`,
);
check(
  'summary.groupsAndOrder',
  summary?.groups === 3 &&
    summary?.rows?.length === 3 &&
    JSON.stringify(summary?.rows?.[0]) === JSON.stringify(['North', 2400, 1200, 1200, 1200, 2]) &&
    JSON.stringify(summary?.rows?.[1]) === JSON.stringify(['South', 1100, 550, 300, 800, 2]) &&
    JSON.stringify(summary?.rows?.[2]) === JSON.stringify(['East', 500, 500, 500, 500, 1]),
  `groups=${summary?.groups} rows=${JSON.stringify(summary?.rows)}`,
);
check(
  'summary.totals',
  summary?.totals?.['Revenue.sum'] === 4000 &&
    summary?.totals?.['Revenue.avg'] === 800 &&
    summary?.totals?.['Revenue.min'] === 300 &&
    summary?.totals?.['Revenue.max'] === 1200 &&
    summary?.totals?.['Revenue.count'] === 5,
  `totals=${JSON.stringify(summary?.totals)}`,
);
const aggSubset = run('summary.aggSubset', 'sheet_summary', {
  path: SAMPLE,
  sheet: 'Data',
  groupBy: 'Region',
  values: ['Revenue'],
  aggs: ['sum', 'count'],
});
check(
  'summary.aggSubset.labels',
  JSON.stringify(aggSubset?.labels) === JSON.stringify(['group', 'Revenue.sum', 'Revenue.count']) &&
    JSON.stringify(aggSubset?.rows?.[0]) === JSON.stringify(['North', 2400, 2]),
  `labels=${JSON.stringify(aggSubset?.labels)} row0=${JSON.stringify(aggSubset?.rows?.[0])}`,
);
const topN = run('summary.topN', 'sheet_summary', {
  path: SAMPLE,
  sheet: 'Data',
  groupBy: 'Product',
  values: ['Revenue'],
  aggs: ['sum'],
  topN: 2,
});
check(
  'summary.topN.cut',
  topN?.rows?.length === 2 && topN?.groups === 3 && topN?.truncated === true && topN?.rows?.[0]?.[0] === 'Widget',
  `rows=${topN?.rows?.length} groups=${topN?.groups} truncated=${topN?.truncated}`,
);
const twoValues = run('summary.multiValues', 'sheet_summary', {
  path: SAMPLE,
  sheet: 'Data',
  groupBy: 'Region',
  values: ['Revenue', 'Revenue'],
  aggs: ['min'],
});
check(
  'summary.multiValues.labels',
  twoValues?.labels?.length === 3 && twoValues?.rows?.[0]?.length === 3,
  `labels=${JSON.stringify(twoValues?.labels)} row0=${JSON.stringify(twoValues?.rows?.[0])}`,
);

// -------------------------------------------------------------------- errors
fail('error.missingPath', 'sheet_profile', {}, 'INVALID_ARGS');
fail('error.sampleRowsRange', 'sheet_profile', { path: SAMPLE, sampleRows: 0 }, 'INVALID_ARGS');
fail('error.unknownArg', 'sheet_profile', { path: SAMPLE, sampleRows: 2, bogus: 1 }, 'INVALID_ARGS');
fail('error.cleanMaxRowsRange', 'sheet_clean', { path: SAMPLE, maxRows: 500 }, 'INVALID_ARGS');
fail('error.summaryTopNRange', 'sheet_summary', { path: SAMPLE, groupBy: 'Region', values: ['Revenue'], topN: 0 }, 'INVALID_ARGS');
fail('error.badAgg', 'sheet_summary', { path: SAMPLE, groupBy: 'Region', values: ['Revenue'], aggs: ['median'] }, 'INVALID_ARGS');
fail('error.notFoundFile', 'sheet_profile', { path: join(FIX, 'no-such-file.xlsx') }, 'NOT_FOUND');
fail('error.notFoundSheet', 'sheet_profile', { path: SAMPLE, sheet: 'Nope' }, 'NOT_FOUND');
fail('error.notFoundColumn', 'sheet_summary', { path: SAMPLE, groupBy: 'Nope', values: ['Revenue'] }, 'NOT_FOUND');
fail('error.notFoundValueColumn', 'sheet_summary', { path: SAMPLE, groupBy: 'Region', values: ['Nope'] }, 'NOT_FOUND');
const badType = cliRaw('sheet_profile', { path: UPP });
const badTypeJson = lastJson(badType.stdout);
check(
  'error.unsupportedExtension',
  badType.status === 2 && badTypeJson?.code === 'INVALID_ARGS',
  `exit=${badType.status} code=${badTypeJson?.code}`,
);

// -------------------------------------------------------------- output caps
const bigProfile = run('caps.large.profile', 'sheet_profile', { path: LARGE, sampleRows: 2 });
check(
  'caps.large.profile.shape',
  bigProfile?.rows === 150 && bigProfile?.cols === 6 && col(bigProfile, 'date')?.type === 'date',
  `rows=${bigProfile?.rows} cols=${bigProfile?.cols} date=${col(bigProfile, 'date')?.type}`,
);
const longestCell = Math.max(...(bigProfile?.sampleRows ?? []).flat().map((value) => String(value).length));
check(
  'caps.large.cellClip',
  longestCell <= 80 && bigProfile.sampleRows.flat().some((value) => String(value).endsWith('…')),
  `longestCell=${longestCell}`,
);
const bigCleanRaw = cliRaw('sheet_clean', { path: LARGE, maxRows: 200 });
const bigClean = lastJson(bigCleanRaw.stdout);
check(
  'caps.large.clean.bytes',
  bigClean?.ok === true &&
    bigClean?.data?.rows?.length < 150 &&
    bigClean?.data?.rows?.length > 0 &&
    bigClean?.data?.truncated === true &&
    Buffer.byteLength(bigCleanRaw.stdout) < 12288,
  `rows=${bigClean?.data?.rows?.length} bytes=${Buffer.byteLength(bigCleanRaw.stdout)} truncated=${bigClean?.data?.truncated}`,
);
const bigSummary = run('caps.large.summary', 'sheet_summary', { path: LARGE, groupBy: 'region', values: ['units', 'id'], aggs: ['sum', 'count'], topN: 10 });
check(
  'caps.large.summary.topN',
  bigSummary?.rows?.length === 10 &&
    bigSummary?.groups === 12 &&
    bigSummary?.truncated === true &&
    bigSummary?.labels?.length === 5,
  `rows=${bigSummary?.rows?.length} groups=${bigSummary?.groups} labels=${bigSummary?.labels?.length}`,
);

// ------------------------------------------------------- MCP vs CLI parity
const mcpCall = (() => {
  const child = spawnSync(process.execPath, [SERVER], {
    encoding: 'utf8',
    env,
    input:
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) +
      NL +
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
      NL +
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'sheet_summary', arguments: { path: SAMPLE, sheet: 'Data', groupBy: 'Region', values: ['Revenue'] } },
      }) +
      NL,
  });
  const replies = String(child.stdout ?? '')
    .split(NL)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const init = replies.find((entry) => entry.id === 1);
  const call = replies.find((entry) => entry.id === 2);
  const envelope = call?.result ? JSON.parse(call.result.content[0].text) : null;
  return { init, envelope, child };
})();
check(
  'mcp.initialize',
  mcpCall.init?.result?.serverInfo?.name === 'sheet-toolkit' && mcpCall.init?.result?.protocolVersion,
  `server=${mcpCall.init?.result?.serverInfo?.name} version=${mcpCall.init?.result?.serverInfo?.version}`,
);
check(
  'mcp.callParity',
  mcpCall.envelope?.channel === 'mcp' &&
    mcpCall.envelope?.host === 'test' &&
    JSON.stringify(mcpCall.envelope?.data?.rows) === JSON.stringify(summary?.rows) &&
    JSON.stringify(mcpCall.envelope?.data?.totals) === JSON.stringify(summary?.totals),
  `channel=${mcpCall.envelope?.channel} host=${mcpCall.envelope?.host}`,
);

// ------------------------------------------------------- spec: tokenBudget gate
const manifest = JSON.parse(readFileSync(join(PKG, 'runtime', 'tools.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(PKG, 'upp.json'), 'utf8'));
const skillText = readFileSync(join(PKG, 'skills', 'sheet-toolkit', 'SKILL.md'), 'utf8');
const front = /^---([\s\S]*?)---/.exec(skillText)?.[1] ?? '';
const alwaysBytes = Buffer.byteLength(
  JSON.stringify(manifest.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))),
);
check(
  'spec.serverName',
  manifest.serverName === 'sheet-toolkit' &&
    pkg.hosts?.dsh?.serverName === 'sheet-toolkit' &&
    pkg.hosts?.workbuddy?.serverName === 'sheet-toolkit' &&
    pkg.hosts?.accio?.serverName === 'sheet-toolkit',
  `manifest=${manifest.serverName} hosts=${Object.values(pkg.hosts ?? {}).map((host) => host.serverName).join(',')}`,
);
check(
  'spec.skillFrontmatter',
  /\bname:\s*sheet-toolkit/.test(front) && /\bdescription:\s*\S/.test(front),
  `frontmatter=${front.replace(/\s+/g, ' ').trim().slice(0, 80)}`,
);
check(
  'spec.toolCount',
  manifest.tools?.length === 3 &&
    JSON.stringify(manifest.tools.map((tool) => tool.name)) ===
      JSON.stringify(['sheet_profile', 'sheet_clean', 'sheet_summary']),
  `tools=${JSON.stringify(manifest.tools?.map((tool) => tool.name))}`,
);
check(
  'spec.tokenBudget',
  alwaysBytes <= (pkg.tokenBudget?.alwaysLoadedBytes ?? 2048),
  `always=${alwaysBytes}B budget=${pkg.tokenBudget?.alwaysLoadedBytes}B`,
);
const validated = lastJson(upp(['validate', '--pkg', PKG]).stdout);
check('spec.validate', validated?.failed === 0, `failed=${validated?.failed ?? 'n/a'} checks=${validated?.checks?.length ?? '?'}`);

// ------------------------------------------------------------------- report
const failedCount = checks.filter((entry) => !entry.ok).length;
for (const entry of checks) {
  process.stdout.write(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}${entry.ok ? '' : `  (${entry.detail})`}${NL}`);
}
process.stdout.write(
  `${NL}${JSON.stringify({ checks: checks.length, passed: checks.length - failedCount, failed: failedCount }, null, 2)}${NL}`,
);
process.exitCode = failedCount ? 1 : 0;
