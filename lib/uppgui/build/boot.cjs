#!/usr/bin/env node
'use strict'

/**
 * UPP GUI single-executable bootstrap (CommonJS, zero dependencies).
 *
 * This file is the SEA main script. `node tools/build-gui.mjs` copies it to
 * `<out>/build/boot.cjs`, embeds `payload.zip` as the SEA asset `payload.zip`
 * and produces `<out>/uppgui.exe`. It also runs in dev mode:
 *
 *   node lib/uppgui/build/boot.cjs selftest --dir %TEMP%\uppgui-selftest
 *
 * Bootstrap responsibilities (see lib/uppgui/CONTRACT.md §5):
 *   1. locate the install root:  --dir  >  UPPGUI_HOME  >  %LOCALAPPDATA%\UPPGUI
 *   2. read the embedded payload.zip (or <repo>/dist/payload.zip in dev mode)
 *   3. extract it to <root>/app when the manifest version/hash differs
 *   4. either run a bootstrap mode (install / uninstall / print-payload /
 *      version / help) or hand the arguments over to the payload CLI,
 *      <app>/tools/uppgui.mjs, which owns serve / selftest / status / action /
 *      catalog / mcp / open.
 *
 * Module loading note (important, Node 25.5+ / nodejs/node#62726): the SEA
 * main may only load built-in modules through ITS OWN require()/import().
 * Dynamic import() of files and require('/abs/path') both fail with
 * ERR_UNKNOWN_BUILTIN_MODULE. The real loaders are reachable through
 * `Module.createRequire(__filename)`, which is what loadModule() below uses.
 * `require(esm)` cannot load modules that use top-level await, so the payload
 * entry modules and their import graphs must stay TLA-free.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const Module = require('node:module')
const { spawn, spawnSync } = require('node:child_process')

const APP_TITLE = 'UPP GUI'
const ROOT_MARKER = '.uppgui-root'
const UNINSTALL_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\uppgui'
const SHORTCUT_NAME = 'UPP GUI.lnk'
const CLI_SCRIPT = ['tools', 'uppgui.mjs']

const T0 = Date.now()

// ---------------------------------------------------------------------------
// small io helpers
// ---------------------------------------------------------------------------

function out(line) {
  process.stdout.write(String(line).endsWith('\n') ? String(line) : String(line) + '\n')
}

function log(line) {
  process.stderr.write(String(line).endsWith('\n') ? String(line) : String(line) + '\n')
}

function jsonOut(obj) {
  out(JSON.stringify(obj))
}

const TIMING = () => process.env.UPPGUI_TIMING === '1'

function mark(label) {
  if (TIMING()) log(`[timing] ${label} +${Date.now() - T0}ms`)
}

/** In UPPGUI_TIMING mode, log that we are still alive every 5s. */
function startWatchdog() {
  if (!TIMING()) return null
  const timer = setInterval(() => log(`[timing] alive +${Date.now() - T0}ms`), 5000)
  timer.unref()
  return timer
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

function safeSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

function assertSaneRoot(root) {
  const resolved = path.resolve(root)
  if (path.dirname(resolved) === resolved) throw new Error(`refusing to use a filesystem root as install dir: ${resolved}`)
  if (resolved === path.resolve(os.homedir())) throw new Error(`refusing to use the home directory as install dir: ${resolved}`)
  return resolved
}

/** Assert `target` is the root itself or lives inside it. */
function assertInsideRoot(root, target, label) {
  const r = path.resolve(root)
  const t = path.resolve(target)
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw new Error(`refusing to touch ${label || 'path'} outside install root: ${t} (root ${r})`)
  }
  return t
}

function removeInsideRoot(root, target, label) {
  const t = assertInsideRoot(root, target, label)
  fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
  return t
}

function isInsideDir(base, target) {
  const b = path.resolve(base)
  const t = path.resolve(target)
  return t === b || t.startsWith(b + path.sep)
}

function isOwnInstallRoot(root) {
  try {
    if (fs.existsSync(path.join(root, ROOT_MARKER))) return true
  } catch {
    /* ignore */
  }
  try {
    return fs.existsSync(path.join(root, 'app', '.payload.json'))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// argv parsing
//
// Bootstrap-level flags are consumed here. Everything else (commands such as
// `serve`, `selftest`, `status`, `action`, `catalog`, `mcp`, and their flags)
// is forwarded verbatim to the payload CLI, exactly like tools/uppgui.mjs.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dir: null,
    silent: false,
    install: false,
    uninstall: false,
    printPayload: null,
    help: false,
    version: false,
    cliTool: null,
    cliArgs: [],
    forward: [],
    raw: argv.slice(),
  }
  let i = 0
  const takeValue = (flag) => {
    if (i + 1 >= argv.length) throw new Error(`missing value after ${flag}`)
    i += 1
    return argv[i]
  }
  for (; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = eq > 2 ? arg.slice(0, eq) : arg
    const inline = eq > 2 ? arg.slice(eq + 1) : null
    switch (flag) {
      case '--dir':
        opts.dir = inline !== null ? inline : takeValue(flag)
        break
      case '--silent':
        opts.silent = true
        break
      case '--install':
        opts.install = true
        break
      case '--uninstall':
        opts.uninstall = true
        break
      case '--print-payload':
        opts.printPayload = inline !== null ? inline : takeValue(flag)
        break
      case '--cli':
        opts.cliTool = inline !== null ? inline : takeValue(flag)
        opts.cliArgs = argv.slice(i + 1)
        i = argv.length
        break
      // legacy aliases: map onto payload CLI commands
      case '--selftest':
        opts.forward.push('selftest', '--json')
        break
      case '--mcp':
        opts.forward.push('mcp')
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--version':
      case '-v':
        opts.version = true
        break
      default:
        opts.forward.push(arg)
        break
    }
  }
  return opts
}

function printHelp() {
  out(
    [
      `${APP_TITLE} — local GUI + agent bridge for the UPP toolchain`,
      '',
      'Usage: uppgui [command] [options]',
      '',
      'Commands (handled by the bundled CLI, see `uppgui --cmd-help`):',
      '  (none)                        serve the GUI and open a browser',
      '  serve [--port N] [--no-open] [--json]',
      '                                serve headless (one JSON line with --json)',
      '  selftest [--json]             ephemeral server, 5 API checks, exit 0/1',
      '  status [--json]               ping a running instance',
      '  action <id> [--param k=v] [--json] [--full]',
      '  catalog [--json]              list action ids',
      '  mcp                           stdio MCP bridge (upp_action, upp_catalog)',
      '  open',
      '',
      'Bootstrap options:',
      '  --dir <path>                  install root (default: %LOCALAPPDATA%\\UPPGUI)',
      '  --install [--silent]          copy the exe, create shortcuts + HKCU entry',
      '  --uninstall [--silent]        remove shortcuts, HKCU entry, payload, dir',
      '  --print-payload <dir>         extract the embedded payload and print JSON',
      '  --cli <tool> [args...]        run a bundled CLI (upp, uppenv, upptool, uppmem)',
      '  --version, -v                 print `uppgui <version>`',
      '  --help, -h                    this help',
      '',
      'Environment:',
      '  UPPGUI_HOME                   install root when --dir is absent',
      '  UPPGUI_TIMING=1               phase timings on stderr',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// payload source: embedded SEA asset, or dist/payload.zip in dev mode
// ---------------------------------------------------------------------------

function seaApi() {
  try {
    const sea = require('node:sea')
    return sea && typeof sea.isSea === 'function' ? sea : null
  } catch {
    return null
  }
}

function isSea() {
  const sea = seaApi()
  try {
    return Boolean(sea && sea.isSea())
  } catch {
    return false
  }
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value === 'string') return Buffer.from(value)
  throw new TypeError('unsupported SEA asset type')
}

function devPayloadCandidates() {
  const list = []
  if (process.env.UPPGUI_PAYLOAD_ZIP) list.push(path.resolve(process.env.UPPGUI_PAYLOAD_ZIP))
  const d = __dirname
  // <out>/build/boot.cjs -> <out>/payload.zip
  list.push(path.join(d, '..', 'payload.zip'))
  list.push(path.join(d, 'payload.zip'))
  // <repo>/lib/uppgui/build/boot.cjs -> <repo>/dist/payload.zip
  list.push(path.join(path.resolve(d, '..', '..'), 'dist', 'payload.zip'))
  list.push(path.join(path.resolve(d, '..', '..', '..'), 'dist', 'payload.zip'))
  return [...new Set(list)]
}

function payloadSource() {
  const sea = seaApi()
  if (sea) {
    try {
      if (sea.isSea()) {
        const asset = toBuffer(sea.getAsset('payload.zip'))
        if (asset && asset.length) return { zip: asset, label: 'embedded asset payload.zip' }
      }
    } catch (err) {
      throw new Error(`could not read the embedded payload.zip asset: ${err.message}`)
    }
  }
  for (const candidate of devPayloadCandidates()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { zip: fs.readFileSync(candidate), label: candidate }
      }
    } catch {
      /* ignore */
    }
  }
  return { zip: null, label: null }
}

// ---------------------------------------------------------------------------
// minimal, self-contained ZIP reader (EOCD -> central directory -> local)
// ---------------------------------------------------------------------------

function readZipBuffer(buf, label) {
  const where = label ? ` (${label})` : ''
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error(`payload.zip is empty or truncated${where}`)
  let eocd = -1
  const min = Math.max(0, buf.length - 65558)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`payload.zip is not a zip archive (no end-of-central-directory record)${where}`)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset < 0 || cdOffset >= buf.length) throw new Error(`payload.zip has a corrupt central directory offset${where}`)

  const entries = []
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`payload.zip has a corrupt central directory entry ${n}${where}`)
    }
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`payload.zip has a corrupt local header for ${name}${where}`)
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) throw new Error(`payload.zip entry ${name} is truncated${where}`)
    const raw = buf.subarray(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error(`payload.zip entry ${name} uses unsupported compression method ${method}`)
    if (size !== 0xffffffff && data.length !== size) throw new Error(`payload.zip entry ${name} has a size mismatch`)
    entries.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  if (!entries.length) throw new Error(`payload.zip contains no files${where}`)
  return entries
}

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

function safeEntryPath(base, name) {
  const clean = String(name).replace(/\\/g, '/')
  if (!clean) throw new Error('payload contains an empty entry name')
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) throw new Error(`payload contains an absolute path: ${name}`)
  const parts = clean.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) throw new Error(`payload contains a path traversal entry: ${name}`)
  const target = path.resolve(base, ...parts)
  if (target !== path.resolve(base) && !target.startsWith(path.resolve(base) + path.sep)) {
    throw new Error(`payload entry escapes the install dir: ${name}`)
  }
  return { target, isDir: clean.endsWith('/') }
}

function parsePayload(buf, label) {
  const entries = readZipBuffer(buf, label)
  const manifestEntry = entries.find((entry) => entry.name === '.payload.json')
  if (!manifestEntry) throw new Error(`payload.zip is missing .payload.json${label ? ` (${label})` : ''}`)
  let manifest
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'))
  } catch (err) {
    throw new Error(`payload.zip has an unreadable .payload.json: ${err.message}`)
  }
  if (!manifest || typeof manifest.version !== 'string' || typeof manifest.sha256 !== 'string') {
    throw new Error('payload.zip .payload.json needs at least { version, sha256 }')
  }
  return { entries, manifest }
}

function readInstalledManifest(app) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(app, '.payload.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writePayload(app, entries) {
  for (const entry of entries) {
    const { target, isDir } = safeEntryPath(app, entry.name)
    if (isDir) {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data)
  }
}

/** Read + parse the payload zip once. Returns null when the exe has no payload. */
function readPayloadZip() {
  mark('payload source: start')
  const source = payloadSource()
  mark(`payload source: ${source.zip ? `${source.zip.length} bytes` : 'none'}`)
  if (!source.zip) return null
  const parsed = parsePayload(source.zip, source.label)
  mark(`payload zip parsed: ${parsed.entries.length} entries`)
  return parsed
}

function ensurePayload(zipInfo, root) {
  const app = path.join(root, 'app')
  assertInsideRoot(root, app, 'payload dir')
  const installed = readInstalledManifest(app)

  if (!zipInfo) {
    if (installed && fs.existsSync(path.join(app, 'lib', 'uppgui', 'server.mjs'))) {
      return { app, version: String(installed.version || 'unknown'), extracted: false, fileCount: installed.fileCount || null }
    }
    throw new Error(
      'payload.zip not found. Build it first: node tools/build-gui.mjs --skip-sea (or run the packaged uppgui.exe)',
    )
  }

  const { entries, manifest } = zipInfo
  const current = installed && installed.sha256 === manifest.sha256 && installed.version === manifest.version
  const complete = current && fs.existsSync(path.join(app, 'lib', 'uppgui', 'server.mjs'))
  if (complete) {
    mark('payload already installed')
    return { app, version: String(manifest.version), extracted: false, fileCount: manifest.fileCount || null }
  }

  mark('payload extract: start')
  fs.rmSync(app, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
  fs.mkdirSync(app, { recursive: true })
  writePayload(app, entries)
  mark('payload extract: done')
  log(`payload ${manifest.version} extracted -> ${app}`)
  return { app, version: String(manifest.version), extracted: true, fileCount: manifest.fileCount || null }
}

// ---------------------------------------------------------------------------
// module loading inside the SEA (see header note)
// ---------------------------------------------------------------------------

const moduleRequire = Module.createRequire(path.join(__dirname, 'boot.cjs'))

function loadModule(file) {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) throw new Error(`payload module not found: ${abs}`)
  mark(`load ${abs}: start`)
  let namespace
  try {
    namespace = moduleRequire(abs)
  } catch (err) {
    const code = err && err.code ? err.code : ''
    if (code === 'ERR_REQUIRE_ASYNC_MODULE' || code === 'ERR_REQUIRE_ESM') {
      throw new Error(
        `cannot load ${abs}: ${code}. The payload uses top-level await, which a Node SEA cannot load ` +
          '(nodejs/node#62726). Keep the payload entry modules and their import graphs TLA-free.',
      )
    }
    throw err
  }
  mark(`load ${abs}: done`)
  return namespace
}

// ---------------------------------------------------------------------------
// mode: version / help
// ---------------------------------------------------------------------------

function payloadVersion() {
  const zipInfo = readPayloadZip()
  if (zipInfo) return String(zipInfo.manifest.version)
  for (const candidate of devPayloadCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue
      const parsed = parsePayload(fs.readFileSync(candidate), candidate)
      return String(parsed.manifest.version)
    } catch {
      /* try next */
    }
  }
  const installed = readInstalledManifest(path.join(resolveRoot(null), 'app'))
  return installed && installed.version ? String(installed.version) : '0.0.0'
}

// ---------------------------------------------------------------------------
// mode: print-payload
// ---------------------------------------------------------------------------

function printPayloadMode(targetDir) {
  const target = assertSaneRoot(path.resolve(targetDir))
  const zipInfo = readPayloadZip()
  if (!zipInfo) throw new Error('no embedded payload: run the packaged uppgui.exe, or build dist/payload.zip first')
  mark('print-payload: extract start')
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
  fs.mkdirSync(target, { recursive: true })
  writePayload(target, zipInfo.entries)
  mark('print-payload: extract done')
  const files = zipInfo.entries.map((entry) => entry.name).sort()
  const bytes = zipInfo.entries.reduce((sum, entry) => sum + entry.data.length, 0)
  jsonOut({
    ok: true,
    mode: 'print-payload',
    dir: target,
    version: String(zipInfo.manifest.version),
    sha256: String(zipInfo.manifest.sha256),
    fileCount: files.length,
    bytes,
    files,
  })
  return 0
}

// ---------------------------------------------------------------------------
// mode: dispatch to the payload CLI (tools/uppgui.mjs)
// ---------------------------------------------------------------------------

function dispatchToCli(opts, ctx) {
  const script = path.join(ctx.app, ...CLI_SCRIPT)
  if (!fs.existsSync(script)) throw new Error(`payload CLI missing: ${script}`)
  const args = opts.forward.slice()
  // The payload CLI auto-runs main() at import time and reads process.argv, so
  // the handoff must happen before requiring it. Do not restore argv afterwards:
  // the CLI may read it again asynchronously.
  process.argv = [process.execPath, script, ...args]
  mark(`dispatch -> ${script} ${args.join(' ')}`)
  loadModule(script)
  return null // the CLI owns the process from here (exit code / server lifetime)
}

// ---------------------------------------------------------------------------
// mode: cli (other bundled tools)
// ---------------------------------------------------------------------------

function cliMode(opts, ctx) {
  const tool = String(opts.cliTool || '').replace(/\.mjs$/, '')
  if (!tool) throw new Error('--cli needs a tool name: upp, uppenv, upptool or uppmem')
  if (!/^[a-z][a-z0-9_-]*$/i.test(tool)) throw new Error(`invalid tool name: ${opts.cliTool}`)
  const script = path.join(ctx.app, 'tools', `${tool}.mjs`)
  if (!fs.existsSync(script)) {
    throw new Error(`unknown tool "${tool}" — expected one of upp, uppenv, upptool, uppmem (looked for ${script})`)
  }
  process.argv = [process.execPath, script, ...opts.cliArgs]
  mark(`cli -> ${script} ${opts.cliArgs.join(' ')}`)
  loadModule(script)
  return null // let the tool's own process.exitCode decide
}

// ---------------------------------------------------------------------------
// windows helpers: shortcuts + registry
// ---------------------------------------------------------------------------

function runPowerShell(script, timeout = 30000) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout },
  )
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function specialFolders() {
  if (process.platform !== 'win32') return { desktop: null, programs: null, error: 'not windows' }
  const result = runPowerShell("[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')")
  if (result.error || result.status !== 0) {
    return {
      desktop: null,
      programs: null,
      error: (result.error && result.error.message) || (result.stderr || '').trim() || `exit ${result.status}`,
    }
  }
  const lines = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return { desktop: lines[0] || null, programs: lines[1] || null }
}

function createShortcuts(exe, root) {
  const folders = specialFolders()
  const targets = []
  if (folders.desktop) targets.push(path.join(folders.desktop, SHORTCUT_NAME))
  if (folders.programs) targets.push(path.join(folders.programs, SHORTCUT_NAME))
  if (!targets.length) {
    return { ok: false, created: [], error: folders.error || 'no desktop / start-menu folder found' }
  }
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$ws = New-Object -ComObject WScript.Shell',
    'function New-UppLnk([string]$Path) {',
    '  $sc = $ws.CreateShortcut($Path)',
    `  $sc.TargetPath = ${psQuote(exe)}`,
    `  $sc.WorkingDirectory = ${psQuote(root)}`,
    `  $sc.IconLocation = ${psQuote(exe + ',0')}`,
    `  $sc.Description = ${psQuote(APP_TITLE)}`,
    '  $sc.Save()',
    '}',
    ...targets.map((target) => `New-UppLnk ${psQuote(target)}`),
  ].join('\n')
  const result = runPowerShell(script)
  const created = targets.filter((target) => {
    try {
      return fs.existsSync(target)
    } catch {
      return false
    }
  })
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      created,
      error: (result.error && result.error.message) || (result.stderr || '').trim() || `exit ${result.status}`,
    }
  }
  return { ok: created.length > 0, created, error: created.length ? null : 'shortcut creation reported success but no .lnk was found' }
}

function removeShortcuts() {
  const folders = specialFolders()
  if (!folders.desktop && !folders.programs) return { removed: [], error: folders.error || 'no desktop / start-menu folder found' }
  const removed = []
  for (const folder of [folders.desktop, folders.programs]) {
    if (!folder) continue
    for (const name of [SHORTCUT_NAME, 'UPP GUI.lnk']) {
      const target = path.join(folder, name)
      if (safeUnlink(target)) removed.push(target)
    }
  }
  return { removed, error: null }
}

function regExe(args) {
  return spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 })
}

function registryKey() {
  return `HKCU\\${UNINSTALL_KEY}`
}

function writeRegistry(root, version, exe) {
  if (process.platform !== 'win32') return { ok: false, skipped: true, reason: 'not windows' }
  const key = registryKey()
  const values = [
    ['DisplayName', APP_TITLE],
    ['DisplayVersion', version],
    ['Publisher', 'UPP'],
    ['InstallLocation', root],
    ['DisplayIcon', `${exe},0`],
    ['UninstallString', `"${exe}" --uninstall`],
    ['QuietUninstallString', `"${exe}" --uninstall --silent`],
    ['NoModify', '1'],
    ['NoRepair', '1'],
  ]
  const errors = []
  for (const [name, value] of values) {
    const result = regExe(['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'])
    if (result.error || result.status !== 0) {
      errors.push(`${name}: ${(result.error && result.error.message) || (result.stderr || '').trim() || `exit ${result.status}`}`)
    }
  }
  const query = regExe(['query', key])
  return { ok: !errors.length && query.status === 0, key, errors, verified: query.status === 0 }
}

function deleteRegistry() {
  if (process.platform !== 'win32') return { ok: false, skipped: true, reason: 'not windows' }
  const key = registryKey()
  const query = regExe(['query', key])
  if (query.status !== 0) return { ok: true, existed: false }
  const result = regExe(['delete', key, '/f'])
  return {
    ok: !result.error && result.status === 0,
    existed: true,
    error: (result.error && result.error.message) || (result.stderr || '').trim() || null,
  }
}

// ---------------------------------------------------------------------------
// mode: install
// ---------------------------------------------------------------------------

function launchDetached(exe) {
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return true
  } catch (err) {
    log(`warn: could not launch ${exe}: ${err.message}`)
    return false
  }
}

function installMode(opts, ctx) {
  const { root, app, version } = ctx
  const exeFile = path.join(root, 'uppgui.exe')
  assertInsideRoot(root, exeFile, 'install exe')

  if (!isSea()) throw new Error('install needs the packaged uppgui.exe (run `node tools/build-gui.mjs` first)')

  let copied = false
  const runningExe = path.resolve(process.execPath)
  const targetExe = path.resolve(exeFile)
  if (runningExe.toLowerCase() !== targetExe.toLowerCase()) {
    fs.mkdirSync(root, { recursive: true })
    fs.copyFileSync(runningExe, targetExe)
    copied = true
  }

  try {
    fs.writeFileSync(
      path.join(root, ROOT_MARKER),
      `${JSON.stringify({ name: 'uppgui', version, installedAt: new Date().toISOString() })}\n`,
    )
  } catch {
    /* the marker is a safety nicety, not critical */
  }

  const shortcuts = createShortcuts(exeFile, root)
  const registry = writeRegistry(root, version, exeFile)

  const summary = {
    ok: true,
    mode: 'install',
    root,
    version,
    exe: exeFile,
    exeBytes: safeSize(exeFile),
    app,
    payloadVersion: version,
    copied,
    shortcuts: shortcuts.created,
    shortcutsOk: shortcuts.ok,
    shortcutError: shortcuts.error || null,
    registry,
    silent: Boolean(opts.silent),
  }

  if (opts.silent) {
    jsonOut(summary)
    return 0
  }

  out(`${APP_TITLE} ${version}`)
  out(`  root:      ${root}`)
  out(`  exe:       ${exeFile}${copied ? ' (copied)' : ' (already in place)'}`)
  out(`  payload:   ${app}`)
  if (shortcuts.ok) out(`  shortcuts: ${shortcuts.created.join(', ')}`)
  else log(`warn: shortcuts not created: ${shortcuts.error || 'unknown error'}`)
  if (registry.ok) out(`  registry:  ${registryKey()} (verified)`)
  else log(`warn: registry entries incomplete: ${(registry.errors || []).join('; ') || 'unknown error'}`)
  out('')
  out('Installed. Uninstall with: uppgui.exe --uninstall')
  if (ctx.auto) {
    out('Launching UPP GUI...')
    launchDetached(exeFile)
  }
  return 0
}

// ---------------------------------------------------------------------------
// mode: uninstall
// ---------------------------------------------------------------------------

function scheduleSelfDelete(root, exeFile) {
  const tempDir = os.tmpdir()
  const batch = path.join(tempDir, `uppgui-clean-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.cmd`)
  const lines = [
    '@echo off',
    'setlocal',
    `set "TARGET=${exeFile}"`,
    'for /l %%i in (1,1,120) do (',
    '  if not exist "%TARGET%" goto removed',
    '  del /f /q "%TARGET%" >nul 2>&1',
    '  if not exist "%TARGET%" goto removed',
    '  >nul ping -n 2 127.0.0.1',
    ')',
    ':removed',
    `rmdir /s /q "${root}" >nul 2>&1`,
    'del /f /q "%~f0" >nul 2>&1',
    '',
  ]
  fs.writeFileSync(batch, lines.join('\r\n'), 'utf8')
  const child = spawn('cmd.exe', ['/d', '/c', batch], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return batch
}

function uninstallMode(opts, ctx) {
  const { root } = ctx
  assertSaneRoot(root)
  if (!isOwnInstallRoot(root)) {
    throw new Error(
      `refusing to uninstall: ${root} does not look like an UPP GUI install root (no ${ROOT_MARKER} or app/.payload.json)`,
    )
  }
  const app = path.join(root, 'app')
  const exeFile = path.join(root, 'uppgui.exe')

  const shortcuts = removeShortcuts()
  const registry = deleteRegistry()

  let appRemoved = false
  try {
    if (fs.existsSync(app)) {
      removeInsideRoot(root, app, 'payload dir')
      appRemoved = true
    }
  } catch (err) {
    log(`warn: could not remove ${app}: ${err.message}`)
  }

  let exeRemoved = false
  let selfDelete = null
  const runningFromRoot = path.resolve(process.execPath).toLowerCase() === path.resolve(exeFile).toLowerCase()
  if (fs.existsSync(exeFile)) {
    if (!runningFromRoot) {
      try {
        fs.unlinkSync(exeFile)
        exeRemoved = true
      } catch (err) {
        log(`warn: could not remove ${exeFile}: ${err.message} (scheduling self-delete)`)
      }
    }
    if (!exeRemoved) {
      try {
        selfDelete = scheduleSelfDelete(root, exeFile)
      } catch (err) {
        log(`warn: could not schedule self-delete: ${err.message}`)
      }
    }
  } else {
    exeRemoved = true
  }

  // the install marker is ours too: drop it so an empty root can actually go away
  safeUnlink(path.join(root, ROOT_MARKER))

  let rootRemoved = false
  if (exeRemoved) {
    try {
      if (fs.existsSync(root) && fs.readdirSync(root).length === 0) {
        fs.rmdirSync(root)
        rootRemoved = true
      }
    } catch {
      /* leave the root behind */
    }
  }

  const summary = {
    ok: true,
    mode: 'uninstall',
    root,
    version: ctx.version,
    shortcutsRemoved: shortcuts.removed,
    registry,
    appRemoved,
    exeRemoved,
    rootRemoved: rootRemoved || Boolean(selfDelete),
    selfDeleteBatch: selfDelete,
    silent: Boolean(opts.silent),
  }
  if (opts.silent) {
    jsonOut(summary)
    return 0
  }
  out(`${APP_TITLE} uninstalled`)
  out(`  root:      ${root}`)
  out(`  shortcuts: ${shortcuts.removed.length} removed`)
  out(`  registry:  ${registry.existed ? 'removed' : 'not present'}`)
  out(`  payload:   ${appRemoved ? 'removed' : 'not present'}`)
  out(`  exe:       ${exeRemoved ? 'removed' : 'scheduled for removal after exit'}`)
  if (selfDelete) out(`  cleanup:   ${selfDelete}`)
  return 0
}

// ---------------------------------------------------------------------------
// mode: no arguments = one-click first run
//
// docs/20 §2.1 + docs/19 §4.4: double-clicking the exe must install/refresh the
// payload under %LOCALAPPDATA%\UPPGUI (the --install --silent code path) and then
// serve + open the browser.
// ---------------------------------------------------------------------------

function firstRunMode(opts, ctx) {
  if (!isSea()) return dispatchToCli(opts, ctx) // dev mode: plain serve, no install

  const installedExe = path.join(ctx.root, 'uppgui.exe')
  const runningFromRoot = path.resolve(process.execPath).toLowerCase() === path.resolve(installedExe).toLowerCase()
  const installed = isOwnInstallRoot(ctx.root)

  if (!runningFromRoot || !installed) {
    mark('first-run: silent install')
    const code = installMode({ ...opts, silent: true, install: true }, { ...ctx, auto: false })
    if (code !== 0) return code
    if (fs.existsSync(installedExe)) {
      mark('first-run: launch installed exe')
      launchDetached(installedExe)
    }
    return 0
  }

  // Already the installed exe: serve and open the browser.
  const script = path.join(ctx.app, ...CLI_SCRIPT)
  process.argv = [process.execPath, script, '--open']
  mark(`serve+open -> ${script}`)
  loadModule(script)
  return null
}

// ---------------------------------------------------------------------------
// root resolution + main
// ---------------------------------------------------------------------------

function resolveRoot(dirFlag) {
  let root
  if (dirFlag) root = path.resolve(dirFlag)
  else if (process.env.UPPGUI_HOME) root = path.resolve(process.env.UPPGUI_HOME)
  else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    root = path.join(local, 'UPPGUI')
  } else {
    root = path.join(os.homedir(), '.local', 'share', 'uppgui')
  }
  return assertSaneRoot(root)
}

let LAST_OPTS = null

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  LAST_OPTS = opts
  mark('args parsed')

  if (opts.help) {
    printHelp()
    return 0
  }
  if (opts.version) {
    out(`uppgui ${payloadVersion()}`)
    return 0
  }

  const root = resolveRoot(opts.dir)

  if (opts.printPayload !== null && opts.printPayload !== undefined) {
    return printPayloadMode(opts.printPayload)
  }

  if (opts.uninstall) {
    const installed = readInstalledManifest(path.join(root, 'app'))
    return uninstallMode(opts, { root, app: path.join(root, 'app'), version: installed && installed.version ? String(installed.version) : '0.0.0' })
  }

  // Everything below needs the payload.
  const zipInfo = readPayloadZip()
  const payload = ensurePayload(zipInfo, root)
  const ctx = { root, app: payload.app, version: payload.version, extracted: payload.extracted, auto: false }

  if (opts.install) {
    // CONTRACT §5.4: a double-clicked portable exe outside the install root
    // runs the install flow; `--install` from anywhere does the same.
    ctx.auto = opts.raw.length === 0
    return installMode(opts, ctx)
  }

  if (opts.cliTool) return cliMode(opts, ctx)

  // No arguments = one-click double-click semantics (docs/20 §2.1, docs/19 §4.4):
  // install/refresh the payload into the default root, then serve + open.
  if (opts.raw.length === 0) return firstRunMode(opts, ctx)

  startWatchdog()
  return dispatchToCli(opts, ctx)
}

main()
  .then((code) => {
    if (typeof code === 'number') process.exit(code)
  })
  .catch((err) => {
    const message = err && err.message ? err.message : String(err)
    log(`uppgui: ${message}`)
    const opts = LAST_OPTS || {}
    if (opts.raw && opts.raw.includes('--json')) {
      jsonOut({ ok: false, error: message })
    } else if (opts.silent) {
      jsonOut({ ok: false, error: message })
    }
    process.exit(1)
  })
