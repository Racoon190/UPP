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

import { TOOL, createContext, runAction, catalog } from '../lib/uppgui/actions.mjs'
import { start } from '../lib/uppgui/server.mjs'
import { startMcp } from '../lib/uppgui/mcp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const STATE_DIR = path.join(os.homedir(), '.uppgui')
const STATE_FILE = path.join(STATE_DIR, 'last-server.json')

const BOOLEAN = new Set(['no-open', 'no-auth', 'json', 'full', 'help', 'version', 'open', 'quiet', 'install', 'uninstall', 'silent'])
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

async function ping(info) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/ping`, {
      headers: { 'x-upp-token': info.token ?? '' },
      signal: controller.signal,
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  } catch (err) {
    return { status: 0, body: null, error: String(err?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

const HELP = `uppgui ${TOOL.version} — visual + agent control for the UPP toolchain

usage
  uppgui                        start the local GUI and open a browser
  uppgui serve [--port N] [--no-open] [--no-auth] [--json]
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

async function cmdServe({ flags }) {
  const port = flags.port === undefined || flags.port === true ? 0 : Number(flags.port)
  const handle = await start({
    payloadDir: flags.payload ? String(flags.payload) : REPO_ROOT,
    port,
    token: flags.token ? String(flags.token) : undefined,
    noAuth: Boolean(flags['no-auth']),
    open: Boolean(flags.open) || (!flags['no-open'] && process.stdout.isTTY),
    mode: 'dev',
  })
  stateWrite({ port: handle.port, token: handle.token, url: handle.url, pid: process.pid, startedAt: new Date().toISOString() })
  if (flags.json) out(JSON.stringify({ ok: true, mode: 'serve', port: handle.port, token: handle.token, url: handle.url, payloadDir: handle.payloadDir }))
  else out(`uppgui ${TOOL.version} listening on ${handle.url}`)

  const shutdown = async () => {
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return handle
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
  const info = stateRead()
  if (info?.port) {
    const res = await ping(info)
    if (res.status === 200) {
      const url = info.url
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
      spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      if (flags.json) out(JSON.stringify({ ok: true, reused: true, url }))
      else out(`opened ${url}`)
      return
    }
  }
  await cmdServe({ flags })
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
    else if (command === 'mcp') {
      await startMcp({ payloadDir: REPO_ROOT, mode: 'dev', log: (m) => process.stderr.write(`${m}\n`) })
    } else if (command === 'action') await cmdAction({ positional: positional.slice(1), flags, params: parsed.params })
    else if (command === 'status') await cmdStatus({ flags })
    else if (command === 'open') await cmdOpen({ flags })
    else if (command === 'catalog') cmdCatalog({ flags })
    else if (command === 'selftest') await cmdSelftest({ flags })
    else if (command && !command.startsWith('-')) {
      out(HELP)
      process.exitCode = 2
    } else await cmdServe({ flags })
  }
}

main().catch((err) => {
  process.stderr.write(`uppgui: ${err?.message ?? err}\n`)
  process.exit(1)
})

