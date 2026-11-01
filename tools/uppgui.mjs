#!/usr/bin/env node
/**
 * uppgui — command line entry for the GUI / agent bridge.
 *
 *   uppgui                    start the server and open the browser
 *   uppgui serve --port 0     headless serve (prints one JSON line with --json)
 *   uppgui action mem.search --query upp --json
 *   uppgui mcp                stdio MCP server (2 tools: upp_action/upp_catalog)
 *   uppgui status             ping a running instance
 *   uppgui selftest           boot an ephemeral server, hit the API, exit 0/1
 *
 * Contract: lib/uppgui/CONTRACT.md §4
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { isSea } from 'node:sea'

import { TOOL, createContext, runAction, catalog } from '../lib/uppgui/actions.mjs'
import { start } from '../lib/uppgui/server.mjs'
import { startMcp } from '../lib/uppgui/mcp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const STATE_DIR = path.join(os.homedir(), '.uppgui')
const STATE_FILE = path.join(STATE_DIR, 'last-server.json')

const BOOLEAN = new Set(['no-open', 'no-auth', 'json', 'full', 'help', 'version', 'open', 'quiet', 'install', 'uninstall', 'silent', 'force'])
const VALUED = new Set(['port', 'token', 'param', 'action', 'host', 'dir', 'p', 'payload'])

function parseArgs(argv) {
  const positional = []
  const flags = {}
  const lists = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const [rawName, inline] = a.slice(2).split('=', 2)
      const name = rawName
      if (BOOLEAN.has(name) && inline === undefined) {
        flags[name] = true
        continue
      }
      let value = inline
      if (value === undefined) {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          value = next
          i += 1
        } else {
          value = true
        }
      }
      if (name === 'param') {
        const s = String(value)
        const eq = s.indexOf('=')
        if (eq <= 0) fail(`--param needs k=v, got "${s}"`)
        const key = s.slice(0, eq)
        const raw = s.slice(eq + 1)
        lists.params = lists.params ?? {}
        let parsed = raw
        if (raw === 'true' || raw === 'false') parsed = raw === 'true'
        else if (raw !== '' && !Number.isNaN(Number(raw))) parsed = Number(raw)
        else if (raw.startsWith('[') || raw.startsWith('{')) {
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = raw
          }
        }
        lists.params[key] = parsed
        continue
      }
      flags[name] = value
      continue
    }
    positional.push(a)
  }
  return { positional, flags, params: lists.params ?? {} }
}

function fail(message, code = 2) {
  process.stderr.write(`uppgui: ${message}\n`)
  process.exit(code)
}

function out(text) {
  process.stdout.write(`${text}\n`)
}

function stateWrite(info) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(info, null, 2)}\n`)
  } catch {
    /* state is a convenience, never fatal */
  }
}

function stateRead() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function pingOnce(info, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/ping`, {
      headers: { 'x-upp-token': info.token ?? '', connection: 'close' },
      signal: controller.signal,
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  } catch (err) {
    return { status: 0, body: null, error: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

/** Ping with a couple of retries: a cold first request can lose the 2.5s race. */
async function ping(info) {
  let last = { status: 0, body: null, error: 'not attempted' }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await pingOnce(info, attempt === 0 ? 2500 : 4000)
    if (last.status === 200) return last
    await new Promise((r) => setTimeout(r, 250))
  }
  return last
}

const HELP = `uppgui ${TOOL.version} — visual + agent control for the UPP toolchain

usage
  uppgui                        start the local GUI and open a browser
  uppgui start [--port N] [--no-open] [--json]
                                start in the background (survives closing the terminal)
  uppgui stop [--json]          stop the recorded background instance
  uppgui url [--json]           print the URL of the running instance
  uppgui serve [--port N] [--no-open] [--no-auth] [--json]
                                run in the foreground (Ctrl-C to stop)
  uppgui action <id> [--param k=v ...] [--json] [--full]
  uppgui mcp                    stdio MCP server (upp_action, upp_catalog)
  uppgui status [--json]        ping the running instance
  uppgui selftest [--json]      start an ephemeral server and verify the API
  uppgui catalog [--json]       print the action catalog
  uppgui --install [--silent] [--dir <path>]     (packaged exe)
  uppgui --uninstall [--dir <path>]
  uppgui --version | --help

actions: ${Object.keys(catalog({ verbose: false }).flatMap((g) => g.actions)).length} ids — run \`uppgui catalog\` for the list.
`

const DEFAULT_PORT = Number(process.env.UPPGUI_PORT || 7799)
const PORT_TRIES = 10

function launchBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/** A recorded instance that still answers /api/ping, or null. */
async function runningInstance() {
  const info = stateRead()
  if (!info?.port) return null
  const res = await ping(info)
  return res.status === 200 && res.body?.ok === true ? info : null
}

function isSeaHost() {
  try {
    return isSea()
  } catch {
    return false
  }
}

async function cmdServe({ flags }) {
  const reuse = flags.force ? null : await runningInstance()
  if (reuse) {
    out(`uppgui ${TOOL.version} already running on ${reuse.url} (pid ${reuse.pid}) — pass --force to start another`)
    if (flags.open) launchBrowser(reuse.url)
    return null
  }

  const wanted = flags.port !== undefined && flags.port !== true ? Number(flags.port) : DEFAULT_PORT
  const tries = flags.port !== undefined && flags.port !== true ? 1 : PORT_TRIES
  let handle = null
  let lastErr = null
  for (let i = 0; i < tries; i++) {
    try {
      handle = await start({
        payloadDir: flags.payload ? String(flags.payload) : REPO_ROOT,
        port: wanted + i,
        token: flags.token ? String(flags.token) : undefined,
        noAuth: Boolean(flags['no-auth']),
        open: flags.open === true,
        mode: 'dev',
      })
      break
    } catch (err) {
      lastErr = err
      if (err?.code !== 'EADDRINUSE') throw err
    }
  }
  if (!handle) throw new Error(`cannot bind a port in ${wanted}..${wanted + tries - 1}: ${lastErr?.message ?? lastErr}`)

  stateWrite({ port: handle.port, token: handle.token, url: handle.url, pid: process.pid, startedAt: new Date().toISOString() })
  if (flags.json) out(JSON.stringify({ ok: true, mode: 'serve', port: handle.port, token: handle.token, url: handle.url, payloadDir: handle.payloadDir }))
  else out(`uppgui ${TOOL.version} listening on ${handle.url}`)
  if (flags.open) launchBrowser(handle.url)

  const shutdown = async () => {
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return handle
}

/** Start the server in the background so closing the terminal keeps it alive. */
async function cmdStart({ flags }) {
  const reuse = await runningInstance()
  if (reuse) {
    out(`uppgui already running on ${reuse.url}`)
    if (flags.open !== false) launchBrowser(reuse.url)
    return
  }
  // Only pin the port when the user asked for one: otherwise let the child walk
  // 7799..7808 so a stale instance on the default port cannot block startup.
  const portArgs = flags.port !== undefined && flags.port !== true ? ['--port', String(flags.port)] : []
  const argv = isSeaHost()
    ? ['--cli', 'uppgui', 'serve', ...portArgs, '--json']
    : [process.argv[1], 'serve', ...portArgs, '--json']
  const child = spawn(process.execPath, argv, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()

  const deadline = Date.now() + 20000
  let info = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    info = await runningInstance()
    if (info) break
  }
  if (!info) throw new Error(`the background server did not answer within 20s (pid ${child.pid}) — run \`uppgui serve\` in a terminal to see why`)
  if (flags.json) out(JSON.stringify({ ok: true, mode: 'start', reused: false, port: info.port, url: info.url, pid: info.pid }))
  else out(`uppgui ${TOOL.version} started in the background on ${info.url} (pid ${info.pid})`)
  if (flags.open !== false) launchBrowser(info.url)
}

async function cmdStop({ flags }) {
  const info = stateRead()
  if (!info?.pid) {
    if (flags.json) out(JSON.stringify({ ok: true, stopped: false, detail: 'no recorded instance' }))
    else out('uppgui: nothing to stop')
    return
  }
  const wasUp = Boolean(await runningInstance())
  let killed = false
  try {
    process.kill(info.pid)
    killed = true
  } catch (err) {
    if (err?.code !== 'ESRCH') throw err
  }
  await new Promise((r) => setTimeout(r, 400))
  const stillUp = Boolean(await runningInstance())
  if (!stillUp && fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE, { force: true })
  const result = { ok: !stillUp, stopped: killed || wasUp, pid: info.pid, stillUp }
  if (flags.json) out(JSON.stringify(result))
  else out(stillUp ? `uppgui: pid ${info.pid} is still answering` : `uppgui stopped (pid ${info.pid})`)
  process.exitCode = stillUp ? 1 : 0
}

async function cmdUrl({ flags }) {
  const info = await runningInstance()
  if (!info) {
    const result = { ok: false, error: 'no running uppgui instance', hint: 'start it with `upp gui start` or `uppgui start`' }
    if (flags.json) out(JSON.stringify(result))
    else process.stderr.write(`uppgui: ${result.error} (${result.hint})\n`)
    process.exitCode = 1
    return
  }
  if (flags.json) out(JSON.stringify({ ok: true, url: info.url, port: info.port, pid: info.pid }))
  else out(info.url)
}


async function cmdSelftest({ flags }) {
  const started = Date.now()
  const checks = []
  let handle = null
  try {
    handle = await start({ payloadDir: REPO_ROOT, port: 0, noAuth: true, open: false, mode: 'dev' })
    const base = `http://127.0.0.1:${handle.port}`
    const pingRes = await fetch(`${base}/api/ping`).then((r) => r.json())
    checks.push({ check: 'ping', ok: pingRes.ok === true && pingRes.app === 'uppgui' })
    const cat = await fetch(`${base}/api/catalog`).then((r) => r.json())
    checks.push({ check: 'catalog', ok: cat.ok === true && (cat.groups ?? []).length >= 5 })
    const status = await fetch(`${base}/api/status`).then((r) => r.json())
    checks.push({ check: 'status', ok: status.ok === true })
    const act = await fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'mem.stats' }),
    }).then((r) => r.json())
    checks.push({ check: 'action', ok: act.ok === true })
    const log = await fetch(`${base}/api/log?since=0`).then((r) => r.json())
    checks.push({ check: 'log', ok: log.ok === true && Array.isArray(log.events) })
  } catch (err) {
    checks.push({ check: 'suite', ok: false, detail: String(err?.message ?? err) })
  } finally {
    if (handle) await handle.close()
  }
  const ok = checks.every((c) => c.ok)
  const result = { ok, app: 'uppgui', version: TOOL.version, tookMs: Date.now() - started, checks }
  if (flags.json) out(JSON.stringify(result))
  else {
    for (const c of checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check}${c.detail ? ` — ${c.detail}` : ''}`)
    out(ok ? `selftest passed (${checks.length} checks, ${result.tookMs}ms)` : 'selftest FAILED')
  }
  process.exit(ok ? 0 : 1)
}

async function cmdAction({ positional, flags, params }) {
  const id = positional[0]
  if (!id) fail('action needs an id, e.g. `uppgui action mem.list`')
  if (flags.full) params.full = true
  const ctx = createContext({ payloadDir: REPO_ROOT, mode: 'dev' })
  const envelope = await runAction(id, params, ctx)
  if (flags.json) out(JSON.stringify(envelope))
  else if (envelope.ok) out(JSON.stringify(envelope.data, null, 2))
  else {
    process.stderr.write(`uppgui: ${envelope.error}${envelope.hint ? ` — ${envelope.hint}` : ''}\n`)
    process.exitCode = 1
  }
}

async function cmdStatus({ flags }) {
  const info = stateRead()
  if (!info?.port) {
    const result = { ok: false, error: 'no running uppgui instance', hint: 'start it with `uppgui` or `uppgui serve`' }
    if (flags.json) out(JSON.stringify(result))
    else process.stderr.write(`uppgui: ${result.error} (${result.hint})\n`)
    process.exitCode = 1
    return
  }
  const res = await ping(info)
  const result = { ok: res.status === 200 && res.body?.ok === true, port: info.port, url: info.url, ping: res.body, ...(res.error ? { error: res.error } : {}) }
  if (flags.json) out(JSON.stringify(result))
  else if (result.ok) out(`uppgui ${res.body.version} running on ${info.url}`)
  else process.stderr.write(`uppgui: not answering on port ${info.port} (${res.error ?? res.status})\n`)
  process.exitCode = result.ok ? 0 : 1
}

async function cmdOpen({ flags }) {
  const info = await runningInstance()
  if (info) {
    launchBrowser(info.url)
    if (flags.json) out(JSON.stringify({ ok: true, reused: true, url: info.url }))
    else out(`opened ${info.url}`)
    return
  }
  await cmdStart({ flags: { ...flags, open: true } })
}

function cmdCatalog({ flags }) {
  const groups = catalog({ verbose: true })
  if (flags.json) {
    out(JSON.stringify({ ok: true, version: TOOL.version, groups }))
    return
  }
  for (const g of groups) {
    out(`\n${g.title} (${g.id})`)
    for (const a of g.actions) {
      const args = a.args.length ? `  [${a.args.map((x) => `${x.name}${x.required ? '*' : ''}`).join(', ')}]` : ''
      out(`  ${a.id.padEnd(16)} ${a.danger ? '!' : ' '} ${a.title}${args}`)
    }
  }
}

function delegateToExe({ flags, positional }) {
  const exe = path.join(REPO_ROOT, 'dist', 'uppgui.exe')
  if (!fs.existsSync(exe)) {
    fail(`--install/--uninstall need the packaged exe; build it first: node tools/build-gui.mjs (looked for ${exe})`)
  }
  const args = [...positional]
  for (const [k, v] of Object.entries(flags)) {
    if (v === true) args.push(`--${k}`)
    else args.push(`--${k}`, String(v))
  }
  const child = spawn(exe, args, { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
}

/**
 * No top-level await on purpose: the SEA host loads payload tools with
 * require(esm) (nodejs/node#62726), which rejects graphs containing TLA.
 */
async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  const { positional, flags } = parsed
  if (flags.help) out(HELP)
  else if (flags.version) out(JSON.stringify({ toolchain: TOOL.version, node: process.version, script: HERE }))
  else if (flags.install || flags.uninstall) delegateToExe({ flags, positional })
  else {
    const command = positional[0]
    if (command === 'serve') await cmdServe({ flags })
    else if (command === 'start') await cmdStart({ flags })
    else if (command === 'stop') await cmdStop({ flags })
    else if (command === 'url') await cmdUrl({ flags })
    else if (command === 'mcp') {
      await startMcp({ payloadDir: REPO_ROOT, mode: 'dev', log: (m) => process.stderr.write(`${m}\n`) })
    } else if (command === 'action') await cmdAction({ positional: positional.slice(1), flags, params: parsed.params })
    else if (command === 'status') await cmdStatus({ flags })
    else if (command === 'open') await cmdOpen({ flags })
    else if (command === 'catalog') cmdCatalog({ flags })
    else if (command === 'selftest') await cmdSelftest({ flags })
    else if (command === 'version') out(JSON.stringify({ toolchain: TOOL.version, node: process.version, script: HERE }))
    else if (command && !command.startsWith('-')) {
      out(HELP)
      process.exitCode = 2
    } else await cmdStart({ flags: { ...flags, open: flags.open !== false } })
  }
}

main().catch((err) => {
  process.stderr.write(`uppgui: ${err?.message ?? err}\n`)
  process.exit(1)
})

