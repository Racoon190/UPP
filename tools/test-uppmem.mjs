#!/usr/bin/env node
/**
 * uppmem acceptance suite — drives the real CLI + MCP server through a fake HOME.
 *
 * Everything (pool files, bundles, tx dirs, WorkBuddy/Accio/DSH fixtures) lives
 * under os.tmpdir(); USERPROFILE/HOME/UPPMEM_HOME/UPPMEM_HOME host roots are
 * redirected there, so the real ~/.uppmem and the real host memory files are
 * never read or written.
 *
 *   node tools/test-uppmem.mjs
 *
 * Prints PASS/FAIL/SKIP lines and a summary; exits 1 when anything FAILed.
 * Missing CLI / host adapter / MCP server modules SKIP instead of crashing.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLI = path.join(ROOT, 'tools', 'uppmem.mjs')
const MCP_SERVER = path.join(ROOT, 'lib', 'uppmem', 'mcp-server.mjs')
const HOSTS_DIR = path.join(ROOT, 'lib', 'uppmem', 'hosts')
const CHILD_TIMEOUT_MS = 120_000
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uppmem-selftest-'))

const HOME1 = path.join(TMP, 'home-1')
const HOME2 = path.join(TMP, 'home-2')
const POOL1 = path.join(HOME1, '.uppmem')

const WB_ACCOUNT = 'bd524400-1111-4abc-9def-000000000001'
const ACCIO_ACCOUNT = '1797968970'
const NATIVE_WB_TEXT = '已有宿主记忆：用户喜欢深色主题'
const NATIVE_ACCIO_TEXT = '用户偏好简洁回答'

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
  process.stdout.write(`FAIL ${label}${lines.length ? `\n     ${lines.slice(0, 16).join('\n     ')}\n` : '\n'}`)
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
    fail(label, err && err.message ? err.message : String(err))
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
    HOMEPATH: h.slice(path.parse(h).root.length),
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

function cli(args, { home = HOME1, extraEnv = {}, cwd = TMP, stdin } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: envFor(home, extraEnv),
    encoding: 'utf8',
    input: stdin,
    timeout: CHILD_TIMEOUT_MS,
    windowsHide: true,
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  return { code: res.status, signal: res.signal, error: res.error, stdout, stderr, out: `${stdout}${stderr}` }
}

function parseJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    /* tolerate a stray log line before the payload */
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

function expectCode(res, want, label) {
  const codes = Array.isArray(want) ? want : [want]
  if (!codes.includes(res.code)) {
    throw new Error(
      `${label}: expected exit ${codes.join('|')}, got ${res.code}${res.error ? ` (${res.error.message})` : ''}\noutput:\n${truncate(res.out)}`,
    )
  }
  return res
}

function expectJson(res, label) {
  if (res.json == null) throw new Error(`${label}: stdout is not JSON\noutput:\n${truncate(res.out)}`)
  return res.json
}

function asArray(value, extraKeys = []) {
  if (Array.isArray(value)) return value
  for (const key of [...extraKeys, 'entries', 'tools', 'items', 'results', 'matches', 'hosts']) {
    if (Array.isArray(value?.[key])) return value[key]
  }
  return []
}

const normText = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
/** Stored form: author characters preserved, whitespace folded (CONTRACT §entry). */
const canonText = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function entriesOf(json) {
  return asArray(json).map((item) => (item && typeof item === 'object' && item.entry ? item.entry : item)).filter(Boolean)
}

function listEntries({ home = HOME1, extraEnv = {} } = {}) {
  const res = jsonCli(['list'], { home, extraEnv })
  expectCode(res, 0, 'uppmem list')
  return entriesOf(expectJson(res, 'list --json'))
}

function poolFiles(home = HOME1, extraEnv = {}) {
  const root = extraEnv.UPPMEM_HOME ?? path.join(home, '.uppmem')
  const dir = path.join(root, 'pool', 'entries')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
}

/** rel path -> sha256, for every file under dir (directories are implicit). */
function snapshot(dir) {
  const out = new Map()
  const walk = (d) => {
    let items
    try {
      items = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const item of items) {
      const p = path.join(d, item.name)
      if (item.isDirectory()) walk(p)
      else if (item.isFile()) out.set(path.relative(dir, p), sha256File(p))
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

function diffSnapshot(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed = [...before.keys()].filter((k) => after.has(k) && before.get(k) !== after.get(k))
  return { added, removed, changed }
}

function expectNoWrites(before, dir, label) {
  const diff = diffSnapshot(before, snapshot(dir))
  if (diff.added.length || diff.removed.length || diff.changed.length) {
    throw new Error(
      `${label}: dry-run wrote to ${path.basename(dir)}\n` +
        `  added:   ${diff.added.slice(0, 8).join(', ') || '-'}\n` +
        `  removed: ${diff.removed.slice(0, 8).join(', ') || '-'}\n` +
        `  changed: ${diff.changed.slice(0, 8).join(', ') || '-'}`,
    )
  }
}

const watchdog = setTimeout(() => {
  process.stdout.write('FAIL suite watchdog: uppmem tests exceeded 300s\n')
  process.exit(1)
}, 300_000)
watchdog.unref()

// ------------------------------------------------------------------- fixtures
fs.mkdirSync(HOME1, { recursive: true })
fs.mkdirSync(HOME2, { recursive: true })

// WorkBuddy: ~/.workbuddy/memory/<account>_memory.md (host format, RAW JSON block).
const WB_MEMORY_DIR = path.join(HOME1, '.workbuddy', 'memory')
fs.mkdirSync(WB_MEMORY_DIR, { recursive: true })
const WB_MEMORY_FILE = path.join(WB_MEMORY_DIR, `${WB_ACCOUNT}_memory.md`)
const WB_ORIGINAL = [
  '# User Memory Profile',
  '> Last updated: 2026-01-02T03:04:05.000Z',
  '> Version: 0',
  '',
  '## Memory Block',
  NATIVE_WB_TEXT,
  '',
  '---',
  '<!-- RAW_JSON_START',
  '{',
  `  "uid": "${WB_ACCOUNT}",`,
  `  "memoryBlock": "${NATIVE_WB_TEXT}",`,
  '  "updatedAt": "2026-01-02T03:04:05.000Z"',
  '}',
  'RAW_JSON_END -->',
  '',
].join('\n')
fs.writeFileSync(WB_MEMORY_FILE, WB_ORIGINAL)

// Accio: ~/.accio/accounts/<account>/global-memory/PROFILE.md (+ skills/ marker).
const ACCIO_ACCOUNT_DIR = path.join(HOME1, '.accio', 'accounts', ACCIO_ACCOUNT)
fs.mkdirSync(path.join(ACCIO_ACCOUNT_DIR, 'skills'), { recursive: true })
const ACCIO_MEMORY_DIR = path.join(ACCIO_ACCOUNT_DIR, 'global-memory')
fs.mkdirSync(ACCIO_MEMORY_DIR, { recursive: true })
const ACCIO_PROFILE = path.join(ACCIO_MEMORY_DIR, 'PROFILE.md')
const ACCIO_ORIGINAL = [
  '# User Profile (Global Memory)',
  '',
  'Account-level personalization shared across Main Agent conversations.',
  'This profile is read-only to the Main Agent and managed by the host application.',
  '',
  '## Accounts & Stores',
  '',
  '## Preferences',
  '',
  `- ${NATIVE_ACCIO_TEXT}`,
  '',
  '## Notes',
  '',
].join('\n')
fs.writeFileSync(ACCIO_PROFILE, ACCIO_ORIGINAL)

// DSH: just a dsh home (its memory snapshot is generated by an install).
fs.mkdirSync(path.join(HOME1, '.dsh'), { recursive: true })

// ==========================================================================
// main
// ==========================================================================
async function main() {
  if (!fs.existsSync(CLI)) {
    skip('uppmem suite', `tools/uppmem.mjs not written yet (${path.relative(ROOT, CLI)})`)
    return
  }

  // ------------------------------------------------------- add + normalization
  const prefText = '  用户偏好：   中文回答\n代码注释也用中文\n'
  const prefStored = canonText(prefText)
  const prefIdentity = normText(prefText)
  let prefId

  await check('add a preference entry with --key and normalizes text', async () => {
    const res = jsonCli(['add', prefText, '--kind', 'preference', '--tag', 'lang,style', '--key', 'user.language', '--json'])
    expectCode(res, 0, 'uppmem add')
    const json = expectJson(res, 'add --json')
    assert.equal(json.created, true, 'first add must be created:true')
    const entry = json.entry
    assert.ok(entry, 'add --json must contain the entry')
    prefId = entry.id
    assert.match(entry.id, /^m-[0-9a-f]{12}$/, `bad id: ${entry.id}`)
    assert.equal(entry.text, prefStored, 'stored text keeps author characters, whitespace-folded')
    if (entry.raw !== undefined && entry.raw !== null) {
      assert.equal(entry.raw, prefText.replace(/\s+/g, ' ').trim(), '`raw` should keep the author spelling')
    }
    assert.equal(entry.hash, sha256Hex(prefIdentity), 'hash must be sha256(NFKC text)')
    assert.equal(entry.kind, 'preference')
    assert.equal(entry.key, 'user.language')
    assert.deepEqual([...entry.tags].sort(), ['lang', 'style'])
    assert.equal(entry.scope, 'global')
    assert.equal(poolFiles().length, 1, 'one entry file should exist')
  })

  const projText = '项目 uppmem 把三个宿主的记忆收拢到一个共享池'
  let projId

  await check('add a project entry without a key', async () => {
    const res = jsonCli(['add', projText, '--kind', 'project', '--tag', 'proj'])
    expectCode(res, 0, 'add project')
    const entry = expectJson(res, 'add --json').entry
    projId = entry.id
    assert.match(entry.id, /^m-[0-9a-f]{12}$/)
    assert.equal(entry.kind, 'project')
    assert.equal(entry.key, null)
    assert.equal(listEntries().length, 2)
  })

  await check('duplicate add by normalized text updates instead of duplicating', async () => {
    const noisy = `\n${projText.replace(' ', '   ')}\n`
    const res = jsonCli(['add', noisy, '--kind', 'project'])
    expectCode(res, 0, 'duplicate add')
    const json = expectJson(res, 'duplicate add --json')
    assert.equal(json.created, false, 'duplicate text must not create')
    assert.equal(json.updated, true, 'duplicate text must update (LWW)')
    assert.equal(json.entry.id, projId, 'dedupe must keep the stable id')
    assert.equal(listEntries().length, 2, 'duplicate must not grow the pool')
  })

  await check('re-adding the same --key updates that entry in place', async () => {
    const next = '用户偏好中文回答，代码注释与提交信息均用中文'
    const res = jsonCli(['add', next, '--kind', 'preference', '--key', 'user.language'])
    expectCode(res, 0, 'key update')
    const entry = expectJson(res, 'add --json').entry
    assert.equal(entry.id, prefId, 'keyed updates must keep the id')
    assert.equal(entry.text, canonText(next), 'stored text keeps the author spelling (full-width comma)')
    assert.equal(entry.hash, sha256Hex(normText(next)))
    if (entry.raw !== undefined && entry.raw !== null) {
      assert.equal(entry.raw, next, '`raw` should keep the author spelling')
    }
    assert.equal(listEntries().length, 2)
  })

  // ------------------------------------------------------------ list/search/get
  await check('list returns both entries newest-first with full fields', async () => {
    const rows = listEntries()
    assert.equal(rows.length, 2)
    for (const e of rows) {
      assert.match(e.id, /^m-[0-9a-f]{12}$/)
      assert.ok(e.text && e.kind && e.hash, 'entry needs text/kind/hash')
      assert.match(e.hash, /^[0-9a-f]{64}$/)
      assert.ok(e.createdAt && e.updatedAt, 'entry needs timestamps')
    }
    const stamps = rows.map((e) => String(e.updatedAt))
    assert.deepEqual(stamps, [...stamps].sort().reverse(), 'list must be newest-first')
  })

  await check('list filters by --kind and --tag', async () => {
    const prefs = entriesOf(expectJson(expectCode(jsonCli(['list', '--kind', 'preference']), 0, 'list --kind'), 'list'))
    assert.deepEqual(prefs.map((e) => e.id), [prefId])
    const byTag = entriesOf(expectJson(expectCode(jsonCli(['list', '--tag', 'lang']), 0, 'list --tag'), 'list'))
    assert.deepEqual(byTag.map((e) => e.id), [prefId])
  })

  await check('search finds entries and honours --limit', async () => {
    const res = jsonCli(['search', '中文'])
    expectCode(res, 0, 'search')
    const rows = entriesOf(expectJson(res, 'search --json'))
    assert.ok(rows.some((e) => e.id === prefId), 'search should find the language preference')
    const limited = entriesOf(expectJson(expectCode(jsonCli(['search', '中文', '--limit', '1']), 0, 'search --limit'), 'search'))
    assert.equal(limited.length, 1)
    const none = entriesOf(expectJson(expectCode(jsonCli(['search', '完全不存在的词xyz']), 0, 'search miss'), 'search'))
    assert.equal(none.length, 0)
  })

  await check('get resolves by id and by key', async () => {
    const byId = expectJson(expectCode(jsonCli(['get', prefId]), 0, 'get id'), 'get --json')
    assert.equal(byId.id, prefId)
    const byKey = expectJson(expectCode(jsonCli(['get', 'user.language']), 0, 'get key'), 'get --json')
    assert.equal(byKey.id, prefId, 'get by key must resolve the same entry')
  })

  // ----------------------------------------------------------------- build
  await check('build regenerates index.json + MEMORY.md deterministically', async () => {
    const indexPath = path.join(POOL1, 'index.json')
    const memPath = path.join(POOL1, 'MEMORY.md')
    expectCode(jsonCli(['build']), 0, 'build')
    assert.ok(fs.existsSync(indexPath), 'index.json missing after build')
    assert.ok(fs.existsSync(memPath), 'MEMORY.md missing after build')
    const index = readJsonFile(indexPath)
    assert.equal(index.count, 2)
    assert.equal(index.entries.length, 2)
    const memoryBytes = sha256File(memPath)
    assert.match(fs.readFileSync(memPath, 'utf8'), /# Shared Agent Memory/)
    fs.rmSync(memPath)
    fs.rmSync(indexPath)
    const rebuilt = expectJson(expectCode(jsonCli(['build']), 0, 'build again'), 'build --json')
    assert.ok(fs.existsSync(indexPath) && fs.existsSync(memPath), 'build did not recreate its outputs')
    assert.equal(rebuilt.count, 2)
    assert.equal(sha256File(memPath), memoryBytes, 'MEMORY.md must be byte-stable across builds')
  })

  await check('stats --json is consistent with the pool', async () => {
    const res = jsonCli(['stats'])
    expectCode(res, 0, 'stats')
    const stats = expectJson(res, 'stats --json')
    assert.equal(stats.entries, 2)
    const byKindTotal = Object.values(stats.byKind).reduce((a, b) => a + b, 0)
    assert.equal(byKindTotal, 2)
    assert.ok(Array.isArray(stats.tags) && stats.tags.includes('lang'), 'stats.tags should include the tag')
    assert.ok(Array.isArray(stats.hosts))
  })

  // -------------------------------------------------------- export -> import
  const BUNDLE = path.join(TMP, 'pool.uppmem')
  await check('export writes a zip bundle', async () => {
    const res = jsonCli(['export', '-o', BUNDLE])
    expectCode(res, 0, 'export')
    const json = expectJson(res, 'export --json')
    assert.equal(json.entries, 2)
    assert.ok(fs.existsSync(BUNDLE), 'bundle missing')
    assert.equal(fs.statSync(BUNDLE).size, json.size, 'reported size should match the file')
    assert.equal(fs.readFileSync(BUNDLE).subarray(0, 2).toString('latin1'), 'PK', 'bundle should be a zip')
  })

  await check('import into a fresh HOME preserves entries and hashes', async () => {
    const source = listEntries()
    const res = jsonCli(['import', BUNDLE], { home: HOME2 })
    expectCode(res, 0, 'import')
    const json = expectJson(res, 'import --json')
    const actions = asArray(json)
    assert.equal(actions.length, 2)
    assert.ok(
      actions.every((r) => r.action === 'create'),
      `fresh import must create, got ${truncate(JSON.stringify(actions))}`,
    )
    const imported = listEntries({ home: HOME2 })
    assert.equal(imported.length, 2)
    const keyOf = (e) => `${e.id}|${e.text}|${e.hash}|${e.kind}|${e.key ?? ''}|${(e.tags ?? []).join(',')}`
    assert.deepEqual(imported.map(keyOf).sort(), source.map(keyOf).sort(), 'entry identity must survive the round trip')
    assert.equal(
      sha256File(path.join(HOME2, '.uppmem', 'MEMORY.md')),
      sha256File(path.join(POOL1, 'MEMORY.md')),
      'imported MEMORY.md should match the source snapshot',
    )
    const again = jsonCli(['import', BUNDLE], { home: HOME2 })
    expectCode(again, 0, 're-import')
    const againActions = asArray(expectJson(again, 'import --json'))
    assert.ok(againActions.every((r) => r.action === 'skip'), 'default on-conflict=skip must not rewrite entries')
    assert.equal(listEntries({ home: HOME2 }).length, 2)
  })

  // --------------------------------------------------------------------- rm
  await check('rm removes an entry and is idempotent-safe', async () => {
    const res = jsonCli(['rm', projId])
    expectCode(res, 0, 'rm')
    const json = expectJson(res, 'rm --json')
    assert.equal(json.removed, true)
    assert.equal(listEntries().length, 1)
    assert.ok(!poolFiles().includes(`${projId}.json`), 'entry file still present')
    const again = jsonCli(['rm', projId])
    assert.notEqual(again.code, 0, 'removing a missing entry must fail')
  })

  await check('doctor exits 0 on a healthy pool', async () => {
    const res = jsonCli(['doctor'])
    expectCode(res, 0, 'doctor')
    const report = expectJson(res, 'doctor --json')
    assert.equal(report.ok, true, `doctor reported: ${truncate(JSON.stringify(report.checks))}`)
    assert.ok(Array.isArray(report.checks) && report.checks.length >= 4)
  })

  // ------------------------------------------------------------------- hosts
  await check('hosts --json detects DSH, WorkBuddy and Accio', async () => {
    const res = jsonCli(['hosts'])
    expectCode(res, 0, 'hosts')
    const rows = asArray(expectJson(res, 'hosts --json'))
    assert.equal(rows.length, 3)
    const names = rows.map((r) => r.host).sort()
    assert.deepEqual(names, ['accio', 'dsh', 'workbuddy'])
    for (const row of rows) assert.equal(row.installed, true, `adapter missing for ${row.host}`)
    const wb = rows.find((r) => r.host === 'workbuddy')
    const accio = rows.find((r) => r.host === 'accio')
    assert.equal(wb.available, true, `WorkBuddy fixture not detected: ${wb.reason ?? ''}`)
    assert.equal(accio.available, true, `Accio fixture not detected: ${accio.reason ?? ''}`)
  })

  // ----------------------------------------------------- sync: dry-run no-write
  async function dryRunCheck(host) {
    const adapter = path.join(HOSTS_DIR, `${host}.mjs`)
    if (!fs.existsSync(adapter)) {
      skip(`sync --host ${host} --dry-run writes nothing`, `hosts/${host}.mjs not written yet`)
      return
    }
    const poolDir = path.join(HOME1, `.uppmem-dry-${host}`)
    const before = snapshot(HOME1)
    const res = jsonCli(['sync', '--host', host, '--both', '--dry-run'], { extraEnv: { UPPMEM_HOME: poolDir } })
    expectCode(res, 0, `sync --host ${host} --dry-run`)
    expectJson(res, `sync --host ${host} --dry-run --json`)
    expectNoWrites(before, HOME1, `sync --host ${host} --both --dry-run`)
  }

  await check('sync --host dsh --dry-run writes nothing', () => dryRunCheck('dsh'))
  await check('sync --host workbuddy --dry-run writes nothing', () => dryRunCheck('workbuddy'))
  await check('sync --host accio --dry-run writes nothing', () => dryRunCheck('accio'))

  // ------------------------------------------------------- sync: WorkBuddy RT
  const POOL_WB = path.join(HOME1, '.uppmem-wb')
  const WB_MARKER = 'WB 往返：用户偏好中文界面'

  await check('push to the WorkBuddy memory file appends only the managed section', async () => {
    const add = jsonCli(['add', WB_MARKER, '--kind', 'preference', '--key', 'ui.language'], { extraEnv: { UPPMEM_HOME: POOL_WB } })
    expectCode(add, 0, 'pool add')
    const res = jsonCli(['sync', '--host', 'workbuddy', '--push'], { extraEnv: { UPPMEM_HOME: POOL_WB } })
    expectCode(res, 0, 'sync push workbuddy')
    const json = expectJson(res, 'sync push --json')
    const row = asArray(json)[0]
    assert.equal(row.host, 'workbuddy')
    assert.equal(row.ok, true, `push failed: ${row.error ?? ''}`)
    const pushed = (row.push?.files ?? [])[0]
    assert.ok(pushed, 'push should report a file')
    assert.ok(pushed.action === 'update' || pushed.action === 'create', `unexpected action ${pushed.action}`)
    const content = fs.readFileSync(WB_MEMORY_FILE, 'utf8')
    assert.match(content, /<!--\s*uppmem:begin\s*-->/, 'managed section not appended')
    assert.ok(normText(content).includes(normText(WB_MARKER)), 'pushed entry text missing from the host file')
    assert.ok(content.startsWith('# User Memory Profile'), 'host header must be preserved')
    assert.ok(content.includes('RAW_JSON_END -->'), 'host RAW_JSON block must be preserved')
  })

  await check('WorkBuddy push is idempotent (noop + byte-identical)', async () => {
    const before = sha256File(WB_MEMORY_FILE)
    const res = jsonCli(['sync', '--host', 'workbuddy', '--push'], { extraEnv: { UPPMEM_HOME: POOL_WB } })
    expectCode(res, 0, 'sync push again')
    const row = asArray(expectJson(res, 'sync push --json'))[0]
    const pushed = (row.push?.files ?? [])[0]
    assert.equal(pushed?.action, 'noop', `second push should be a noop, got ${pushed?.action}`)
    assert.equal(sha256File(WB_MEMORY_FILE), before, 'second push must not rewrite the file')
  })

  await check('pull from WorkBuddy round-trips pushed text into a fresh pool', async () => {
    const POOL_PULL = path.join(HOME1, '.uppmem-wb-pull')
    const res = jsonCli(['sync', '--host', 'workbuddy', '--pull'], { extraEnv: { UPPMEM_HOME: POOL_PULL } })
    expectCode(res, 0, 'sync pull workbuddy')
    const row = asArray(expectJson(res, 'sync pull --json'))[0]
    assert.equal(row.ok, true, `pull failed: ${row.error ?? ''}`)
    const texts = listEntries({ extraEnv: { UPPMEM_HOME: POOL_PULL } }).map((e) => e.text)
    assert.ok(
      texts.some((t) => normText(t).includes(normText(WB_MARKER))),
      `pushed text did not survive pull: ${truncate(JSON.stringify(texts))}`,
    )
    assert.ok(texts.some((t) => t.includes(NATIVE_WB_TEXT)), 'host-native memoryBlock should be imported read-only')
    // second pull must not create duplicates
    const first = texts.length
    expectCode(jsonCli(['sync', '--host', 'workbuddy', '--pull'], { extraEnv: { UPPMEM_HOME: POOL_PULL } }), 0, 'pull again')
    assert.equal(listEntries({ extraEnv: { UPPMEM_HOME: POOL_PULL } }).length, first, 'pull must be idempotent')
  })

  await check('sync --both records host state without losing pool entries', async () => {
    const res = jsonCli(['sync', '--host', 'workbuddy', '--both'], { extraEnv: { UPPMEM_HOME: POOL_WB } })
    expectCode(res, 0, 'sync both workbuddy')
    const state = readJsonFile(path.join(POOL_WB, 'state.json'))
    assert.ok(state.hosts?.workbuddy, 'state.json should record the workbuddy sync')
    assert.ok(state.hosts.workbuddy.lastSyncAt, 'lastSyncAt missing')
    const texts = listEntries({ extraEnv: { UPPMEM_HOME: POOL_WB } }).map((e) => e.text)
    assert.ok(
      texts.some((t) => normText(t).includes(normText(WB_MARKER))),
      'pool entry lost after sync --both',
    )
  })

  // ---------------------------------------------------------- sync: Accio RT
  const POOL_AC = path.join(HOME1, '.uppmem-accio')
  const ACCIO_MARKER = 'Accio 往返：回答尽量简短'

  await check('push to the Accio PROFILE.md appends the managed section only', async () => {
    const add = jsonCli(['add', ACCIO_MARKER, '--kind', 'preference', '--tag', 'style'], { extraEnv: { UPPMEM_HOME: POOL_AC } })
    expectCode(add, 0, 'pool add')
    const res = jsonCli(['sync', '--host', 'accio', '--push'], { extraEnv: { UPPMEM_HOME: POOL_AC } })
    expectCode(res, 0, 'sync push accio')
    const row = asArray(expectJson(res, 'sync push --json'))[0]
    assert.equal(row.ok, true, `push failed: ${row.error ?? ''}`)
    const content = fs.readFileSync(ACCIO_PROFILE, 'utf8')
    assert.ok(content.startsWith('# User Profile (Global Memory)'), 'Accio header must be preserved')
    assert.match(content, /<!--\s*uppmem:begin\s*-->/, 'managed section not appended')
    assert.ok(normText(content).includes(normText(ACCIO_MARKER)), 'pushed entry text missing from PROFILE.md')
    assert.ok(content.includes(NATIVE_ACCIO_TEXT), 'host-native bullet must be preserved')
  })

  await check('Accio push is idempotent (noop + byte-identical)', async () => {
    const before = sha256File(ACCIO_PROFILE)
    const res = jsonCli(['sync', '--host', 'accio', '--push'], { extraEnv: { UPPMEM_HOME: POOL_AC } })
    expectCode(res, 0, 'sync push accio again')
    const row = asArray(expectJson(res, 'sync push --json'))[0]
    assert.equal((row.push?.files ?? [])[0]?.action, 'noop')
    assert.equal(sha256File(ACCIO_PROFILE), before, 'second Accio push must not rewrite PROFILE.md')
  })

  await check('pull from Accio round-trips pushed text into a fresh pool', async () => {
    const POOL_PULL = path.join(HOME1, '.uppmem-accio-pull')
    const res = jsonCli(['sync', '--host', 'accio', '--pull'], { extraEnv: { UPPMEM_HOME: POOL_PULL } })
    expectCode(res, 0, 'sync pull accio')
    const row = asArray(expectJson(res, 'sync pull --json'))[0]
    assert.equal(row.ok, true, `pull failed: ${row.error ?? ''}`)
    const texts = listEntries({ extraEnv: { UPPMEM_HOME: POOL_PULL } }).map((e) => e.text)
    assert.ok(
      texts.some((t) => normText(t).includes(normText(ACCIO_MARKER))),
      `pushed text did not survive pull: ${truncate(JSON.stringify(texts))}`,
    )
    assert.ok(texts.some((t) => t.includes(NATIVE_ACCIO_TEXT)), 'host-native bullet should be imported read-only')
  })

  await check('pull from an uninstalled DSH is a clean no-op', async () => {
    const POOL_DSH = path.join(HOME1, '.uppmem-dsh-pull')
    const res = jsonCli(['sync', '--host', 'dsh', '--pull'], { extraEnv: { UPPMEM_HOME: POOL_DSH } })
    expectCode(res, 0, 'sync pull dsh')
    const row = asArray(expectJson(res, 'sync pull --json'))[0]
    assert.equal(row.ok, true, `dsh pull failed: ${row.error ?? ''}`)
    assert.equal(listEntries({ extraEnv: { UPPMEM_HOME: POOL_DSH } }).length, 0, 'DSH pull must not invent entries')
  })

  // --------------------------------------------------------------------- MCP
  if (!fs.existsSync(MCP_SERVER)) {
    skip('MCP stdio handshake/tools', 'lib/uppmem/mcp-server.mjs not written yet')
    skip('MCP memory_add/memory_search round-trip', 'lib/uppmem/mcp-server.mjs not written yet')
  } else {
    const POOL_MCP = path.join(HOME1, '.uppmem-mcp')
    const mcpEnv = envFor(HOME1, { UPPMEM_HOME: POOL_MCP })

    await check('MCP initialize + tools/list exposes the five memory tools', async () => {
      const session = openMcp(mcpEnv)
      try {
        const init = await session.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'uppmem-selftest', version: '1.0.0' },
        })
        assert.ok(init?.result, `initialize failed: ${truncate(JSON.stringify(init))}`)
        assert.equal(init.result.serverInfo?.name, 'uppmem')
        assert.equal(init.result.protocolVersion, '2024-11-05')
        session.notify('notifications/initialized', {})
        const listed = await session.request('tools/list', {})
        const tools = listed?.result?.tools
        assert.ok(Array.isArray(tools), `tools/list failed: ${truncate(JSON.stringify(listed))}`)
        const names = tools.map((t) => t.name).sort()
        assert.deepEqual(names, ['memory_add', 'memory_get', 'memory_list', 'memory_search', 'memory_stats'])
        for (const tool of tools) {
          assert.ok(tool.description, `${tool.name} needs a description`)
          assert.equal(tool.inputSchema?.type, 'object', `${tool.name} needs an object inputSchema`)
        }
        const add = tools.find((t) => t.name === 'memory_add')
        assert.deepEqual(add.inputSchema.required, ['text'])
      } finally {
        await session.close()
      }
    })

    const MCP_TEXT = 'MCP 记忆往返：优先使用中文回答'

    await check('MCP memory_add -> memory_search/get -> stats round-trip', async () => {
      const session = openMcp(mcpEnv)
      let addedId
      try {
        session.notify('notifications/initialized', {})
        const added = await session.request('tools/call', {
          name: 'memory_add',
          arguments: { text: MCP_TEXT, kind: 'preference', tags: ['mcp', 'test'], key: 'mcp.test' },
        })
        assert.ok(added?.result, `memory_add failed: ${truncate(JSON.stringify(added))}`)
        const addedPayload = parseJson(mcpText(added.result))
        assert.ok(addedPayload && addedPayload.ok === true, `memory_add payload: ${truncate(mcpText(added.result))}`)
        addedId = addedPayload.id
        assert.match(addedId, /^m-[0-9a-f]{12}$/)

        const found = await session.request('tools/call', { name: 'memory_search', arguments: { query: 'MCP 记忆往返' } })
        const foundPayload = parseJson(mcpText(found.result))
        assert.ok(foundPayload?.count >= 1, `search found nothing: ${truncate(mcpText(found.result))}`)
        assert.ok(foundPayload.entries.some((e) => e.text.includes('MCP 记忆往返')), 'search result missing the stored text')

        const got = await session.request('tools/call', { name: 'memory_get', arguments: { ref: addedId } })
        const gotPayload = parseJson(mcpText(got.result))
        assert.equal(gotPayload?.id, addedId)
        assert.ok(gotPayload.text.includes('MCP 记忆往返'))

        const stats = await session.request('tools/call', { name: 'memory_stats', arguments: {} })
        const statsPayload = parseJson(mcpText(stats.result))
        assert.ok(statsPayload && statsPayload.entries >= 1, 'memory_stats should report the entry')
      } finally {
        await session.close()
      }
      // the CLI must see the entry the MCP server wrote (same pool)
      const rows = listEntries({ extraEnv: { UPPMEM_HOME: POOL_MCP } })
      assert.ok(rows.some((e) => e.id === addedId), 'CLI cannot see the entry added over MCP')
    })
  }
}

// ------------------------------------------------------- minimal MCP client
function mcpText(result) {
  const content = result?.content ?? []
  return content
    .filter((part) => part && part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function openMcp(env) {
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    cwd: TMP,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (buf) => {
    stderr += buf.toString('utf8')
  })
  const pending = new Map()
  let nextId = 1
  let closed = false

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const msg = parseJson(trimmed)
    if (!msg || msg.id === undefined || msg.id === null) return
    const waiter = pending.get(msg.id)
    if (waiter) {
      pending.delete(msg.id)
      waiter(msg)
    }
  })

  const failAll = (why) => {
    if (closed) return
    closed = true
    for (const [, waiter] of pending) waiter({ __error: why })
    pending.clear()
  }
  child.on('exit', (code) => failAll(`MCP server exited with code ${code}\nstderr:\n${truncate(stderr)}`))
  child.on('error', (err) => failAll(`MCP server failed to start: ${err.message}`))

  return {
    request(method, params) {
      const id = nextId
      nextId += 1
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`MCP request ${method} timed out after 15s\nstderr:\n${truncate(stderr)}`))
        }, 15_000)
        if (timer.unref) timer.unref()
        pending.set(id, (msg) => {
          clearTimeout(timer)
          if (msg && msg.__error) reject(new Error(msg.__error))
          else resolve(msg)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    async close() {
      try {
        child.stdin.end()
      } catch {
        /* already gone */
      }
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }, 3000)
        if (timer.unref) timer.unref()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
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
  `\nuppmem: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''} (${total} checks, ${seconds}s)\n`,
)
process.exitCode = failed ? 1 : 0
