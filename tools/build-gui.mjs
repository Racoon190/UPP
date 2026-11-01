#!/usr/bin/env node
/**
 * Build the UPP GUI distribution.
 *
 *   node tools/build-gui.mjs [--out dist] [--version X] [--skip-sea] [--keep]
 *
 * Zero dependencies. Outputs, under <out>/ (default: <repo>/dist):
 *   payload/            the production file tree that ships inside the exe
 *   payload.zip         zip of payload/ (built with the repo's own writer)
 *   build/boot.cjs      copy of lib/uppgui/build/boot.cjs (SEA main)
 *   build/sea-uppgui.json  node --build-sea configuration
 *   uppgui.exe          single-file executable (Node SEA, ~105 MB)
 *   UPP-GUI-Setup-<v>.exe  same exe under a friendly name
 *   upp-gui-<v>.zip     portable zip: uppgui.exe + README.txt + install.cmd + uninstall.cmd
 *   portable/           loose copies of the portable files (always written)
 *
 * --skip-sea builds payload + payload.zip + portable cmd/README only (no exe,
 * no portable zip) — the test suite uses this path.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { packImage, readZip } from '../lib/uppenv/core/archive.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const NODE = process.execPath

const EXE_MIN_BYTES = 50 * 1024 * 1024

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: 'dist', version: null, skipSea: false, keep: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq > 2 ? arg.slice(0, eq) : arg
    const inline = arg.startsWith('--') && eq > 2 ? arg.slice(eq + 1) : null
    const value = () => {
      if (inline !== null) return inline
      if (i + 1 >= argv.length) throw new Error(`missing value after ${flag}`)
      i += 1
      return argv[i]
    }
    switch (flag) {
      case '--out':
        opts.out = value()
        break
      case '--version':
        opts.version = value()
        break
      case '--skip-sea':
        opts.skipSea = true
        break
      case '--keep':
        opts.keep = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

function usage() {
  return [
    'usage: node tools/build-gui.mjs [--out dist] [--version X] [--skip-sea] [--keep]',
    '',
    '  --out <dir>     output directory (default: <repo>/dist)',
    '  --version <v>   override the version read from tools/upp.mjs',
    '  --skip-sea      payload + payload.zip + portable scripts only (no exe)',
    '  --keep          keep an existing payload/ build/ portable/ tree',
  ].join('\n')
}

function log(message) {
  process.stderr.write(`${message}\n`)
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

/**
 * The release version is owned by the payload: lib/uppgui/actions.mjs TOOL.version
 * (the GUI tool that the exe prints with --version). tools/upp.mjs VERSION is the
 * toolchain version and is only a fallback.
 */
function readVersion() {
  const actions = path.join(REPO, 'lib', 'uppgui', 'actions.mjs')
  if (fs.existsSync(actions)) {
    const text = fs.readFileSync(actions, 'utf8')
    const tool = text.match(/export const TOOL\s*=\s*\{[^}]*?version:\s*'([^']+)'/)
    if (tool) return tool[1]
  }
  const file = path.join(REPO, 'tools', 'upp.mjs')
  const text = fs.readFileSync(file, 'utf8')
  const match = text.match(/^const VERSION = '([^']+)';$/m)
  if (!match) throw new Error(`could not find 'const VERSION = ...' in ${file}`)
  return match[1]
}

// ---------------------------------------------------------------------------
// payload file list (exactly the production surface)
// ---------------------------------------------------------------------------

function listFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (fs.statSync(abs).isFile() && pattern.test(name)) out.push(abs)
  }
  return out.sort()
}

function listTree(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const name of fs.readdirSync(current).sort()) {
      const abs = path.join(current, name)
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) stack.push(abs)
      else if (stat.isFile()) out.push(abs)
    }
  }
  return out.sort()
}

/**
 * The payload is derived from the tree, not hand-maintained: every production
 * module under lib/**\/*.mjs (minus build-only files) + the GUI statics + the
 * bundled CLIs. Any new lib module is picked up automatically, and
 * verifyPayload() proves the archived copy is import-closed.
 */
function payloadPlan() {
  const items = []
  const missing = []

  // build-only files never ship: boot.cjs lives in <out>/build, CONTRACT.md is docs
  const isBuildOnly = (rel) => rel.startsWith('lib/uppgui/build/') || /(^|\/)CONTRACT\.md$/.test(rel) || /(^|\/)test-/.test(rel)

  const libMjs = listTree(path.join(REPO, 'lib'))
    .filter((abs) => abs.endsWith('.mjs'))
    .filter((abs) => !isBuildOnly(path.relative(REPO, abs).split(path.sep).join('/')))
  if (!libMjs.length) missing.push(path.join(REPO, 'lib', '**', '*.mjs'))
  items.push(...libMjs)

  // GUI statics (index.html, app.js, style.css, ...) — everything under ui/
  const uiDir = path.join(REPO, 'lib', 'uppgui', 'ui')
  const uiFiles = listTree(uiDir).filter((abs) => !/(^|\/)test-/.test(path.basename(abs)))
  if (!uiFiles.length) missing.push(path.join(uiDir, '**'))
  items.push(...uiFiles)

  // tools clis (the exe forwards argv to tools/uppgui.mjs; the others are --cli targets)
  for (const name of ['upp.mjs', 'uppenv.mjs', 'upptool.mjs', 'uppmem.mjs', 'uppgui.mjs']) {
    const abs = path.join(REPO, 'tools', name)
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) items.push(abs)
    else missing.push(abs)
  }

  const unique = [...new Set(items)].sort()
  return { files: unique, missing: [...new Set(missing)].sort() }
}

// ---------------------------------------------------------------------------
// copying + manifest
// ---------------------------------------------------------------------------

function copyInto(payloadDir, files) {
  const written = []
  for (const abs of files) {
    const rel = path.relative(REPO, abs).split(path.sep).join('/')
    const dest = path.join(payloadDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(abs, dest)
    written.push({ rel, abs: dest, bytes: fs.statSync(dest).size })
  }
  return written
}

/** sha256 over sorted `relpath \0 content \0` for every payload file except .payload.json. */
function digestTree(payloadDir) {
  const files = listTree(payloadDir)
    .map((abs) => path.relative(payloadDir, abs).split(path.sep).join('/'))
    .filter((rel) => rel !== '.payload.json')
    .sort()
  const hash = crypto.createHash('sha256')
  let bytes = 0
  for (const rel of files) {
    const data = fs.readFileSync(path.join(payloadDir, ...rel.split('/')))
    bytes += data.length
    hash.update(rel)
    hash.update('\0')
    hash.update(data)
    hash.update('\0')
  }
  return { sha256: hash.digest('hex'), fileCount: files.length, bytes }
}

// ---------------------------------------------------------------------------
// portable files (CRLF, @echo off + pause)
// ---------------------------------------------------------------------------

function portableFiles(version) {
  const exeName = 'UPP-GUI-Setup-' + version + '.exe'
  const readme = [
    'UPP GUI ' + version + ' - portable single executable',
    '',
    'Double-click uppgui.exe to start the local GUI (a browser tab opens).',
    'The payload is extracted under %LOCALAPPDATA%\\UPPGUI\\app, the memory and',
    'tool data stay in their own UPP folders; nothing else is touched.',
    '',
    'Command line:',
    '  uppgui.exe                        serve the GUI and open a browser',
    '  uppgui.exe --no-open --port 8787  serve without opening a browser',
    '  uppgui.exe --mcp                  stdio MCP bridge (upp_action, upp_catalog)',
    '  uppgui.exe --cli upp mem list     run a bundled CLI (upp, uppenv, upptool, uppmem)',
    '  uppgui.exe --install              install: exe copy, Desktop + Start Menu shortcuts,',
    '                                    HKCU uninstall entry (no admin needed)',
    '  uppgui.exe --install --silent --dir D:\\UPPGUI',
    '                                    silent install into an explicit folder',
    '  uppgui.exe --uninstall           remove shortcuts, registry entry and payload',
    '  uppgui.exe --selftest --dir %TEMP%\\uppgui-selftest',
    '                                    start an ephemeral server and verify the API',
    '',
    'Files in this archive:',
    '  uppgui.exe      the executable (install with install.cmd for shortcuts)',
    '  install.cmd     double-click to install',
    '  uninstall.cmd   double-click to uninstall',
    '  README.txt      this file',
    '',
    'Exit codes: 0 ok, 1 failure (JSON {\"ok\":false,\"error\":...} is printed).',
    '',
    'Notes:',
    '  - If antivirus / security software blocks shortcut or registry writes, the exe',
    '    still runs normally: shortcuts and the HKCU uninstall entry are optional.',
    '    如果安全软件拦截了快捷方式/注册表写入，exe 仍可直接运行，不影响使用。',
    '  - --uninstall deletes the installed exe from a %TEMP% batch file after exit.',
    '    If that cleanup is blocked, the (empty) install folder can be removed by hand.',
    '',
  ].join('\r\n')
  const installCmd = [
    '@echo off',
    'setlocal',
    'set "EXE=%~dp0uppgui.exe"',
    'if not exist "%EXE%" (',
    '  echo uppgui.exe was not found next to install.cmd.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo Installing UPP GUI...',
    '"%EXE%" --install',
    'echo.',
    'pause',
    '',
  ].join('\r\n')
  const uninstallCmd = [
    '@echo off',
    'setlocal',
    'set "EXE=%~dp0uppgui.exe"',
    'if not exist "%EXE%" (',
    '  echo uppgui.exe was not found next to uninstall.cmd.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo Uninstalling UPP GUI...',
    '"%EXE%" --uninstall',
    'echo.',
    'pause',
    '',
  ].join('\r\n')
  return [
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    { name: 'install.cmd', data: Buffer.from(installCmd, 'utf8') },
    { name: 'uninstall.cmd', data: Buffer.from(uninstallCmd, 'utf8') },
    { name: 'setupName', data: Buffer.from(exeName, 'utf8') },
  ]
}

function writePortableDir(portableDir, version) {
  fs.mkdirSync(portableDir, { recursive: true })
  for (const entry of portableFiles(version)) {
    if (entry.name === 'setupName') continue
    fs.writeFileSync(path.join(portableDir, entry.name), entry.data)
  }
  return portableDir
}

// build a zip with the repo's writer (writeZip is used by packImage); we need an
// explicit entry list here because the portable zip is not a directory image.
function writeEntryZip(outFile, entries) {
  // writeZip lives in archive.mjs but is not re-exported through packImage's dir
  // walk, so build a temporary staging dir and reuse packImage for correctness.
  const stage = outFile + '.stage-' + process.pid
  try {
    fs.mkdirSync(stage, { recursive: true })
    for (const entry of entries) {
      const dest = path.join(stage, ...entry.name.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, entry.data)
    }
    return packImage(stage, outFile)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

// ---------------------------------------------------------------------------
// sea build
// ---------------------------------------------------------------------------

function buildSea({ outDir, exeFile, zipFile, bootDest, version }) {
  const buildDir = path.join(outDir, 'build')
  fs.mkdirSync(buildDir, { recursive: true })
  fs.copyFileSync(path.join(REPO, 'lib', 'uppgui', 'build', 'boot.cjs'), bootDest)
  const config = {
    main: bootDest,
    output: exeFile,
    assets: { 'payload.zip': zipFile },
    disableExperimentalSEAWarning: true,
  }
  const configFile = path.join(buildDir, 'sea-uppgui.json')
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n')
  log(`[sea] ${NODE} --build-sea ${configFile}`)
  const started = Date.now()
  const result = spawnSync(NODE, ['--build-sea', configFile], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const tookMs = Date.now() - started
  if (result.error) throw new Error(`node --build-sea failed: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-2000)
    throw new Error(`node --build-sea exited ${result.status}${detail ? `\n${detail}` : ''}`)
  }
  if (!fs.existsSync(exeFile)) throw new Error(`node --build-sea did not produce ${exeFile}`)
  const bytes = fs.statSync(exeFile).size
  if (bytes < EXE_MIN_BYTES) {
    throw new Error(`exe is only ${bytes} bytes (< ${EXE_MIN_BYTES}); expected a ~105 MB Node SEA binary`)
  }
  log(`[sea] built ${exeFile} (${bytes} bytes, ${tookMs} ms)`)
  return { exeFile, bytes, tookMs, configFile }
}

// ---------------------------------------------------------------------------
// release gate: the archived payload must be import-closed and runnable
//
// The payload is a tree closure (lib/**\/*.mjs + ui + tools). This gate extracts
// payload.zip into a throwaway dir and runs every bundled CLI from there, so a
// missing module (e.g. lib/uppenv/hosts/index.mjs) fails the build instead of
// surfacing as ERR_MODULE_NOT_FOUND inside the exe.
// ---------------------------------------------------------------------------

const PAYLOAD_CLI_CHECKS = [
  { file: 'tools/upp.mjs', args: ['--version'] },
  { file: 'tools/uppenv.mjs', args: ['version'] },
  { file: 'tools/upptool.mjs', args: ['version'] },
  { file: 'tools/uppmem.mjs', args: ['version'] },
  { file: 'tools/uppgui.mjs', args: ['catalog', '--json'] },
]

function runCli(nodeOrExe, args, cwd) {
  return spawnSync(nodeOrExe, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 })
}

function tailText(result) {
  return `${(result.stderr || '').trim()}\n${(result.stdout || '').trim()}`.trim().slice(-3000)
}

function verifyPayload(zipFile, label) {
  const dir = path.join(os.tmpdir(), `uppgui-verify-${process.pid}-${Date.now()}`)
  const checks = []
  try {
    for (const entry of readZip(zipFile)) {
      const dest = path.join(dir, ...entry.name.split('/'))
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, entry.data)
    }
    for (const check of PAYLOAD_CLI_CHECKS) {
      const script = path.join(dir, ...check.file.split('/'))
      const result = runCli(NODE, [script, ...check.args], dir)
      const firstLine = (result.stdout || '').trim().split('\n')[0] || ''
      checks.push({ cli: path.basename(check.file, '.mjs'), args: check.args.join(' '), ok: result.status === 0, out: firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine })
      if (result.status !== 0) {
        throw new Error(
          `payload gate failed (${label}): node ${check.file} ${check.args.join(' ')} exited ${result.status}\n${tailText(result)}`,
        )
      }
    }
    log(`[verify] ${label}: ${checks.map((check) => `${check.cli} ok (${check.out.slice(0, 40)})`).join('; ')}`)
    return checks
  } finally {
    rmTree(dir)
  }
}

/** Run the built SEA exe's --cli forwarding against a throwaway install root. */
function smokeSea(exeFile, label) {
  const root = path.join(os.tmpdir(), `uppgui-sea-smoke-${process.pid}-${Date.now()}`)
  const checks = []
  try {
    for (const [tool, args] of [
      ['upp', ['--version']],
      ['uppenv', ['version']],
      ['upptool', ['version']],
      ['uppmem', ['version']],
    ]) {
      // --dir comes first: --cli consumes everything after it verbatim
      const result = runCli(exeFile, ['--dir', root, '--cli', tool, ...args], REPO)
      const text = `${(result.stderr || '').trim()}\n${(result.stdout || '').trim()}`.trim()
      const out = (result.stdout || '').trim().split('\n').filter(Boolean).pop() || ''
      const ok = result.status === 0 && out.length > 0 && !/ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_BUILTIN_MODULE/.test(text)
      checks.push({ cli: tool, args: args.join(' '), ok, out: out.slice(0, 120) })
      if (!ok) {
        throw new Error(`sea smoke failed (${label}): uppgui.exe --cli ${tool} ${args.join(' ')} exited ${result.status}\n${text.slice(-3000)}`)
      }
    }
    log(`[verify] ${label}: ${checks.map((check) => `--cli ${check.cli} -> ${check.out}`).join('; ')}`)
    return checks
  } finally {
    rmTree(root)
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function rmTree(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
}

/** Drop stale release artifacts of other versions (keep everything else in <out>). */
function cleanStaleArtifacts(outDir, version) {
  const keep = new Set([`upp-gui-${version}.zip`, `UPP-GUI-Setup-${version}.exe`])
  const removed = []
  if (!fs.existsSync(outDir)) return removed
  for (const name of fs.readdirSync(outDir)) {
    const stale = /^upp-gui-.*\.zip$/.test(name) || /^UPP-GUI-Setup-.*\.exe$/.test(name)
    if (!stale || keep.has(name)) continue
    const abs = path.join(outDir, name)
    try {
      if (fs.statSync(abs).isFile()) {
        fs.unlinkSync(abs)
        removed.push(name)
      }
    } catch {
      /* ignore */
    }
  }
  if (removed.length) log(`[clean] removed stale artifacts: ${removed.join(', ')}`)
  return removed
}

async function main() {
  const started = Date.now()
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(usage() + '\n')
    return 0
  }

  const outDir = path.resolve(REPO, opts.out)
  const version = String(opts.version || readVersion()).trim()
  if (!/^[0-9A-Za-z._+-]+$/.test(version)) throw new Error(`invalid version: ${version}`)

  log(`[build] upp-gui ${version} -> ${outDir}${opts.skipSea ? ' (skip-sea)' : ''}`)
  fs.mkdirSync(outDir, { recursive: true })
  const staleRemoved = cleanStaleArtifacts(outDir, version)

  const payloadDir = path.join(outDir, 'payload')
  const zipFile = path.join(outDir, 'payload.zip')
  const buildDir = path.join(outDir, 'build')
  const portableDir = path.join(outDir, 'portable')
  const bootDest = path.join(buildDir, 'boot.cjs')

  if (!opts.keep) {
    for (const target of [payloadDir, portableDir]) rmTree(target)
    // --skip-sea must never remove an exe it is not rebuilding
    const staleFiles = opts.skipSea ? [zipFile] : [zipFile, path.join(outDir, 'uppgui.exe')]
    for (const target of staleFiles) {
      try {
        fs.unlinkSync(target)
      } catch {
        /* absent */
      }
    }
    // keep build/ unless we are about to rewrite it; stale sea configs are harmless
  }
  fs.mkdirSync(payloadDir, { recursive: true })

  // 1. payload tree
  const plan = payloadPlan()
  if (plan.missing.length) log(`[payload] warning: missing expected files:\n  ${plan.missing.join('\n  ')}`)
  const written = copyInto(payloadDir, plan.files)
  const digest = digestTree(payloadDir)
  const manifest = {
    version,
    builtAt: new Date().toISOString(),
    sha256: digest.sha256,
    fileCount: digest.fileCount,
  }
  fs.writeFileSync(path.join(payloadDir, '.payload.json'), JSON.stringify(manifest, null, 2) + '\n')
  log(`[payload] ${digest.fileCount} files, ${digest.bytes} bytes, sha256 ${digest.sha256.slice(0, 16)}…`)

  // 2. payload.zip via the repo writer
  const packed = packImage(payloadDir, zipFile)
  const entries = readZip(zipFile)
  const names = new Set(entries.map((entry) => entry.name))
  for (const required of ['lib/uppgui/server.mjs', 'lib/uppgui/actions.mjs', 'lib/uppgui/mcp.mjs', 'tools/upp.mjs', '.payload.json']) {
    if (!names.has(required)) throw new Error(`payload.zip is missing ${required}`)
  }
  const forbidden = [...names].filter(
    (name) => name === 'lib/uppgui/CONTRACT.md' || name.startsWith('lib/uppgui/build/') || name.startsWith('lib/uppgui/ui/test-'),
  )
  if (forbidden.length) throw new Error(`payload.zip contains build-only files: ${forbidden.join(', ')}`)
  log(`[payload] ${zipFile} (${packed.entries} entries, ${fs.statSync(zipFile).size} bytes, verified with readZip)`)

  // 2b. release gate: run every bundled CLI from the archived copy
  const payloadChecks = verifyPayload(zipFile, 'payload.zip')

  // 3. portable scripts (always; useful even without the exe)
  writePortableDir(portableDir, version)
  log(`[portable] ${portableDir}`)

  const summary = {
    version,
    out: outDir,
    payload: { files: digest.fileCount, bytes: digest.bytes, sha256: digest.sha256 },
    payloadZip: { file: zipFile, bytes: fs.statSync(zipFile).size, entries: entries.length },
    payloadChecks,
    exe: null,
    setupExe: null,
    portableZip: null,
    portableDir,
    seaSmoke: null,
    seaMs: null,
    staleArtifactsRemoved: staleRemoved,
    elapsedMs: 0,
  }

  // --skip-sea stops after payload + payload.zip + portable scripts
  if (opts.skipSea) {
    summary.elapsedMs = Date.now() - started
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    return 0
  }

  // 4. SEA exe
  const exeFile = path.join(outDir, 'uppgui.exe')
  const sea = buildSea({ outDir, exeFile, zipFile, bootDest, version })
  summary.exe = { file: exeFile, bytes: sea.bytes }
  summary.seaMs = sea.tookMs

  // 5. friendly setup copy + portable zip
  const setupExe = path.join(outDir, `UPP-GUI-Setup-${version}.exe`)
  fs.copyFileSync(exeFile, setupExe)
  summary.setupExe = { file: setupExe, bytes: fs.statSync(setupExe).size }

  const portableEntries = portableFiles(version).filter((entry) => entry.name !== 'setupName')
  portableEntries.unshift({ name: 'uppgui.exe', data: fs.readFileSync(exeFile) })
  const portableZip = path.join(outDir, `upp-gui-${version}.zip`)
  const zipInfo = writeEntryZip(portableZip, portableEntries)
  summary.portableZip = { file: portableZip, bytes: fs.statSync(portableZip).size, entries: zipInfo.entries }
  log(`[portable] ${portableZip} (${zipInfo.entries} entries, ${fs.statSync(portableZip).size} bytes)`)

  // 6. release gate: the exe must forward --cli into the archived payload
  summary.seaSmoke = smokeSea(exeFile, `uppgui.exe ${version}`)

  summary.elapsedMs = Date.now() - started
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  return 0
}

main()
  .then((code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code)
  })
  .catch((error) => {
    process.stderr.write(`build-gui: ${error && error.message ? error.message : String(error)}\n`)
    if (process.env.UPPGUI_BUILD_DEBUG) process.stderr.write(`${error && error.stack ? error.stack : ''}\n`)
    process.exit(1)
  })
