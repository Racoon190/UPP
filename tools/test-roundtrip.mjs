#!/usr/bin/env node
/**
 * uppenv round-trip test — export from a synthetic host, import into a second
 * synthetic home, then roll the import back. Everything happens under
 * os.tmpdir(); no real host directory is read or written.
 *
 *   node tools/test-roundtrip.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLI = path.join(ROOT, 'tools', 'uppenv.mjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'uppenv-roundtrip-'))
const SRC = path.join(TMP, 'source-home')
const DST = path.join(TMP, 'target-home')
const IMG = path.join(TMP, 'roundtrip.uppenv')
let pass = 0
let fail = 0

function ok(msg) {
  pass += 1
  process.stdout.write(`PASS ${msg}\n`)
}
function bad(msg, extra) {
  fail += 1
  process.stdout.write(`FAIL ${msg}${extra ? `\n     ${extra}` : ''}\n`)
}
function check(cond, msg, extra) {
  if (cond) ok(msg)
  else bad(msg, extra)
}
function envFor(home) {
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    DSH_HOME: path.join(home, '.dsh'),
    UPPENV_HOME: path.join(home, '.uppenv'),
    NO_COLOR: '1',
  }
}
function run(args, home) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: envFor(home),
    encoding: 'utf8',
    timeout: 120000,
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, stdout: res.stdout ?? '' }
}

const FIXTURE = `#!/usr/bin/env node
// Minimal MCP stdio server used by the round-trip test.
import readline from 'node:readline'
const TOOLS = [
  { name: 'demo_echo', description: 'echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'demo_upper', description: 'uppercase text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
]
const rl = readline.createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  if (req.id === undefined) return
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'roundtrip-fixture', version: '1.0.0' } } })
    return
  }
  if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } })
    return
  }
  send({ jsonrpc: '2.0', id: req.id, result: {} })
})
`

try {
  // ---------------------------------------------------------------- source host
  fs.mkdirSync(path.join(SRC, '.workbuddy', 'skills', 'demo-skill', 'references'), { recursive: true })
  fs.writeFileSync(path.join(SRC, '.workbuddy', 'skills', 'demo-skill', 'SKILL.md'), '# demo skill\nround-trip fixture\n')
  fs.writeFileSync(path.join(SRC, '.workbuddy', 'skills', 'demo-skill', 'references', 'note.md'), 'note body\n')
  fs.mkdirSync(path.join(SRC, '.codebuddy'), { recursive: true })
  const fixtureServer = path.join(SRC, 'fixture-server.mjs')
  fs.writeFileSync(fixtureServer, FIXTURE)
  fs.writeFileSync(
    path.join(SRC, '.codebuddy', 'mcp.json'),
    `${JSON.stringify(
      {
        mcpServers: {
          demo: { command: process.execPath, args: [fixtureServer], env: { UPP_HOST: 'workbuddy' } },
        },
      },
      null,
      2,
    )}\n`,
  )

  // -------------------------------------------------------------------- export
  const exported = run(['export', '-o', IMG, '--host', 'workbuddy', '--kind', 'skill,mcp,tool'], SRC)
  check(exported.code === 0, 'export exits 0', exported.out.slice(-800))
  check(fs.existsSync(IMG), 'image file exists')
  const verified = run(['verify', IMG], SRC)
  check(verified.code === 0 && /OK \d+ asset/.test(verified.out), 'verify passes', verified.out.slice(-400))
  const inspected = run(['inspect', IMG, '--json'], SRC)
  let assets = []
  try {
    const info = JSON.parse(inspected.stdout)
    assets = info.manifest?.assets ?? info.assets ?? []
  } catch {
    assets = []
  }
  check(assets.some((a) => a.kind === 'skill' && a.id === 'demo-skill'), 'image contains the skill')
  check(assets.some((a) => a.kind === 'mcp' && a.id === 'demo'), 'image contains the mcp server')
  const toolAsset = assets.find((a) => a.kind === 'tool' && a.id === 'demo')
  check(Boolean(toolAsset), 'image contains a tool-surface snapshot')

  // ------------------------------------------------------------- import (fresh)
  fs.mkdirSync(path.join(DST, '.workbuddy', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(DST, '.codebuddy'), { recursive: true })
  const imported = run(['import', IMG, '--host', 'workbuddy', '--kind', 'skill,mcp,tool', '--yes'], DST)
  check(imported.code === 0, 'import exits 0', imported.out.slice(-800))

  const skillFile = path.join(DST, '.workbuddy', 'skills', 'demo-skill', 'SKILL.md')
  check(fs.existsSync(skillFile), 'skill tree materialized in target home')
  check(fs.existsSync(path.join(DST, '.workbuddy', 'skills', 'demo-skill', 'references', 'note.md')), 'skill nested file materialized')

  const mcpFile = path.join(DST, '.codebuddy', 'mcp.json')
  let mcpJson = null
  try {
    mcpJson = JSON.parse(fs.readFileSync(mcpFile, 'utf8'))
  } catch {
    mcpJson = null
  }
  check(Boolean(mcpJson?.mcpServers?.demo), 'mcp config materialized')
  const args0 = mcpJson?.mcpServers?.demo?.args?.[0] ?? ''
  check(args0.startsWith(DST), 'mcp path expanded against the TARGET home', args0)

  const snapshotFile = path.join(DST, '.uppenv', 'tools', 'workbuddy', 'demo.json')
  check(fs.existsSync(snapshotFile), 'tool snapshot recorded in uppenv store')

  const listed = run(['tools', '--host', 'workbuddy', '--json'], DST)
  let listedJson = null
  try {
    listedJson = JSON.parse(listed.stdout)
  } catch {
    listedJson = null
  }
  check(Array.isArray(listedJson) && listedJson.some((r) => r.server === 'roundtrip-fixture'), 'uppenv tools lists the recorded server')

  let snapshot = null
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'))
  } catch {
    snapshot = null
  }
  check((snapshot?.tools ?? []).length === 2, 'snapshot captured the 2 live tools', `got ${(snapshot?.tools ?? []).length}`)

  // ---------------------------------------------------------------- rollback
  const rolled = run(['rollback', '--last'], DST)
  check(rolled.code === 0, 'rollback exits 0', rolled.out.slice(-500))
  check(!fs.existsSync(skillFile), 'rollback removed the skill tree')
  check(!fs.existsSync(mcpFile), 'rollback removed the created mcp config')
  check(!fs.existsSync(snapshotFile), 'rollback removed the tool snapshot')

  // ------------------------------------------------------------ conflict policies
  const again = run(['import', IMG, '--host', 'workbuddy', '--kind', 'skill', '--yes'], DST)
  check(again.code === 0, 're-import after rollback exits 0', again.out.slice(-500))

  fs.appendFileSync(skillFile, '\nlocal edit\n')
  const skipped = run(['import', IMG, '--host', 'workbuddy', '--kind', 'skill', '--yes', '--on-conflict', 'skip'], DST)
  check(skipped.code === 0 && /skip=1/.test(skipped.out), '--on-conflict skip plans a skip', skipped.out.slice(-300))
  check(fs.readFileSync(skillFile, 'utf8').includes('local edit'), '--on-conflict skip keeps the local edit')

  const overwritten = run(['import', IMG, '--host', 'workbuddy', '--kind', 'skill', '--yes', '--on-conflict', 'overwrite'], DST)
  check(overwritten.code === 0, '--on-conflict overwrite exits 0')
  check(!fs.readFileSync(skillFile, 'utf8').includes('local edit'), '--on-conflict overwrite replaces the local edit')

  fs.appendFileSync(skillFile, '\nlocal edit 2\n')
  const renamed = run(['import', IMG, '--host', 'workbuddy', '--kind', 'skill', '--yes', '--on-conflict', 'rename'], DST)
  check(renamed.code === 0, '--on-conflict rename exits 0', renamed.out.slice(-300))
  const skillsDir = path.join(DST, '.workbuddy', 'skills')
  const bakDirs = fs.readdirSync(skillsDir).filter((n) => n.includes('.uppenv-bak-'))
  check(bakDirs.length === 1, '--on-conflict rename keeps exactly one backup tree', bakDirs.join(', '))
  const bakFile = bakDirs[0] ? path.join(skillsDir, bakDirs[0], 'SKILL.md') : ''
  check(Boolean(bakFile) && fs.existsSync(bakFile) && fs.readFileSync(bakFile, 'utf8').includes('local edit 2'), 'rename backup keeps the local content')
  check(fs.readFileSync(skillFile, 'utf8').includes('round-trip fixture') && !fs.readFileSync(skillFile, 'utf8').includes('local edit 2'), 'rename installs the image content')
} catch (err) {
  bad(`unexpected error: ${err.message}`)
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

process.stdout.write(`\nround-trip: ${pass} passed, ${fail} failed (${pass + fail} checks)\n`)
process.exit(fail === 0 ? 0 : 1)
