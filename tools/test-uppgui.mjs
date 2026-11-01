#!/usr/bin/env node
/**
 * uppgui acceptance suite — headless checks for the local GUI + agent bridge.
 *
 * Covers five surfaces without a browser:
 *   1. static  — every lib/uppgui/*.mjs parses, the CLI parses, ui/index.html is
 *                wired to /app.js + /style.css, ui/app.js parses and mentions
 *                every action id from the catalog;
 *   2. catalog — GROUPS/ACTIONS invariants (ids, groups, titles, arg types,
 *                danger flags for destructive ids);
 *   3. HTTP    — real `uppgui serve` child on 127.0.0.1: ping/catalog/status,
 *                mem.add -> mem.list -> mem.search round-trip, tool.list,
 *                unknown action + missing-arg errors, token mode (401/200),
 *                brief truncation (10 items) vs {full:true}, /api/log seq order;
 *   4. MCP     — real `uppgui mcp` child: initialize 2024-11-05, exactly two
 *                tools, tools/list < 4096 bytes, upp_catalog + upp_action;
 *   5. package — `build-gui --skip-sea` payload.zip entries (server, upp, manifest)
 *   plus a per-action smoke pass with dry-run-safe params for the whole catalog.
 *
 * Everything (HOME, UPPMEM_HOME, UPPTOOL_HOME, UPPENV_HOME, DSH_HOME, UPPGUI_HOME,
 * the temp dist dir) lives under os.tmpdir(), so the real user config is never
 * read or written. Spawned children get an explicit fake env; the suite also
 * redirects its own process.env before importing actions.mjs.
 *
 *   node tools/test-uppgui.mjs
 *
 * Prints PASS/FAIL/SKIP lines, a summary and measured token-budget numbers;
 * exits 1 when anything FAILed.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const GUI_DIR = path.join(ROOT, 'lib', 'uppgui')
const UI_DIR = path.join(GUI_DIR, 'ui')
const ACTIONS_FILE = path.join(GUI_DIR, 'actions.mjs')
const CLI = path.join(ROOT, 'tools', 'uppgui.mjs')
const BUILDER = path.join(ROOT, 'tools', 'build-gui.mjs')
const ARCHIVE_FILE = path.join(ROOT, 'lib', 'uppenv', 'core', 'archive.mjs')

const CHILD_TIMEOUT_MS = 120_000
const WATCHDOG_MS = 120_000

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uppgui-selftest-'))
const HOME1 = path.join(TMP, 'home-1')
const HOME2 = path.join(TMP, 'home-2')
const FIX = path.join(TMP, 'fixtures')
const DIST = path.join(TMP, 'dist')

const ID_RE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9.-]*$/
const ID_RE_ANY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9.-]*)?$/
// Bare (non-namespaced) ids are only the overview singletons status/doctor
// (CONTRACT.md §1); every other id must be namespaced `group.action`.
const BARE_IDS = new Set(['status', 'doctor'])
const ARG_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object'])
const DESTRUCTIVE_SUFFIXES = ['.rm', '.rollback', '.import', '.pack', '.install', '.uninstall']
// CONTRACT §1 danger rule. `migrate.pack` ends with `.pack` but only writes a NEW
// image file and never mutates a host, so it is the single documented exemption
// (§1 allowlist). `migrate.apply` mutates hosts yet has no destructive suffix, so
// it is required-danger by id.
const DANGER_EXEMPT = new Set(['migrate.pack'])
const DANGER_REQUIRED = new Set(['migrate.apply'])
const EXPECTED_ACTION_COUNT = 36
const EXPECTED_GROUP_IDS = ['overview', 'memory', 'tools', 'env', 'migrate', 'plugin']
const BRIEF_MAX_ITEMS = 10
const TOOLS_LIST_BUDGET = 4096

let passed = 0
let failed = 0
let skipped = 0
const startedAt = Date.now()
const METRICS = {}
const liveServers = new Set()

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
    const note = await fn()
    pass(note ? `${label} [${note}]` : label)
  } catch (err) {
    fail(label, err && err.stack ? err.message ?? String(err) : String(err))
  }
}

// ------------------------------------------------------------------- helpers
function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function truncate(text, max = 1600) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s
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

/** Full fake machine for a child process: no real host/config dir is reachable. */
function envFor(home, extra = {}) {
  const h = path.resolve(home)
  const root = path.parse(h).root
  return {
    ...process.env,
    USERPROFILE: h,
    HOME: h,
    HOMEDRIVE: root.replace(/[\\/]+$/, ''),
    HOMEPATH: h.slice(root.length - 1),
    DSH_HOME: path.join(h, '.dsh'),
    UPPENV_HOME: path.join(h, '.uppenv'),
    UPPTOOL_HOME: path.join(h, '.upptool'),
    UPPMEM_HOME: path.join(h, '.uppmem'),
    UPPGUI_HOME: path.join(h, '.uppgui'),
    WORKBUDDY_HOME: path.join(h, '.workbuddy'),
    CODEBUDDY_HOME: path.join(h, '.codebuddy'),
    ACCIO_HOME: path.join(h, '.accio'),
    NO_COLOR: '1',
    ...extra,
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Deterministic fingerprint of a directory tree: paths, sizes and content hashes. */
function treeFingerprint(dir) {
  const root = path.resolve(dir)
  const rows = []
  const walk = (current) => {
    if (!fs.existsSync(current)) return
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) walk(full)
      else rows.push(`${path.relative(root, full).replace(/\\/g, '/')}\t${stat.size}\t${sha256File(full)}`)
    }
  }
  walk(root)
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex')
}

function findPort(msg, depth = 0) {
  if (!msg || typeof msg !== 'object' || depth > 5) return null
  if (typeof msg.port === 'number' && Number.isFinite(msg.port) && msg.port > 0) return msg.port
  if (typeof msg.url === 'string') {
    try {
      const parsed = new URL(msg.url)
      if (parsed.port) return Number(parsed.port)
    } catch {
      /* not a URL */
    }
  }
  for (const value of Object.values(msg)) {
    const found = findPort(value, depth + 1)
    if (found) return found
  }
  return null
}

function findToken(msg, depth = 0) {
  if (!msg || typeof msg !== 'object' || depth > 5) return null
  for (const key of ['token', 'authToken', 'accessToken']) {
    if (typeof msg[key] === 'string' && msg[key].length >= 8) return msg[key]
  }
  for (const value of Object.values(msg)) {
    const found = findToken(value, depth + 1)
    if (found) return found
  }
  return null
}

function tokenFromText(text) {
  const byQuery = String(text).match(/[?&]token=([A-Za-z0-9._~-]{8,})/)
  if (byQuery) return byQuery[1]
  const byWord = String(text).match(/token["'\s:=]+([A-Za-z0-9._~-]{8,})/i)
  return byWord ? byWord[1] : null
}

async function http(base, route, { method = 'GET', body, token, timeoutMs = 20_000 } = {}) {
  const headers = {}
  if (token) headers['x-upp-token'] = token
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  return {
    status: res.status,
    text,
    bytes: Buffer.byteLength(text),
    contentType: res.headers.get('content-type') ?? '',
    json: parseJson(text),
  }
}

/** Spawn `uppgui serve ...`; resolves once a JSON line containing the port arrived. */
async function startServer(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: TMP,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const handle = {
    child,
    port: 0,
    base: null,
    token: null,
    stdoutText: '',
    stderrText: '',
    stop: async () => {},
  }
  child.stderr.on('data', (buf) => {
    handle.stderrText += buf.toString('utf8')
  })

  let rl = null
  let startup
  try {
    startup = await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settle(new Error(`serve printed no port within 25s\nstdout:\n${truncate(handle.stdoutText)}\nstderr:\n${truncate(handle.stderrText)}`))
      }, 25_000)
      if (timer.unref) timer.unref()
      const settle = (err, info) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve(info)
      }
      rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => {
        handle.stdoutText += `${line}\n`
        const msg = parseJson(line)
        if (!msg) return
        const port = findPort(msg)
        if (port) settle(null, { msg, port })
      })
      child.once('exit', (code) =>
        settle(new Error(`serve exited early (code=${code})\nstdout:\n${truncate(handle.stdoutText)}\nstderr:\n${truncate(handle.stderrText)}`)),
      )
      child.once('error', (err) => settle(err))
    })
  } catch (err) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    try {
      if (rl) rl.close()
    } catch {
      /* ignore */
    }
    throw err
  }

  handle.port = startup.port
  handle.base = `http://127.0.0.1:${startup.port}`
  handle.token = findToken(startup.msg) ?? tokenFromText(handle.stdoutText)
  handle.stop = async () => {
    liveServers.delete(handle)
    try {
      if (rl) rl.close()
    } catch {
      /* ignore */
    }
    if (child.exitCode !== null) return
    child.kill()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        resolve()
      }, 3000)
      if (timer.unref) timer.unref()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  liveServers.add(handle)
  return handle
}

function nodeCheck(file) {
  return spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
}

/**
 * node --check a file; if it fails, retry a `.mjs` copy so a browser script that
 * is written as an ES module still counts as "parses". Returns null or a message.
 */
function parseFile(file) {
  let res = nodeCheck(file)
  if (res.status === 0) return null
  const alt = path.join(TMP, 'check', `${path.basename(file, path.extname(file))}-check.mjs`)
  try {
    fs.mkdirSync(path.dirname(alt), { recursive: true })
    fs.copyFileSync(file, alt)
    res = nodeCheck(alt)
    if (res.status === 0) return null
  } catch {
    /* fall through to the original error */
  }
  const detail = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
  return `${path.basename(file)} does not parse: ${detail || `node --check exit ${res.status}`}`
}

/** Longest array in the payload — the action envelope wraps rows under data.* */
function rowsOf(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return null
  let best = null
  for (const item of Object.values(value)) {
    if (Array.isArray(item) && (!best || item.length > best.length)) best = item
  }
  return best
}

function envelopeRows(json) {
  return rowsOf(json?.data) ?? rowsOf(json) ?? []
}

function isTruncated(json) {
  return json?.truncated === true || json?.data?.truncated === true
}

function hasStack(text) {
  return /\n\s+at\s|Error:\s*\n\s+at\s/.test(String(text ?? ''))
}

// ------------------------------------------------------------- MCP mini-client
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
          reject(new Error(`MCP request ${method} timed out after 20s\nstderr:\n${truncate(stderr)}`))
        }, 20_000)
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

// --------------------------------------------------------------- smoke params
// Every value stays inside TMP or points at something that cannot exist, so the
// smoke pass exercises each action's envelope without mutating a real machine.
const SAFE_PARAMS = {
  status: {},
  doctor: { timeoutMs: 5000 },
  'mem.list': {},
  'mem.search': { query: 'gui smoke' },
  'mem.get': { ref: 'gui-smoke-missing' },
  'mem.add': { text: 'gui smoke entry', kind: 'fact', key: 'gui.smoke' },
  'mem.update': { ref: 'test.gui', text: 'gui 测试条目' },
  'mem.rm': { ref: 'gui-smoke-missing' },
  'mem.stats': {},
  'mem.sync': { hosts: ['dsh'], direction: 'both', dryRun: true },
  'mem.install': { hosts: ['dsh'], dryRun: true },
  'mem.hosts': {},
  'tool.list': {},
  'tool.show': { id: 'gui-smoke-missing' },
  'tool.suggest': { text: 'convert a table to csv' },
  'tool.run': { id: 'gui-smoke-missing' },
  'tool.add': { path: path.join(FIX, 'gui-smoke-nonexistent.mjs'), name: 'gui-smoke' },
  'tool.stats': {},
  'env.scan': {},
  'env.export': { out: path.join(TMP, 'gui-smoke.uppenv'), probeTools: false },
  'env.import': { file: path.join(TMP, 'gui-smoke-missing.uppenv'), dryRun: true, yes: true },
  'env.verify': { file: path.join(TMP, 'gui-smoke-missing.uppenv') },
  'env.inspect': { file: path.join(TMP, 'gui-smoke-missing.uppenv') },
  'env.rollback': { tx: 'gui-smoke-missing' },
  'env.tools': {},
  'migrate.plan': { hosts: ['workbuddy'], kinds: ['skill'] },
  'migrate.pack': {
    out: path.join(TMP, 'gui-smoke-migrate.uppenv'),
    hosts: ['workbuddy'],
    kinds: ['skill'],
    probeTools: false,
    force: true,
  },
  'migrate.card': { file: path.join(TMP, 'gui-smoke-missing.uppenv') },
  'migrate.preview': { file: path.join(TMP, 'gui-smoke-missing.uppenv') },
  'migrate.apply': { file: path.join(TMP, 'gui-smoke-missing.uppenv') },
  'plugin.detect': {},
  'plugin.init': { id: 'gui-smoke-plugin', dir: path.join(TMP, 'gui-smoke-plugin') },
  'plugin.validate': { pkg: path.join(TMP, 'gui-smoke-missing-pkg') },
  'plugin.verify': { pkg: path.join(TMP, 'gui-smoke-missing-pkg') },
  'plugin.pack': { pkg: path.join(TMP, 'gui-smoke-missing-pkg') },
  'plugin.install': { from: path.join(TMP, 'gui-smoke-missing.upp') },
}

// Actions with no headless-safe invocation at all (skipped, never silently failed).
const SMOKE_SKIPS = {
  // none at the moment: every catalog action can be exercised with a fake HOME.
}

const watchdog = setTimeout(() => {
  process.stdout.write('FAIL suite watchdog: uppgui tests exceeded 120s\n')
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref()

// ------------------------------------------------------------------ fixtures
fs.mkdirSync(FIX, { recursive: true })
fs.mkdirSync(HOME1, { recursive: true })
fs.mkdirSync(HOME2, { recursive: true })

// Redirect this process too, before importing actions.mjs, so an import-time
// read can never resolve to the real user dirs.
{
  const fake = envFor(HOME1)
  for (const key of [
    'USERPROFILE',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'DSH_HOME',
    'UPPENV_HOME',
    'UPPTOOL_HOME',
    'UPPMEM_HOME',
    'UPPGUI_HOME',
    'WORKBUDDY_HOME',
    'CODEBUDDY_HOME',
    'ACCIO_HOME',
  ]) {
    process.env[key] = fake[key]
  }
}

// ==========================================================================
// main
// ==========================================================================
async function main() {
  if (!fs.existsSync(CLI)) {
    skip('uppgui suite', `tools/uppgui.mjs not written yet (${rel(CLI)})`)
    return
  }

  // ------------------------------------------------------------------ static
  let mod = null
  await check('static: actions.mjs exports GROUPS / ACTIONS / runAction / catalog', async () => {
    assert.ok(fs.existsSync(ACTIONS_FILE), `missing ${rel(ACTIONS_FILE)}`)
    mod = await import(pathToFileURL(ACTIONS_FILE).href)
    assert.ok(Array.isArray(mod.GROUPS), 'GROUPS must be an array')
    assert.deepEqual(
      mod.GROUPS.map((group) => group.id),
      EXPECTED_GROUP_IDS,
      'GROUPS ids/order drifted from CONTRACT (overview,memory,tools,env,migrate,plugin)',
    )
    for (const group of mod.GROUPS) {
      assert.equal(typeof group.id, 'string', 'every group needs a string id')
      assert.equal(typeof group.title, 'string', `group ${group.id} needs a title`)
    }
    assert.equal(typeof mod.ACTIONS, 'object', 'ACTIONS must be an object')
    assert.equal(
      Object.keys(mod.ACTIONS).length,
      EXPECTED_ACTION_COUNT,
      `catalog must expose ${EXPECTED_ACTION_COUNT} actions, got ${Object.keys(mod.ACTIONS).length}`,
    )
    assert.equal(typeof mod.runAction, 'function', 'runAction must be exported')
    assert.equal(typeof mod.catalog, 'function', 'catalog must be exported')
    assert.equal(typeof mod.createContext, 'function', 'createContext must be exported')
    catalogActions = mod.ACTIONS
  })

  await check('static: node --check every lib/uppgui/*.mjs', async () => {
    const files = fs
      .readdirSync(GUI_DIR)
      .filter((name) => name.endsWith('.mjs'))
      .sort()
    for (const required of ['actions.mjs', 'server.mjs', 'mcp.mjs']) {
      assert.ok(files.includes(required), `missing lib/uppgui/${required}`)
    }
    for (const name of files) {
      const problem = parseFile(path.join(GUI_DIR, name))
      assert.equal(problem, null, problem ?? '')
    }
    return files.join(', ')
  })

  await check('static: node --check tools/uppgui.mjs', async () => {
    assert.ok(fs.existsSync(CLI), `missing ${rel(CLI)}`)
    const problem = parseFile(CLI)
    assert.equal(problem, null, problem ?? '')
  })

  await check('static: ui/index.html references /app.js and /style.css', async () => {
    const html = path.join(UI_DIR, 'index.html')
    assert.ok(fs.existsSync(html), `missing ${rel(html)}`)
    const text = fs.readFileSync(html, 'utf8')
    assert.ok(text.includes('/app.js'), 'index.html does not load /app.js')
    assert.ok(text.includes('/style.css'), 'index.html does not load /style.css')
    for (const asset of ['app.js', 'style.css']) {
      assert.ok(fs.existsSync(path.join(UI_DIR, asset)), `missing ${rel(path.join(UI_DIR, asset))}`)
    }
  })

  await check('static: ui/app.js parses', async () => {
    const app = path.join(UI_DIR, 'app.js')
    assert.ok(fs.existsSync(app), `missing ${rel(app)}`)
    const problem = parseFile(app)
    assert.equal(problem, null, problem ?? '')
  })

  if (mod) {
    await check('static: ui/app.js mentions every catalog action id', async () => {
      const app = path.join(UI_DIR, 'app.js')
      assert.ok(fs.existsSync(app), `missing ${rel(app)}`)
      const text = fs.readFileSync(app, 'utf8')
      const ids = Object.keys(mod.ACTIONS)
      assert.ok(ids.length > 0, 'catalog has no actions')
      const missing = ids.filter((id) => !text.includes(id))
      assert.deepEqual(missing, [], `ui/app.js does not mention ${missing.length} action id(s)`)
      return `${ids.length} ids`
    })

    await check('static: ui/app.js only passes declared action params', async () => {
      const app = path.join(UI_DIR, 'app.js')
      assert.ok(fs.existsSync(app), `missing ${rel(app)}`)
      const text = fs.readFileSync(app, 'utf8')
      // Literal `call('<id>', { a, b: x })` sites only; dynamic ids/objects are skipped.
      const CALL_RE = /\bcall\(\s*'([a-z][a-z0-9]*(?:\.[a-z][a-z0-9.-]*)?)'\s*(?:,\s*\{([^{}]*)\})?/g
      const problems = []
      let match
      while ((match = CALL_RE.exec(text))) {
        const [, id, body] = match
        const action = mod.ACTIONS[id]
        if (!action) {
          problems.push(`${id}: unknown action id`)
          continue
        }
        if (body === undefined) continue
        const allowed = new Set([...Object.keys(action.args ?? {}), 'full'])
        for (const segment of body.split(',')) {
          const trimmed = segment.trim()
          if (!trimmed || trimmed.startsWith('...')) continue
          const key = trimmed.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/)?.[1]
          if (key && !allowed.has(key)) {
            problems.push(`${id}: param "${key}" is not declared (allowed: ${[...allowed].join(', ')})`)
          }
        }
      }
      assert.deepEqual(problems, [], `ui/app.js sends params the action layer rejects:\n${problems.join('\n')}`)
    })
  } else {
    skip('static: ui/app.js mentions every catalog action id', 'actions.mjs failed to load')
    skip('static: ui/app.js only passes declared action params', 'actions.mjs failed to load')
  }

  // --------------------------------------------------------- catalog invariants
  if (mod) {
    await check('catalog: ids are group.action, bare only status/doctor (CONTRACT §1)', async () => {
      for (const id of Object.keys(mod.ACTIONS)) {
        assert.match(id, ID_RE_ANY, `bad action id: ${id}`)
        if (!id.includes('.')) {
          assert.ok(BARE_IDS.has(id), `bare id ${id} is not one of the overview singletons (status/doctor)`)
        } else {
          assert.match(id, ID_RE, `bad namespaced action id: ${id}`)
        }
      }
      return `${Object.keys(mod.ACTIONS).length} ids`
    })

    await check('catalog: every action has a known group, title and summary', async () => {
      const groups = new Set(mod.GROUPS.map((g) => g.id))
      for (const [id, action] of Object.entries(mod.ACTIONS)) {
        assert.ok(groups.has(action.group), `${id}: unknown group ${JSON.stringify(action.group)}`)
        assert.equal(typeof action.title, 'string', `${id}: title missing`)
        assert.ok(action.title.length > 0, `${id}: empty title`)
        assert.equal(typeof action.summary, 'string', `${id}: summary missing`)
        assert.ok(action.summary.length > 0, `${id}: empty summary`)
        assert.equal(typeof action.run, 'function', `${id}: run must be a function`)
      }
      return `${Object.keys(mod.ACTIONS).length} actions / ${mod.GROUPS.length} groups`
    })

    await check('catalog: arg schemas use string|number|boolean|array|object', async () => {
      let argCount = 0
      for (const [id, action] of Object.entries(mod.ACTIONS)) {
        assert.ok(action.args && typeof action.args === 'object' && !Array.isArray(action.args), `${id}: args must be an object`)
        for (const [name, spec] of Object.entries(action.args)) {
          argCount += 1
          assert.ok(spec && typeof spec === 'object', `${id}.${name}: arg spec must be an object`)
          assert.ok(ARG_TYPES.has(spec.type), `${id}.${name}: bad type ${JSON.stringify(spec.type)}`)
          if (spec.required !== undefined) assert.equal(typeof spec.required, 'boolean', `${id}.${name}: required must be boolean`)
        }
      }
      return `${argCount} args`
    })

    await check('catalog: danger flags (suffix rule + migrate.pack exemption)', async () => {
      const destructive = Object.entries(mod.ACTIONS).filter(
        ([id]) => DESTRUCTIVE_SUFFIXES.some((suffix) => id.endsWith(suffix)) && !DANGER_EXEMPT.has(id),
      )
      assert.ok(destructive.length >= 3, `expected several destructive actions, got ${destructive.map(([id]) => id).join(',')}`)
      for (const [id, action] of destructive) {
        assert.equal(action.danger, true, `${id} is destructive but danger !== true`)
      }
      for (const id of DANGER_REQUIRED) {
        assert.ok(mod.ACTIONS[id], `required-danger action ${id} is missing`)
        assert.equal(mod.ACTIONS[id].danger, true, `${id} mutates hosts but danger !== true`)
      }
      for (const id of DANGER_EXEMPT) {
        assert.ok(mod.ACTIONS[id], `danger allowlist references unknown action ${id}`)
        assert.equal(mod.ACTIONS[id].danger, false, `${id} is allowlisted non-destructive but danger !== false`)
      }
      for (const id of ['migrate.plan', 'migrate.card', 'migrate.preview']) {
        assert.equal(mod.ACTIONS[id]?.danger, false, `${id} must stay read-only (danger:false)`)
      }
      return [...destructive.map(([id]) => id), ...DANGER_REQUIRED].join(', ')
    })

    await check('catalog(): grouped terse catalog covers every action', async () => {
      const grouped = mod.catalog()
      assert.ok(Array.isArray(grouped), 'catalog() must return an array of groups')
      assert.deepEqual(grouped.map((group) => group.id), EXPECTED_GROUP_IDS, 'catalog() group ids/order drifted')
      const seen = []
      for (const group of grouped) {
        assert.equal(typeof group.id, 'string', 'group.id missing')
        assert.equal(typeof group.title, 'string', `group ${group.id}: title missing`)
        assert.ok(Array.isArray(group.actions), `group ${group.id}: actions must be an array`)
        for (const action of group.actions) {
          seen.push(action.id)
          assert.equal(typeof action.id, 'string', 'action.id missing')
          assert.ok(Array.isArray(action.args) || typeof action.args === 'object', `${action.id}: args must be listed`)
        }
      }
      assert.deepEqual([...seen].sort(), Object.keys(mod.ACTIONS).sort(), 'catalog() must cover every action exactly once')
      METRICS.actionCount = seen.length
      return `${seen.length} actions / ${grouped.length} groups`
    })
  } else {
    for (const label of [
      'catalog: ids are group.action, bare only status/doctor (CONTRACT §1)',
      'catalog: every action has a known group, title and summary',
      'catalog: arg schemas use string|number|boolean|array|object',
      'catalog: danger flags (suffix rule + migrate.pack exemption)',
      'catalog(): grouped terse catalog covers every action',
    ]) {
      skip(label, 'actions.mjs failed to load')
    }
  }

  // ------------------------------------------------------- migrate (v1.5.0)
  // The 换机 wizard: plan -> pack -> card -> preview -> apply. Everything runs on a
  // throwaway HOME under TMP; `apply` is never invoked against real hosts (it only
  // appears in the smoke table with a nonexistent image).
  if (mod) {
    const MIG_HOME = path.join(TMP, 'home-migrate')
    const MIG_OUT = path.join(TMP, 'migrate')
    const migEnv = envFor(MIG_HOME)
    const migCtx = mod.createContext({
      payloadDir: ROOT,
      mode: 'dev',
      env: migEnv,
      log: () => {},
      version: mod.TOOL.version,
    })
    const skillDir = path.join(MIG_HOME, '.workbuddy', 'skills', 'demo-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: gui selftest skill\n---\n# demo skill\n',
    )
    fs.mkdirSync(MIG_OUT, { recursive: true })
    const image = path.join(MIG_OUT, 'gui-migrate.uppenv')

    await check('migrate.plan: 5-step wizard, 5 default kinds, 3 hosts', async () => {
      const res = await mod.runAction('migrate.plan', { hosts: ['workbuddy'], kinds: ['skill'] }, migCtx)
      assert.equal(res.ok, true, `envelope not ok: ${JSON.stringify(res).slice(0, 400)}`)
      const plan = res.data
      assert.equal(plan.code, 0, `uppenv plan exited ${plan.code}: ${String(plan.stderr ?? '').slice(0, 300)}`)
      assert.equal(plan.steps.length, 5, `wizard needs 5 steps, got ${plan.steps.length}`)
      assert.deepEqual(
        plan.steps.map((step) => step.n),
        [1, 2, 3, 4, 5],
        'wizard steps out of order',
      )
      assert.equal(plan.defaults.kinds.length, 5, `defaults.kinds: ${JSON.stringify(plan.defaults.kinds)}`)
      assert.equal(plan.defaults.hosts.length, 3, `defaults.hosts: ${JSON.stringify(plan.defaults.hosts)}`)
      assert.equal(plan.hosts.length, 3, `plan.hosts: ${JSON.stringify(plan.hosts)}`)
      return `${plan.total} assets / ${plan.hosts.length} hosts`
    })

    await check('migrate.pack: writes the image and a matching handoff card', async () => {
      const res = await mod.runAction(
        'migrate.pack',
        { out: image, hosts: ['workbuddy'], kinds: ['skill'], probeTools: false, force: true },
        migCtx,
      )
      assert.equal(res.ok, true, `envelope not ok: ${JSON.stringify(res).slice(0, 400)}`)
      assert.equal(res.data.code, 0, `pack exited ${res.data.code}: ${String(res.data.stderr ?? '').slice(0, 300)}`)
      assert.ok(fs.existsSync(image), `pack did not write ${rel(image)}`)
      assert.equal(res.data.handoff.sizeBytes, fs.statSync(image).size, 'handoff.sizeBytes !== file size')
      assert.equal(res.data.handoff.sha256, sha256File(image), 'handoff.sha256 !== sha256(file)')
      assert.equal(res.data.signature.signed, false, 'unsigned pack must report signature.signed=false')
      return `${res.data.handoff.sizeBytes} B / ${res.data.handoff.sha256.slice(0, 12)}…`
    })

    await check('migrate.card: healthy unsigned image verifies', async () => {
      const res = await mod.runAction('migrate.card', { file: image }, migCtx)
      assert.equal(res.ok, true)
      assert.equal(res.data.valid, true, `card problems: ${JSON.stringify(res.data.problems)}`)
      assert.deepEqual(res.data.problems, [], 'healthy image must have no problems')
      assert.equal(res.data.sha256, sha256File(image), 'card.sha256 !== sha256(file)')
      assert.equal(res.data.signature.signed, false, 'unsigned image must report signed:false')
      assert.ok(res.data.total >= 1, `card.total: ${res.data.total}`)
      return `${res.data.total} assets`
    })

    await check('migrate.preview: dry-run, zero writes, counts sum to total', async () => {
      const before = treeFingerprint(MIG_HOME)
      const res = await mod.runAction('migrate.preview', { file: image, hosts: ['workbuddy'], kinds: ['skill'] }, migCtx)
      assert.equal(res.ok, true)
      assert.equal(res.data.dryRun, true, 'preview must be a dry run')
      const sum = Object.values(res.data.counts).reduce((acc, n) => acc + n, 0)
      assert.equal(sum, res.data.total, `counts sum ${sum} !== total ${res.data.total}`)
      const after = treeFingerprint(MIG_HOME)
      assert.equal(after, before, 'preview wrote into the fake home (zero-write contract broken)')
      return `${res.data.total} rows / counts=${JSON.stringify(res.data.counts)}`
    })

    await check('migrate.card: tampered payload is rejected with problems', async () => {
      const { readZip, writeZip } = await import(pathToFileURL(ARCHIVE_FILE).href)
      const entries = readZip(image)
      const asset = entries.find((entry) => /^payload\/.*\/files\/SKILL\.md$/.test(String(entry.name)))
      assert.ok(asset, `no payload file inside ${rel(image)}: ${entries.map((entry) => entry.name).join(', ')}`)
      const bad = path.join(MIG_OUT, 'gui-migrate-tampered.uppenv')
      writeZip(
        bad,
        entries.map((entry) =>
          entry === asset
            ? { name: entry.name, data: Buffer.concat([entry.data, Buffer.from('\n<!-- tampered -->\n')]) }
            : entry,
        ),
      )
      const res = await mod.runAction('migrate.card', { file: bad }, migCtx)
      assert.equal(res.ok, true, 'card must answer with an envelope even for a bad image')
      assert.equal(res.data.valid, false, 'tampered image must be rejected')
      assert.ok(Array.isArray(res.data.problems) && res.data.problems.length > 0, 'tampered image needs non-empty problems')
      assert.equal(typeof res.data.hint, 'string', 'a bad image should carry a hint')
      return `${res.data.problems.length} problems: ${res.data.problems[0]}`
    })

    await check('migrate.card: appended bytes are rejected (canonical layout)', async () => {
      const copy = path.join(MIG_OUT, 'gui-migrate-appended.uppenv')
      fs.copyFileSync(image, copy)
      fs.appendFileSync(copy, Buffer.from('garbage'.repeat(8)))
      const res = await mod.runAction('migrate.card', { file: copy }, migCtx)
      assert.equal(res.ok, true, 'card must answer with an envelope even for an appended image')
      assert.equal(res.data.valid, false, 'an image with trailing bytes must be rejected')
      const problems = Array.isArray(res.data.problems) ? res.data.problems : []
      const trailing = problems.find((problem) => /trailing data/i.test(String(problem)))
      assert.ok(trailing, `expected a /trailing data/ problem, got ${JSON.stringify(problems)}`)
      assert.equal(typeof res.data.hint, 'string', 'a bad image should carry a hint')
      return `${problems.length} problems: ${trailing}`
    })
  } else {
    for (const label of [
      'migrate.plan: 5-step wizard, 5 default kinds, 3 hosts',
      'migrate.pack: writes the image and a matching handoff card',
      'migrate.card: healthy unsigned image verifies',
      'migrate.preview: dry-run, zero writes, counts sum to total',
      'migrate.card: tampered payload is rejected with problems',
      'migrate.card: appended bytes are rejected (canonical layout)',
    ]) {
      skip(label, 'actions.mjs failed to load')
    }
  }

  // -------------------------------------------------------------------- CLI
  await check('CLI: `action status --json` exits 0 with dsh/workbuddy/accio rows', async () => {
    const res = spawnSync(process.execPath, [CLI, 'action', 'status', '--json'], {
      cwd: TMP,
      env: envFor(HOME1),
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      windowsHide: true,
    })
    assert.equal(res.status, 0, `exit ${res.status}\nstderr:\n${truncate(res.stderr, 1200)}`)
    const payload = parseJson(res.stdout)
    assert.ok(payload && payload.ok === true, `envelope not ok: ${truncate(res.stdout)}`)
    assert.equal(payload.action, 'status')
    const hosts = payload.data?.hosts
    assert.ok(Array.isArray(hosts), `data.hosts missing: ${truncate(res.stdout, 800)}`)
    assert.deepEqual(
      hosts.map((row) => row.host).sort(),
      ['accio', 'dsh', 'workbuddy'],
      `unexpected host rows: ${JSON.stringify(hosts.map((row) => row.host))}`,
    )
    for (const row of hosts) {
      // available depends on the real machine (fake HOME => false); shape is what we pin here.
      assert.equal(typeof row.available, 'boolean', `host ${row.host}: available must be boolean`)
    }
    return `${hosts.length} hosts`
  })

  // -------------------------------------------------------------------- HTTP
  let server = null
  await check('HTTP: serve --port 0 --no-open --no-auth --json prints a port', async () => {
    server = await startServer(['serve', '--port', '0', '--no-open', '--no-auth', '--json'], envFor(HOME1))
    assert.ok(server.port > 0, 'no port parsed from the startup JSON')
    assert.equal(server.base, `http://127.0.0.1:${server.port}`)
    return `127.0.0.1:${server.port}`
  })

  if (!server) {
    for (const label of [
      'HTTP: GET /api/ping',
      'HTTP: GET /api/catalog',
      'HTTP: GET /api/status',
      'HTTP: GET / serves index.html',
      'HTTP: mem.add -> mem.list -> mem.search round-trip',
      'HTTP: tool.list on a fake UPPTOOL_HOME',
      'HTTP: unknown action -> ok:false with hint',
      'HTTP: mem.search missing required arg -> ok:false',
      'HTTP: brief cap (10 rows + truncated:true)',
      'HTTP: full:true expands the brief cap',
      'HTTP: /api/log events have increasing seq',
      'HTTP: token mode ping is public and reports auth flags',
      'HTTP: token mode API is 401 without token / 200 with token',
      'HTTP: token mode static shell is public (blank-page guard)',
    ]) {
      skip(label, 'serve did not start')
    }
    await smokeAll()
  } else {
    try {
      await check('HTTP: GET /api/ping', async () => {
        const res = await http(server.base, '/api/ping')
        assert.equal(res.status, 200)
        assert.equal(res.json?.ok, true, `ping not ok: ${truncate(res.text)}`)
        assert.equal(res.json?.app, 'uppgui')
        assert.equal(typeof res.json?.version, 'string')
        assert.equal(typeof res.json?.actionCount, 'number')
        assert.equal(res.json?.noAuth, true, '--no-auth ping must report noAuth:true')
        assert.equal(res.json?.tokenRequired, false, '--no-auth ping must report tokenRequired:false')
        METRICS.pingBytes = res.bytes
        return `${res.bytes} B`
      })

      await check('HTTP: GET /api/catalog', async () => {
        const res = await http(server.base, '/api/catalog')
        assert.equal(res.status, 200)
        assert.equal(res.json?.ok, true, `catalog not ok: ${truncate(res.text)}`)
        const groups = res.json?.groups
        assert.ok(
          Array.isArray(groups) && groups.length === EXPECTED_GROUP_IDS.length,
          `catalog groups: ${Array.isArray(groups) ? groups.length : 'missing'} (expected ${EXPECTED_GROUP_IDS.length})`,
        )
        assert.deepEqual(groups.map((group) => group.id), EXPECTED_GROUP_IDS, 'HTTP catalog group order drifted')
        const total = groups.reduce((acc, group) => acc + (group.actions?.length ?? 0), 0)
        if (mod) assert.equal(total, Object.keys(mod.ACTIONS).length, 'HTTP catalog must list every action')
        METRICS.catalogHttpBytes = res.bytes
        return `${groups.length} groups / ${total} actions / ${res.bytes} B`
      })

      await check('HTTP: GET /api/status', async () => {
        const res = await http(server.base, '/api/status')
        assert.equal(res.status, 200)
        assert.equal(res.json?.ok, true, `status not ok: ${truncate(res.text)}`)
        assert.equal(res.json?.action, 'status')
        return `${res.bytes} B`
      })

      await check('HTTP: GET / serves index.html', async () => {
        const res = await http(server.base, '/')
        assert.equal(res.status, 200, `GET / -> ${res.status}`)
        assert.match(res.contentType, /text\/html/i, `content-type: ${res.contentType}`)
        assert.ok(res.text.includes('app.js'), 'served HTML does not reference app.js')
        const css = await http(server.base, '/style.css')
        assert.equal(css.status, 200, `GET /style.css -> ${css.status}`)
        assert.match(css.contentType, /text\/css/i)
      })

      await check('HTTP: mem.add -> mem.list -> mem.search round-trip', async () => {
        const added = await http(server.base, '/api/action', {
          method: 'POST',
          body: { action: 'mem.add', params: { text: 'gui 测试条目', kind: 'fact', key: 'test.gui' } },
        })
        assert.equal(added.status, 200)
        assert.equal(added.json?.ok, true, `mem.add failed: ${truncate(added.text)}`)
        const listed = await http(server.base, '/api/action', { method: 'POST', body: { action: 'mem.list', params: {} } })
        assert.equal(listed.json?.ok, true, `mem.list failed: ${truncate(listed.text)}`)
        assert.ok(listed.text.includes('gui 测试条目'), 'mem.list does not show the stored entry')
        const found = await http(server.base, '/api/action', {
          method: 'POST',
          body: { action: 'mem.search', params: { query: '测试条目' } },
        })
        assert.equal(found.json?.ok, true, `mem.search failed: ${truncate(found.text)}`)
        assert.ok(found.text.includes('gui 测试条目'), 'mem.search did not find the stored entry')
        return `${listed.bytes} B list`
      })

      await check('HTTP: tool.list on a fake UPPTOOL_HOME', async () => {
        const res = await http(server.base, '/api/action', { method: 'POST', body: { action: 'tool.list', params: {} } })
        assert.equal(res.status, 200)
        assert.equal(res.json?.ok, true, `tool.list failed: ${truncate(res.text)}`)
        assert.equal(res.json?.action, 'tool.list')
      })

      await check('HTTP: unknown action -> ok:false with hint', async () => {
        const res = await http(server.base, '/api/action', { method: 'POST', body: { action: 'no.such.action' } })
        assert.ok(res.status < 500, `unknown action caused HTTP ${res.status}`)
        assert.equal(res.json?.ok, false, `expected ok:false: ${truncate(res.text)}`)
        assert.equal(typeof res.json?.error, 'string', 'missing error string')
        assert.ok(res.json.error.length > 0, 'empty error string')
        assert.equal(typeof res.json?.hint, 'string', 'unknown action must carry a hint')
        assert.ok(res.json.hint.length > 0, 'empty hint')
        assert.ok(!hasStack(`${res.json.error}\n${res.json.hint}`), 'unknown-action error leaked a stack trace')
      })

      await check('HTTP: mem.search missing required arg -> ok:false', async () => {
        const res = await http(server.base, '/api/action', { method: 'POST', body: { action: 'mem.search', params: {} } })
        assert.ok(res.status < 500, `missing arg caused HTTP ${res.status}`)
        assert.equal(res.json?.ok, false, `expected ok:false: ${truncate(res.text)}`)
        assert.equal(typeof res.json?.error, 'string', 'missing-arg error is not structured')
        assert.match(res.json.error, /missing required param/i, `unexpected error: ${res.json.error}`)
      })

      // 12 more entries => 13 total, above the brief cap of 10.
      await check('HTTP: seed 12 entries for the brief cap', async () => {
        for (let i = 0; i < 12; i += 1) {
          const res = await http(server.base, '/api/action', {
            method: 'POST',
            body: { action: 'mem.add', params: { text: `gui 种子条目 ${i}`, kind: 'fact', key: `seed.gui.${i}` } },
          })
          assert.equal(res.json?.ok, true, `seed ${i} failed: ${truncate(res.text)}`)
        }
      })

      await check('HTTP: brief cap (10 rows + truncated:true)', async () => {
        const res = await http(server.base, '/api/action', { method: 'POST', body: { action: 'mem.list', params: {} } })
        assert.equal(res.json?.ok, true, `mem.list failed: ${truncate(res.text)}`)
        const rows = envelopeRows(res.json)
        assert.ok(rows.length <= BRIEF_MAX_ITEMS, `brief response returned ${rows.length} rows (> ${BRIEF_MAX_ITEMS})`)
        assert.equal(isTruncated(res.json), true, `brief response should set truncated:true: ${truncate(res.text, 600)}`)
        METRICS.memListBriefBytes = res.bytes
        return `${rows.length} rows / ${res.bytes} B`
      })

      await check('HTTP: full:true expands the brief cap', async () => {
        const res = await http(server.base, '/api/action', {
          method: 'POST',
          body: { action: 'mem.list', params: {}, full: true },
        })
        assert.equal(res.json?.ok, true, `mem.list full failed: ${truncate(res.text)}`)
        const rows = envelopeRows(res.json)
        assert.ok(rows.length >= 12, `full response returned only ${rows.length} rows`)
        assert.equal(isTruncated(res.json), false, 'full response must not be truncated')
        METRICS.memListFullBytes = res.bytes
        return `${rows.length} rows / ${res.bytes} B`
      })

      await check('HTTP: /api/log events have increasing seq', async () => {
        const res = await http(server.base, '/api/log?since=0')
        assert.equal(res.json?.ok, true, `log failed: ${truncate(res.text)}`)
        const events = res.json?.events
        assert.ok(Array.isArray(events) && events.length > 0, 'log has no events after a dozen actions')
        assert.ok(events.length <= 500, `log ring buffer exceeded (${events.length})`)
        let prev = 0
        for (const event of events) {
          assert.equal(typeof event.seq, 'number', 'event.seq must be numeric')
          assert.ok(event.seq > prev, `seq not strictly increasing: ${prev} -> ${event.seq}`)
          prev = event.seq
        }
        assert.equal(typeof res.json.next, 'number', 'log response needs a numeric next')
        assert.ok(res.json.next >= prev, `next (${res.json.next}) is behind the last seq (${prev})`)
        return `${events.length} events`
      })

      activeServer = server
      await smokeAll()
    } finally {
      activeServer = null
      await server.stop()
    }

    // -------------------------------------------------------------- token mode
    // Public surface (code, not data): `/`, `/index.html`, `/app.js`, `/style.css`,
    // `/favicon.ico`, `/api/ping` (200 always). Everything else under `/api/*` is
    // token-gated; sub-resource 401s used to blank the page, hence the regression guard.
    let secured = null
    await check('HTTP: token mode ping is public and reports auth flags', async () => {
      secured = await startServer(['serve', '--port', '0', '--no-open', '--json'], envFor(HOME1))
      assert.ok(secured.token, `serve printed no token: ${truncate(secured.stdoutText, 600)}`)
      const ping = await http(secured.base, '/api/ping')
      assert.equal(ping.status, 200, `ping must stay public, got ${ping.status}`)
      assert.equal(ping.json?.ok, true)
      assert.equal(ping.json?.noAuth, false, 'token-mode ping must report noAuth:false')
      assert.equal(ping.json?.tokenRequired, true, 'token-mode ping must report tokenRequired:true')
      return `${ping.bytes} B`
    })
    if (secured) {
      try {
        await check('HTTP: token mode API is 401 without token / 200 with token', async () => {
          const status = await http(secured.base, '/api/status')
          assert.equal(status.status, 401, `expected 401 without a token, got ${status.status}`)
          assert.equal(status.json?.ok, false)
          assert.equal(status.json?.error, 'unauthorized')
          const withHeader = await http(secured.base, '/api/status', { token: secured.token })
          assert.equal(withHeader.status, 200, `X-UPP-Token request -> ${withHeader.status}`)
          assert.equal(withHeader.json?.ok, true)
          const withQuery = await http(secured.base, `/api/catalog?token=${encodeURIComponent(secured.token)}`)
          assert.equal(withQuery.status, 200, `?token= request -> ${withQuery.status}`)
          assert.equal(withQuery.json?.ok, true)
        })
        await check('HTTP: token mode static shell is public (blank-page guard)', async () => {
          for (const rel of ['/', '/index.html', '/app.js', '/style.css']) {
            const res = await http(secured.base, rel)
            assert.equal(res.status, 200, `${rel} without token -> ${res.status} (blank-page regression)`)
            assert.ok(res.bytes > 0, `${rel} returned an empty body`)
          }
        })
      } finally {
        await secured.stop()
      }
    } else {
      skip('HTTP: token mode API is 401 without token / 200 with token', 'token-mode server did not start')
      skip('HTTP: token mode static shell is public (blank-page guard)', 'token-mode server did not start')
    }
  }

  // ------------------------------------------------------------------- MCP
  await check('MCP: initialize + tools/list exposes exactly upp_action / upp_catalog', async () => {
    assert.ok(fs.existsSync(path.join(GUI_DIR, 'mcp.mjs')), 'missing lib/uppgui/mcp.mjs')
    const session = openMcp(envFor(HOME1))
    try {
      const init = await session.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'uppgui-selftest', version: '1.0.0' },
      })
      assert.ok(init?.result, `initialize failed: ${truncate(JSON.stringify(init))}`)
      assert.equal(init.result.serverInfo?.name, 'uppgui')
      assert.equal(init.result.protocolVersion, '2024-11-05')
      session.notify('notifications/initialized', {})
      const listed = await session.request('tools/list', {})
      const tools = listed?.result?.tools
      assert.ok(Array.isArray(tools), `tools/list failed: ${truncate(JSON.stringify(listed))}`)
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['upp_action', 'upp_catalog'],
        'the agent surface must stay at exactly two tools',
      )
      for (const tool of tools) {
        assert.ok(tool.description, `${tool.name} needs a description`)
        assert.equal(tool.inputSchema?.type, 'object', `${tool.name} needs an object inputSchema`)
      }
      const act = tools.find((tool) => tool.name === 'upp_action')
      assert.deepEqual(act.inputSchema.required, ['action'], 'upp_action must require { action }')
      METRICS.toolsListBytes = Buffer.byteLength(JSON.stringify(listed.result))
      return `${tools.length} tools / ${METRICS.toolsListBytes} B`
    } finally {
      await session.close()
    }
  })

  await check(`MCP: tools/list payload < ${TOOLS_LIST_BUDGET} bytes (token budget)`, async () => {
    assert.ok(METRICS.toolsListBytes > 0, 'tools/list was not measured')
    assert.ok(
      METRICS.toolsListBytes < TOOLS_LIST_BUDGET,
      `tools/list is ${METRICS.toolsListBytes} B (budget ${TOOLS_LIST_BUDGET} B)`,
    )
  })

  await check('MCP: upp_catalog returns the grouped catalog', async () => {
    const session = openMcp(envFor(HOME1))
    try {
      session.notify('notifications/initialized', {})
      const res = await session.request('tools/call', { name: 'upp_catalog', arguments: {} })
      assert.ok(res?.result, `upp_catalog failed: ${truncate(JSON.stringify(res))}`)
      const text = mcpText(res.result)
      const payload = parseJson(text)
      assert.ok(payload && Array.isArray(payload.groups), `upp_catalog payload: ${truncate(text)}`)
      assert.ok(payload.groups.length >= 5, `upp_catalog returned ${payload.groups.length} groups`)
      METRICS.mcpCatalogBytes = Buffer.byteLength(text)
      return `${payload.groups.length} groups / ${METRICS.mcpCatalogBytes} B`
    } finally {
      await session.close()
    }
  })

  await check('MCP: upp_action mem.list works against the same fake HOME', async () => {
    const session = openMcp(envFor(HOME1))
    try {
      session.notify('notifications/initialized', {})
      const res = await session.request('tools/call', { name: 'upp_action', arguments: { action: 'mem.list', params: {} } })
      assert.ok(res?.result, `upp_action failed: ${truncate(JSON.stringify(res))}`)
      const text = mcpText(res.result)
      const payload = parseJson(text)
      assert.ok(payload && payload.ok === true, `upp_action payload: ${truncate(text)}`)
      assert.equal(payload.action, 'mem.list')
      const rows = envelopeRows(payload)
      assert.ok(rows.length >= 1, 'MCP cannot see the entries the HTTP API wrote')
      return `${rows.length} rows`
    } finally {
      await session.close()
    }
  })

  // ------------------------------------------------------------- packaging
  if (!fs.existsSync(BUILDER)) {
    skip('packaging: build-gui --skip-sea produces payload.zip', 'tools/build-gui.mjs not written yet')
  } else {
    await check('packaging: build-gui --skip-sea produces a valid payload.zip', async () => {
      const res = spawnSync(process.execPath, [BUILDER, '--skip-sea', '--out', DIST], {
        cwd: ROOT,
        env: envFor(HOME2),
        encoding: 'utf8',
        timeout: CHILD_TIMEOUT_MS,
        windowsHide: true,
      })
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
      assert.equal(res.status, 0, `build-gui exited ${res.status} ${res.signal ?? ''}\n${truncate(out, 3000)}`)
      const zipFile = path.join(DIST, 'payload.zip')
      assert.ok(fs.existsSync(zipFile), `missing ${rel(zipFile)}\nbuild output:\n${truncate(out, 2000)}`)
      const size = fs.statSync(zipFile).size
      assert.ok(size > 1024, `payload.zip is only ${size} B`)
      METRICS.payloadZipBytes = size
      const { readZip } = await import(pathToFileURL(ARCHIVE_FILE).href)
      const entries = readZip(zipFile).map((entry) => String(entry.name).replace(/\\/g, '/'))
      for (const wanted of ['lib/uppgui/server.mjs', 'tools/upp.mjs', '.payload.json']) {
        assert.ok(
          entries.some((name) => name === wanted || name.endsWith(`/${wanted}`)),
          `payload.zip has no entry ending with ${wanted}\nfirst entries: ${entries.slice(0, 12).join(', ')}`,
        )
      }
      return `${entries.length} entries / ${size} B`
    })
  }
}

// --------------------------------------------------------------- smoke pass
async function smokeAll() {
  // Only meaningful while the no-auth server is alive; called from the HTTP block.
  if (!activeServer) {
    skip('action smoke: every catalog action returns a structured envelope', 'serve did not start')
    return
  }
  if (!catalogActions) {
    skip('action smoke: every catalog action returns a structured envelope', 'actions.mjs failed to load')
    return
  }
  for (const id of Object.keys(catalogActions)) {
    if (SMOKE_SKIPS[id]) {
      skip(`action smoke: ${id}`, SMOKE_SKIPS[id])
      continue
    }
    const params = SAFE_PARAMS[id] ?? {}
    await check(`action smoke: ${id}`, async () => {
      const res = await http(activeServer.base, '/api/action', {
        method: 'POST',
        body: { action: id, params },
        timeoutMs: 60_000,
      })
      assert.ok(res.status < 500, `${id} caused HTTP ${res.status}: ${truncate(res.text)}`)
      const json = res.json
      assert.ok(json && typeof json === 'object', `${id}: response is not JSON: ${truncate(res.text)}`)
      assert.equal(typeof json.ok, 'boolean', `${id}: envelope.ok must be boolean: ${truncate(res.text, 500)}`)
      if (json.ok === false) {
        assert.equal(typeof json.error, 'string', `${id}: ok:false without an error string: ${truncate(res.text, 500)}`)
        assert.ok(json.error.length > 0, `${id}: empty error string`)
        assert.equal(typeof json.hint, 'string', `${id}: ok:false without a hint: ${truncate(res.text, 500)}`)
        assert.ok(json.hint.length > 0, `${id}: empty hint`)
        assert.ok(!hasStack(`${json.error}\n${json.hint}`), `${id}: error leaked a raw stack trace`)
      }
      return `${json.ok ? 'ok' : 'error+hint'} / ${res.bytes} B`
    })
  }
}

// The smoke pass needs the live handle + catalog; capture them at module level.
let activeServer = null
let catalogActions = null

// ---------------------------------------------------------------------- run
try {
  await main()
} catch (err) {
  fail('unexpected exception', err && err.stack ? err.stack : String(err))
} finally {
  for (const handle of [...liveServers]) {
    try {
      await handle.stop()
    } catch {
      /* best effort */
    }
  }
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
  `\nuppgui: ${passed} passed, ${failed} failed` +
    `${skipped ? `, ${skipped} skipped` : ''} (${total} checks, ${seconds}s)\n`,
)
if (METRICS.actionCount || METRICS.toolsListBytes) {
  process.stdout.write(
    `measured: actions=${METRICS.actionCount ?? '?'}` +
      `${METRICS.pingBytes ? ` ping=${METRICS.pingBytes}B` : ''}` +
      `${METRICS.catalogHttpBytes ? ` catalog(http)=${METRICS.catalogHttpBytes}B` : ''}` +
      `${METRICS.mcpCatalogBytes ? ` catalog(mcp)=${METRICS.mcpCatalogBytes}B` : ''}` +
      `${METRICS.toolsListBytes ? ` tools/list=${METRICS.toolsListBytes}B` : ''}` +
      `${METRICS.memListBriefBytes ? ` mem.list(brief)=${METRICS.memListBriefBytes}B` : ''}` +
      `${METRICS.memListFullBytes ? ` mem.list(full)=${METRICS.memListFullBytes}B` : ''}` +
      `${METRICS.payloadZipBytes ? ` payload.zip=${METRICS.payloadZipBytes}B` : ''}\n`,
  )
}
process.exitCode = failed ? 1 : 0
