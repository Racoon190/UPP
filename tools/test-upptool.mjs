#!/usr/bin/env node
/**
 * upptool acceptance suite — drives the real CLI through a fake HOME.
 *
 * Everything (registry, runs log, fixtures, exported bundles) lives under
 * os.tmpdir(); USERPROFILE/HOME/UPPTOOL_HOME and every host root are redirected
 * there, so the real ~/.upptool (and the real hosts) are never read or written.
 *
 *   node tools/test-upptool.mjs
 *
 * Prints PASS/FAIL/SKIP lines and a summary; exits 1 when anything FAILed.
 * If tools/upptool.mjs has not been written yet the suite SKIPs instead of
 * exploding (the CLI lands in parallel with this test).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLI = path.join(ROOT, 'tools', 'upptool.mjs')
const CHILD_TIMEOUT_MS = 120_000
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'upptool-selftest-'))

const HOME1 = path.join(TMP, 'home-1')
const HOME2 = path.join(TMP, 'home-2')
const UPPTOOL1 = path.join(HOME1, '.upptool')
const UPPTOOL2 = path.join(HOME2, '.upptool')
const FIX = path.join(TMP, 'fixtures')

let passed = 0
let failed = 0
let skipped = 0
const startedAt = Date.now()

// ---------------------------------------------------------------- tiny runner
function pass(label) {
  passed += 1
  process.stdout.write(`PASS ${label}\n`)
}
function fail(label, detail) {
  failed += 1
  const lines = String(detail ?? '').split(/\r?\n/)
  const shown = lines.slice(0, 14).join('\n     ')
  process.stdout.write(`FAIL ${label}${lines.length ? `\n     ${shown}\n` : '\n'}`)
}
function skip(label, why) {
  skipped += 1
  process.stdout.write(`SKIP ${label}${why ? ` (${why})` : ''}\n`)
}
async function check(label, fn) {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err && err.stack ? err.message : String(err))
  }
}

// ------------------------------------------------------------------- helpers
function truncate(text, max = 1600) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s
}

function envFor(home, extra = {}) {
  const h = path.resolve(home)
  return {
    ...process.env,
    USERPROFILE: h,
    HOME: h,
    HOMEDRIVE: path.parse(h).root.replace(/[\\/]+$/, ''),
    HOMEPATH: h.slice(path.parse(h).root.length - (h.endsWith(path.sep) ? 1 : 0)),
    DSH_HOME: path.join(h, '.dsh'),
    UPPENV_HOME: path.join(h, '.uppenv'),
    UPPTOOL_HOME: path.join(h, '.upptool'),
    UPPMEM_HOME: path.join(h, '.uppmem'),
    WORKBUDDY_HOME: path.join(h, '.workbuddy'),
    CODEBUDDY_HOME: path.join(h, '.codebuddy'),
    ACCIO_HOME: path.join(h, '.accio'),
    NO_COLOR: '1',
    ...extra,
  }
}

function cli(args, { home = HOME1, extraEnv = {}, cwd = TMP } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: envFor(home, extraEnv),
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  return {
    code: res.status,
    signal: res.signal,
    error: res.error,
    stdout,
    stderr,
    out: `${stdout}${stderr}`,
  }
}

function parseJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    /* tolerate a stray log line before the JSON payload */
  }
  const lines = raw.split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i])
    } catch {
      /* keep looking */
    }
  }
  return null
}

function jsonCli(args, opts) {
  const res = cli([...args, '--json'], opts)
  res.json = parseJson(res.stdout)
  return res
}

function runTool(id, args = [], opts = {}) {
  // --json must precede the `--` separator per the frozen CLI grammar.
  const res = cli(['run', id, '--json', '--', ...args], opts)
  res.json = parseJson(res.stdout)
  return res
}

function expectCode(res, want, label) {
  const codes = Array.isArray(want) ? want : [want]
  if (!codes.includes(res.code)) {
    throw new Error(
      `${label}: expected exit ${codes.join('|')}, got ${res.code}` +
        `${res.error ? ` (${res.error.message})` : ''}\noutput:\n${truncate(res.out)}`,
    )
  }
  return res
}

function expectJson(res, label) {
  if (res.json == null) throw new Error(`${label}: stdout is not JSON\noutput:\n${truncate(res.out)}`)
  return res.json
}

function asArray(value) {
  if (Array.isArray(value)) return value
  for (const key of ['tools', 'items', 'entries', 'results', 'matches']) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

function toolOf(json) {
  // NB: tool.json itself has an `entry` field (a rel path), so `entry` must not
  // be treated as a result-wrapper key here.
  return json?.tool ?? json?.item ?? json
}

function idsOf(value) {
  const out = []
  for (const item of asArray(value)) {
    const id = typeof item === 'string' ? item : item?.id ?? item?.tool?.id
    if (id) out.push(String(id))
  }
  return out
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
function sha256File(file) {
  return sha256Buf(fs.readFileSync(file))
}
function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function readRuns(home = HOME1) {
  const file = path.join(home, '.upptool', 'runs.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parseJson(line))
}
function indexOf(home = HOME1) {
  const file = path.join(home, '.upptool', 'index.json')
  return fs.existsSync(file) ? readJsonFile(file) : null
}

const watchdog = setTimeout(() => {
  process.stdout.write('FAIL suite watchdog: upptool tests exceeded 300s\n')
  process.exit(1)
}, 300_000)
watchdog.unref()

// ------------------------------------------------------------------ fixtures
fs.mkdirSync(FIX, { recursive: true })
fs.mkdirSync(HOME1, { recursive: true })
fs.mkdirSync(HOME2, { recursive: true })

const ECHO = path.join(FIX, 'echo-args.mjs')
fs.writeFileSync(
  ECHO,
  [
    "import fs from 'node:fs'",
    '',
    'const args = process.argv.slice(2)',
    "process.stdout.write(`ARGS:${JSON.stringify(args)}\\n`)",
    '',
  ].join('\n'),
)
const FAIL7 = path.join(FIX, 'fail-seven.mjs')
fs.writeFileSync(FAIL7, ["process.stdout.write('failing as asked\\n')", 'process.exit(7)', ''].join('\n'))
const CMDDUMMY = path.join(FIX, 'command-placeholder.txt')
fs.writeFileSync(CMDDUMMY, 'placeholder file for the command-runtime add\n')
const BATCH = path.join(TMP, 'batch.json')
fs.writeFileSync(
  BATCH,
  `${JSON.stringify(
    [
      { tool: 'echo-args', args: ['batch-one'] },
      { tool: 'fail-seven' },
    ],
    null,
    2,
  )}\n`,
)

const ECHO_TEXT = 'echo-args'
const FAIL_TEXT = 'fail-seven'
const CMD_TEXT = 'echo-cmd'

// ==========================================================================
// main
// ==========================================================================
async function main() {
  if (!fs.existsSync(CLI)) {
    skip('upptool suite', `tools/upptool.mjs not written yet (${path.relative(ROOT, CLI)})`)
    return
  }

  // ------------------------------------------------------------ add a script
  await check('add a node script tool', async () => {
    const res = jsonCli([
      'add',
      ECHO,
      '--name',
      ECHO_TEXT,
      '--desc',
      'dump argv to stdout, for tests',
      '--kind',
      'script',
      '--runtime',
      'node',
      '--tag',
      'demo,args',
      '--task',
      'acceptance test fixture: print argv',
      '--saved-tokens',
      '800',
    ])
    expectCode(res, 0, 'upptool add')
    const json = expectJson(res, 'add --json')
    assert.equal(json.created, true, `expected created:true, got ${truncate(JSON.stringify(json))}`)
    const tool = toolOf(json)
    assert.equal(tool.id, ECHO_TEXT)
    assert.equal(tool.name, ECHO_TEXT)
    assert.equal(tool.kind, 'script')
    assert.equal(tool.runtime, 'node')
    assert.match(String(tool.hash), /^[0-9a-f]{64}$/, 'tool.hash must be sha256 hex')
    assert.equal(tool.savedTokens, 800)
    // storage layout per CONTRACT
    const toolJson = path.join(UPPTOOL1, 'tools', ECHO_TEXT, 'tool.json')
    assert.ok(fs.existsSync(toolJson), `missing ${toolJson}`)
    const copied = path.join(UPPTOOL1, 'tools', ECHO_TEXT, 'files', 'echo-args.mjs')
    assert.ok(fs.existsSync(copied), `script not copied into the registry (${copied})`)
    assert.equal(sha256File(copied), sha256File(ECHO), 'copied script differs from the source')
    const index = indexOf()
    assert.ok(index, 'index.json missing')
    assert.equal(index.schema, 'upptool/1')
    assert.equal(index.count, 1)
    assert.deepEqual(index.tools.map((t) => t.id), [ECHO_TEXT])
  })

  // ------------------------------------------------- duplicate add by content
  await check('duplicate add of identical content reports duplicateOf', async () => {
    const res = jsonCli([
      'add',
      ECHO,
      '--name',
      ECHO_TEXT,
      '--desc',
      'dump argv to stdout, for tests',
      '--kind',
      'script',
      '--runtime',
      'node',
      '--tag',
      'demo,args',
      '--task',
      'acceptance test fixture: print argv',
      '--saved-tokens',
      '800',
    ])
    expectCode(res, 0, 'duplicate add (must not be a usage error)')
    const json = expectJson(res, 'duplicate add --json')
    assert.equal(json.created, false, `expected created:false, got ${truncate(JSON.stringify(json))}`)
    const dup = typeof json.duplicateOf === 'string' ? json.duplicateOf : json.duplicateOf?.id
    assert.equal(dup, ECHO_TEXT, 'duplicateOf must name the existing tool')
    assert.equal(indexOf().count, 1, 'duplicate add must not grow the index')
  })

  // --------------------------------------------------- add failing script + command
  await check('add a second script tool (nonzero exit fixture)', async () => {
    const res = jsonCli([
      'add',
      FAIL7,
      '--name',
      FAIL_TEXT,
      '--desc',
      'always exits 7',
      '--kind',
      'script',
      '--runtime',
      'node',
      '--saved-tokens',
      '250',
    ])
    expectCode(res, 0, 'add fail-seven')
    assert.equal(toolOf(expectJson(res, 'add --json')).id, FAIL_TEXT)
    assert.equal(indexOf().count, 2)
  })

  await check('add a command-runtime tool with a $1 template', async () => {
    const args = [
      '--name',
      CMD_TEXT,
      '--desc',
      'echo through the shell',
      '--kind',
      'command',
      '--runtime',
      'cmd',
      '--command',
      'echo upptool-cmd:$1',
      '--tag',
      'demo',
      '--saved-tokens',
      '500',
    ]
    let res = jsonCli(['add', ...args])
    if (res.code !== 0) {
      // The frozen grammar lists a positional <file|dir>; a command-only tool may
      // legitimately not need one. Retry with a placeholder so the check tests the
      // command tool itself rather than the positional-argument grammar.
      res = jsonCli(['add', CMDDUMMY, ...args])
    }
    expectCode(res, 0, 'add command tool')
    const tool = toolOf(expectJson(res, 'add --json'))
    assert.equal(tool.id, CMD_TEXT)
    assert.equal(tool.kind, 'command')
    assert.equal(tool.runtime, 'cmd')
    assert.match(String(tool.command ?? ''), /\$1/, 'the $1 placeholder must survive into tool.json')
    assert.equal(indexOf().count, 3)
  })

  // ------------------------------------------------- list / show / search / suggest
  await check('list --json shows every tool', async () => {
    const res = jsonCli(['list'])
    expectCode(res, 0, 'list')
    const ids = idsOf(expectJson(res, 'list --json'))
    assert.deepEqual([...ids].sort(), [CMD_TEXT, ECHO_TEXT, FAIL_TEXT].sort())
  })

  await check('list filters by --tag and --kind', async () => {
    const byTag = expectJson(expectCode(jsonCli(['list', '--tag', 'demo']), 0, 'list --tag'), 'list --tag')
    const tagIds = idsOf(byTag)
    assert.deepEqual([...tagIds].sort(), [CMD_TEXT, ECHO_TEXT].sort(), '--tag demo should select the two demo tools')
    const byKind = expectJson(expectCode(jsonCli(['list', '--kind', 'command']), 0, 'list --kind'), 'list --kind')
    assert.deepEqual(idsOf(byKind), [CMD_TEXT])
  })

  await check('show --json returns the full record', async () => {
    const res = jsonCli(['show', ECHO_TEXT])
    expectCode(res, 0, 'show')
    const tool = toolOf(expectJson(res, 'show --json'))
    assert.equal(tool.id, ECHO_TEXT)
    assert.equal(tool.desc, 'dump argv to stdout, for tests')
    assert.deepEqual(tool.tags, ['demo', 'args'])
    assert.ok(Array.isArray(tool.files) && tool.files.length >= 1, 'tool.files must list registered files')
    assert.ok(tool.files.every((f) => f.rel && /^[0-9a-f]{64}$/.test(f.sha256)), 'files entries need rel+sha256')
    assert.equal(tool.runs, 0)
    assert.ok(tool.createdFrom && tool.createdFrom.task, 'createdFrom.task should be recorded')
  })

  await check('search finds a tool by name/description', async () => {
    const res = jsonCli(['search', 'dump argv'])
    expectCode(res, 0, 'search')
    assert.ok(idsOf(expectJson(res, 'search --json')).includes(ECHO_TEXT), 'search should find echo-args by description')
  })

  await check('suggest ranks a matching tool', async () => {
    const res = jsonCli(['suggest', 'echo arguments to stdout'])
    expectCode(res, 0, 'suggest')
    const list = asArray(expectJson(res, 'suggest --json'))
    assert.ok(list.length >= 1, 'suggest returned nothing')
    const top = list[0]
    assert.ok(typeof top.id === 'string' && top.id.length > 0, 'suggest rows need an id')
    assert.equal(typeof top.score, 'number', 'suggest rows need a numeric score')
    assert.ok(list.some((item) => item.id === ECHO_TEXT), 'suggest should rank echo-args')
  })

  // ------------------------------------------------------------------ run it
  await check('run a node script tool with argv and exit 0', async () => {
    const res = runTool(ECHO_TEXT, ['alpha', 'beta'])
    expectCode(res, 0, 'run echo-args')
    const json = expectJson(res, 'run --json')
    if (json && typeof json === 'object') {
      assert.equal(typeof json.exit, 'number', 'run --json needs an exit field')
      assert.equal(json.exit, 0)
      assert.equal(json.ok, true)
    }
    const combined = `${json?.stdout ?? ''}${res.stdout}`
    assert.match(combined, /ARGS:\["alpha","beta"\]/, `argv was not forwarded:\n${truncate(res.out)}`)
  })

  await check('run a failing tool passes the exit code through', async () => {
    const res = runTool(FAIL_TEXT)
    assert.equal(res.code, 7, `expected exit 7 passthrough, got ${res.code}\n${truncate(res.out)}`)
    const json = parseJson(res.stdout)
    if (json && typeof json === 'object') assert.equal(json.exit, 7)
  })

  await check('run a command-runtime tool and substitute $1', async () => {
    const res = runTool(CMD_TEXT, ['hello-upp'])
    expectCode(res, 0, 'run echo-cmd')
    const json = parseJson(res.stdout)
    const combined = `${json?.stdout ?? ''}${res.stdout}`
    assert.match(combined, /upptool-cmd:hello-upp/, `$1 was not substituted:\n${truncate(res.out)}`)
  })

  await check('runs.jsonl appends one line per run', async () => {
    const lines = readRuns()
    assert.equal(lines.length, 3, `expected 3 run lines, got ${lines.length}: ${truncate(JSON.stringify(lines))}`)
    for (const line of lines) {
      if (line && typeof line === 'object') {
        assert.ok(line.id || line.tool || line.toolId, 'each runs.jsonl line should name the tool')
      }
    }
    assert.ok(lines.some((l) => JSON.stringify(l).includes(ECHO_TEXT)), 'runs.jsonl missing echo-args')
  })

  await check('tool counters accumulate savedTokens and runs', async () => {
    const res = jsonCli(['show', ECHO_TEXT])
    expectCode(res, 0, 'show')
    const tool = toolOf(expectJson(res, 'show --json'))
    assert.equal(tool.runs, 1, 'echo-args should have one recorded run')
    assert.equal(tool.savedTotal, 800, 'one run should accumulate savedTokens=800')
    assert.equal(tool.savedTokens, 800, 'per-run savedTokens stays 800')
  })

  // ------------------------------------------------------------------- batch
  await check('batch runs two tools and --continue-on-error survives the failure', async () => {
    const res = jsonCli(['batch', BATCH, '--continue-on-error'])
    const json = expectJson(res, 'batch --json')
    const results = asArray(json)
    assert.equal(results.length, 2, `batch should report two results, got ${truncate(JSON.stringify(json))}`)
    const byName = new Map()
    for (const row of results) {
      const name = row?.tool ?? row?.id ?? row?.name
      if (name) byName.set(String(name), row)
    }
    assert.ok(byName.has(ECHO_TEXT) && byName.has(FAIL_TEXT), 'batch results should name both tools')
    const failedRow = byName.get(FAIL_TEXT)
    if (failedRow) assert.equal(failedRow.exit, 7, 'batch must keep the failing exit code')
    assert.equal(readRuns().length, 5, 'batch should append two more runs.jsonl lines')
  })

  // ------------------------------------------------------------------ stats
  await check('stats --json is self-consistent with index.json and runs.jsonl', async () => {
    const res = jsonCli(['stats'])
    expectCode(res, 0, 'stats')
    const stats = expectJson(res, 'stats --json')
    const index = indexOf()
    const runs = readRuns()
    assert.equal(stats.tools, index.count, 'stats.tools should equal index.count')
    assert.equal(stats.tools, 3)
    assert.equal(stats.runs, runs.length, 'stats.runs should equal the runs.jsonl line count')
    assert.equal(stats.runs, 5)
    const sumSaved = index.tools.reduce((acc, t) => acc + Number(t.savedTotal ?? 0), 0)
    assert.equal(stats.savedTokens, sumSaved, 'stats.savedTokens should equal the sum of tool.savedTotal')
    assert.equal(stats.savedTokens, 2600, '3 tools / 5 runs should have saved 2600 tokens')
    assert.equal(stats.okRuns + stats.failedRuns, runs.length, 'okRuns + failedRuns must equal runs')
    assert.ok(Array.isArray(stats.topTools), 'stats.topTools should be an array')
    for (const row of stats.topTools) {
      assert.ok(row.id && typeof row.runs === 'number' && typeof row.savedTotal === 'number', 'topTools rows need id/runs/savedTotal')
    }
  })

  // --------------------------------------------------------- export -> import
  const BUNDLE = path.join(TMP, 'bundle.upptool')
  await check('export writes a zip bundle', async () => {
    const res = jsonCli(['export', '-o', BUNDLE])
    expectCode(res, 0, 'export')
    expectJson(res, 'export --json')
    assert.ok(fs.existsSync(BUNDLE), 'bundle file missing')
    assert.ok(fs.statSync(BUNDLE).size > 0, 'bundle file is empty')
    const head = fs.readFileSync(BUNDLE).subarray(0, 2).toString('latin1')
    assert.equal(head, 'PK', 'bundle should be a zip archive')
  })

  await check('import into a fresh HOME preserves hashes and reruns the tool', async () => {
    const imported = jsonCli(['import', BUNDLE], { home: HOME2 })
    expectCode(imported, 0, 'import')
    expectJson(imported, 'import --json')
    const original = indexOf()
    const fresh = indexOf(HOME2)
    assert.ok(fresh, 'fresh index.json missing after import')
    assert.equal(fresh.count, 3)
    const origHashes = new Map(original.tools.map((t) => [t.id, t.hash]))
    const freshHashes = new Map(fresh.tools.map((t) => [t.id, t.hash]))
    assert.deepEqual([...freshHashes.keys()].sort(), [...origHashes.keys()].sort())
    for (const [id, hash] of origHashes) assert.equal(freshHashes.get(id), hash, `hash mismatch for ${id}`)
    // file contents must match too
    const origTool = toolOf(expectJson(expectCode(jsonCli(['show', ECHO_TEXT]), 0, 'show'), 'show --json'))
    const freshTool = toolOf(expectJson(expectCode(jsonCli(['show', ECHO_TEXT], { home: HOME2 }), 0, 'show fresh'), 'show --json'))
    assert.deepEqual(
      freshTool.files.map((f) => [f.rel, f.sha256]),
      origTool.files.map((f) => [f.rel, f.sha256]),
      'imported file list must match the source',
    )
    // and the imported script actually runs from its new home
    const run = runTool(ECHO_TEXT, ['fresh'], { home: HOME2 })
    expectCode(run, 0, 'run after import')
    const json = parseJson(run.stdout)
    assert.match(`${json?.stdout ?? ''}${run.stdout}`, /ARGS:\["fresh"\]/, 'imported tool did not execute')
    const freshRuns = readRuns(HOME2)
    assert.equal(freshRuns.length, 1, 'fresh home starts with a clean runs.jsonl and appends the new run')
  })

  // ------------------------------------------------------------------- rm
  await check('rm removes a tool from the registry', async () => {
    const res = jsonCli(['rm', CMD_TEXT, '--force'])
    expectCode(res, 0, 'rm')
    expectJson(res, 'rm --json')
    assert.ok(!fs.existsSync(path.join(UPPTOOL1, 'tools', CMD_TEXT)), 'tool directory still present after rm')
    const list = expectJson(expectCode(jsonCli(['list']), 0, 'list'), 'list --json')
    assert.ok(!idsOf(list).includes(CMD_TEXT), 'removed tool still listed')
    const again = jsonCli(['rm', CMD_TEXT, '--force'])
    assert.notEqual(again.code, 0, 'removing a missing tool should be a non-zero usage error')
  })

  await check('stats reflects the removal', async () => {
    const stats = expectJson(expectCode(jsonCli(['stats']), 0, 'stats'), 'stats --json')
    assert.equal(stats.tools, 2)
    // runs.jsonl is append-only history: removing a tool must not erase the
    // tokens its past runs already saved.
    assert.equal(stats.runs, 5, 'run history must survive rm')
    assert.equal(stats.savedTokens, 2600, 'savedTokens counts the whole run history')
  })

  // --------------------------------------------------------------- doctor/help
  await check('doctor exits 0 and reports JSON', async () => {
    const res = jsonCli(['doctor'])
    expectCode(res, 0, 'doctor')
    const json = expectJson(res, 'doctor --json')
    assert.ok(json && typeof json === 'object', 'doctor should emit a JSON object')
  })

  await check('help exits 0 and names the frozen verbs', async () => {
    const res = cli(['help'])
    expectCode(res, 0, 'help')
    for (const verb of ['add', 'list', 'show', 'run', 'batch', 'suggest', 'search', 'rm', 'export', 'import', 'stats', 'doctor']) {
      assert.ok(res.out.includes(verb), `help output does not mention ${verb}`)
    }
  })
}

try {
  await main()
} catch (err) {
  fail('unexpected exception', err && err.stack ? err.stack : String(err))
} finally {
  clearTimeout(watchdog)
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
const total = passed + failed
process.stdout.write(
  `\nupptool: ${passed} passed, ${failed} failed` +
    `${skipped ? `, ${skipped} skipped` : ''} (${total} checks, ${seconds}s)\n`,
)
process.exitCode = failed ? 1 : 0
