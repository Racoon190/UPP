#!/usr/bin/env node
/**
 * uppenv — Docker-like environment images for agent hosts (DSH / WorkBuddy / Accio Work).
 *
 *   uppenv detect                     show which hosts are present on this machine
 *   uppenv scan                       list every asset known to the adapters
 *   uppenv export -o env.uppenv       build a portable image from this machine
 *   uppenv inspect env.uppenv         show what an image contains
 *   uppenv verify env.uppenv          check payload hashes / schema
 *   uppenv import env.uppenv          install an image (dry-run first!)
 *   uppenv rollback <txid>|--last     undo an import via its journal
 *   uppenv tx list                    recent import transactions
 *   uppenv doctor                     environment / adapter health
 *
 * Zero dependencies. Node >= 22.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { HOSTS, KINDS, KIND_LABEL, assetKey } from '../lib/uppenv/core/model.mjs'
import { bytes, detectRoots, exists, rmrf } from '../lib/uppenv/core/util.mjs'
import { createTx, rollbackTx } from '../lib/uppenv/core/tx.mjs'
import { createContext, loadAdapter } from '../lib/uppenv/hosts/index.mjs'
import {
  TOOL,
  buildImage,
  saveImage,
  inspectImage,
  verifyImage,
  materialize,
  applyToolSnapshot,
  listToolSnapshots,
  compareToolSurface,
} from '../lib/uppenv/image.mjs'
import { probeServer } from '../lib/uppenv/core/mcp-tools.mjs'

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = {
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s) => (COLOR ? `\x1b[36m${s}\x1b[0m` : s),
}

// ---------------------------------------------------------------- arg parsing

const BOOLEAN = new Set([
  'json', 'force', 'dry-run', 'include-builtin', 'no-verify', 'verbose', 'last',
  'keep-dir', 'yes', 'all', 'help', 'version', 'no-color', 'no-probe-tools', 'live',
])
const VALUED = new Set([
  'o', 'output', 'on-conflict', 'vendor', 'dsh-home', 'host', 'kind', 'id', 'profile', 'probe-timeout',
])

function parseArgs(argv) {
  const flags = {}
  const lists = { host: [], kind: [], id: [] }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    // Support `-o value` / `--output=value` alike; anything else is positional.
    const isLong = tok.startsWith('--')
    const isShort = !isLong && tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)
    if (!isLong && !isShort) {
      positional.push(tok)
      continue
    }
    const body = isLong ? tok.slice(2) : tok.slice(1)
    const eq = body.indexOf('=')
    const name = (eq === -1 ? body : body.slice(0, eq)).toLowerCase()
    const inline = eq === -1 ? undefined : body.slice(eq + 1)
    if (name in lists) {
      const val = inline ?? argv[++i]
      if (val === undefined) throw new Error(`--${name} needs a value`)
      lists[name].push(...String(val).split(',').map((s) => s.trim()).filter(Boolean))
      continue
    }
    if (BOOLEAN.has(name)) {
      flags[name] = inline === undefined ? true : inline !== 'false'
      continue
    }
    if (VALUED.has(name) || inline !== undefined) {
      const val = inline ?? argv[++i]
      if (val === undefined) throw new Error(`--${name} needs a value`)
      flags[name] = val
      continue
    }
    flags[name] = true
  }
  return { flags, lists, positional }
}

const flag = (args, name, dflt) => (name in args.flags ? args.flags[name] : dflt)

function usage(exitCode = 0) {
  const text = `
${c.bold('uppenv')} ${TOOL.version} — environment images for agent hosts (DSH / WorkBuddy / Accio Work)

${c.bold('USAGE')}
  uppenv <command> [options]

${c.bold('COMMANDS')}
  detect                      show which hosts exist on this machine (read-only)
  scan                        list exportable assets (--host, --kind, --json)
  export -o <file.uppenv>     build a portable image (--host, --kind, --id,
                              --include-builtin, --vendor full, --no-probe-tools, --force)
  inspect <image>             show image contents (--json)
  verify <image>              verify payload hashes and schema
  import <image>              install an image (--dry-run recommended first)
                              --host, --kind, --id, --on-conflict skip|overwrite|rename,
                              --no-verify, --yes
  tools                       MCP tool surfaces recorded by imports (--host, --live)
  rollback <txid>|--last      undo an import recorded in ~/.uppenv/tx
  tx list                     recent import transactions
  doctor                      environment and adapter health
  version                     print version

${c.bold('ASSET KINDS')}
  ${KINDS.map((k) => `${k} (${KIND_LABEL[k]})`).join('  ')}

${c.bold('HOSTS')}
  ${HOSTS.join('  ')}
`
  process.stdout.write(`${text}\n`)
  process.exit(exitCode)
}

// -------------------------------------------------------------------- helpers

function upenvHome() {
  return process.env.UPPENV_HOME || path.join(detectRoots().home, '.uppenv')
}

function txRoot() {
  return path.join(upenvHome(), 'tx')
}

function makeCtx(args, extra = {}) {
  const roots = detectRoots()
  const dshHome = flag(args, 'dsh-home')
  if (dshHome) roots.dshHome = String(dshHome)
  const options = {
    dryRun: Boolean(flag(args, 'dry-run', false)),
    onConflict: String(flag(args, 'on-conflict', 'overwrite')),
    includeBuiltin: Boolean(flag(args, 'include-builtin', false)),
    vendor: flag(args, 'vendor', 'auto'),
    verbose: Boolean(flag(args, 'verbose', false)),
    profile: flag(args, 'profile'),
    ...extra,
  }
  return createContext({
    host: extra.host,
    options,
    roots,
    log: (m) => process.stderr.write(`${c.dim(`  ${m}`)}\n`),
  })
}

function pad(s, n) {
  const str = String(s ?? '')
  return str.length <= n ? str.padEnd(n) : `${str.slice(0, Math.max(0, n - 1))}…`
}

function printTable(rows, headers, { maxWidth = 48 } = {}) {
  if (!rows.length) {
    process.stdout.write(`${c.dim('  (none)')}\n`)
    return
  }
  const widths = headers.map((h, i) =>
    Math.min(maxWidth, Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length))),
  )
  const line = (cells) => cells.map((cell, i) => pad(cell, widths[i])).join('  ')
  process.stdout.write(`${c.dim(line(headers))}\n`)
  for (const r of rows) process.stdout.write(`${line(r)}\n`)
}

function jsonOut(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function fail(msg, code = 1) {
  process.stderr.write(`${c.red('error:')} ${msg}\n`)
  process.exit(code)
}

function which(bin) {
  const isWin = process.platform === 'win32'
  const exts = isWin ? ['', '.cmd', '.exe', '.bat', '.ps1'] : ['']
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

function missingPrereqs(requires) {
  const missing = []
  for (const req of requires) {
    const m = /^([a-zA-Z][\w.-]*)(?:>=?\s*([\w.]+))?$/.exec(String(req).trim())
    if (!m) continue
    const [, bin, minVersion] = m
    if (bin === 'node') {
      if (minVersion && process.version.replace(/^v/, '').localeCompare(minVersion, undefined, { numeric: true }) < 0) {
        missing.push(`node>=${minVersion}`)
      }
      continue
    }
    if (!which(bin)) missing.push(bin)
  }
  return missing
}

// ------------------------------------------------------------------- commands

async function cmdDetect(args) {
  const out = []
  for (const host of HOSTS) {
    const ctx = makeCtx(args, { host })
    try {
      const adapter = await loadAdapter(host, ctx)
      out.push({ host, ...(await adapter.detect()) })
    } catch (err) {
      out.push({ host, available: false, reason: err.message })
    }
  }
  if (flag(args, 'json', false)) return jsonOut(out)
  const rows = out.map((i) => [
    i.host,
    i.available === false ? c.red('missing') : c.green('present'),
    i.profile ?? i.account ?? i.version ?? '',
    i.reason ?? firstPath(i),
  ])
  printTable(rows, ['host', 'status', 'detail', 'location'])
}

function firstPath(info) {
  const paths = info.paths ?? info.roots ?? {}
  const first = Object.entries(paths)[0]
  return first ? `${first[0]}=${first[1]}` : ''
}

async function cmdScan(args) {
  const kinds = args.lists.kind.length ? args.lists.kind : KINDS
  const hosts = args.lists.host.length ? args.lists.host : HOSTS
  const all = []
  for (const host of hosts) {
    const ctx = makeCtx(args, { host })
    let adapter
    try {
      adapter = await loadAdapter(host, ctx)
    } catch (err) {
      all.push({ host, error: err.message })
      continue
    }
    try {
      const scanned = (await adapter.scan(ctx, { kinds, ids: args.lists.id, includeBuiltin: Boolean(flag(args, 'include-builtin', false)) })) ?? []
      for (const a of scanned) all.push({ ...a, host })
    } catch (err) {
      all.push({ host, error: `scan failed: ${err.message}` })
    }
  }
  if (flag(args, 'json', false)) return jsonOut(all)
  const rows = all.map((a) =>
    a.error
      ? [c.red('!'), a.host, '-', '-', '-', a.error]
      : [a.kind, a.host, a.id, a.version ?? '', `${a.files?.length ?? 0}f`, a.strategy, a.meta?.source ?? ''],
  )
  printTable(rows, ['kind', 'host', 'id', 'version', 'files', 'strategy', 'source'])
  const ok = all.filter((a) => !a.error)
  process.stdout.write(`\n${c.dim(`${ok.length} asset(s) across ${new Set(ok.map((a) => a.host)).size} host(s)`)}\n`)
}

async function cmdExport(args) {
  const outFile = flag(args, 'o', flag(args, 'output', null)) ?? args.positional[0]
  if (!outFile) fail('export needs an output file: uppenv export -o env.uppenv')
  const kinds = args.lists.kind.length ? args.lists.kind : KINDS
  const hosts = args.lists.host.length ? args.lists.host : HOSTS
  const target = path.resolve(String(outFile))
  const force = Boolean(flag(args, 'force', false))
  if (exists(target) && !force) fail(`output exists: ${target} (use --force)`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uppenv-build-'))
  const options = {
    kinds,
    hosts,
    ids: args.lists.id,
    includeBuiltin: Boolean(flag(args, 'include-builtin', false)),
    vendor: flag(args, 'vendor', 'auto'),
    probeTools: !flag(args, 'no-probe-tools', false),
    probeTimeout: Number(flag(args, 'probe-timeout', 8000)) || 8000,
    roots: detectRoots(),
  }
  const log = (m) => process.stderr.write(`${c.dim(m)}\n`)
  process.stderr.write(`${c.cyan('building image')} hosts=${hosts.join(',')} kinds=${kinds.join(',')}\n`)
  try {
    const { dir, manifest } = await buildImage(tmp, {
      ...options,
      log,
      ctx: createContext({ options, roots: options.roots, log }),
    })
    const saved = saveImage(dir, target, { allowOverwrite: force })
    if (flag(args, 'json', false)) return jsonOut({ file: saved.file, stats: manifest.stats, skipped: manifest.skipped })
    process.stdout.write(`\n${c.green('image written')} ${target} (${bytes(saved.bytes)})\n`)
    printTable(
      Object.entries(manifest.stats.byKind).map(([kind, n]) => [kind, KIND_LABEL[kind] ?? '', n]),
      ['kind', 'label', 'assets'],
    )
    if (manifest.skipped.length) {
      process.stdout.write(`\n${c.yellow(`${manifest.skipped.length} skipped`)}\n`)
      for (const s of manifest.skipped.slice(0, 20)) {
        process.stdout.write(`${c.dim(`  - ${s.host}/${s.kind ?? '-'}/${s.id ?? '-'}: ${s.reason}`)}\n`)
      }
    }
    process.stdout.write(`\n${c.dim('next:')} uppenv inspect ${path.basename(target)}\n`)
  } finally {
    if (!flag(args, 'keep-dir', false)) rmrf(tmp)
  }
}

function cmdInspect(args) {
  const file = args.positional[0]
  if (!file) fail('inspect needs an image file')
  const info = inspectImage(file)
  if (flag(args, 'json', false)) return jsonOut(info)
  const m = info.manifest
  process.stdout.write(`${c.bold('image')} ${info.file} (${bytes(info.size)})\n`)
  process.stdout.write(`${c.dim(`schema ${m.schema} · created ${m.createdAt} · tool ${m.tool?.name} ${m.tool?.version}`)}\n`)
  process.stdout.write(`${c.dim(`source ${m.source?.platform}/${m.source?.arch} node ${m.source?.node}`)}\n\n`)
  printTable(
    m.assets.map((a) => [a.kind, a.host, a.id, a.version ?? '', `${a.files}f`, bytes(a.bytes), a.source ?? '']),
    ['kind', 'host', 'id', 'version', 'files', 'size', 'source'],
  )
  process.stdout.write(`\n${c.dim(`total ${m.stats.assets} asset(s), ${m.stats.human}`)}\n`)
  if (m.skipped?.length) process.stdout.write(`${c.dim(`(${m.skipped.length} asset(s) were skipped at export time)`)}\n`)
}

function cmdVerify(args) {
  const file = args.positional[0]
  if (!file) fail('verify needs an image file')
  const res = verifyImage(file)
  if (flag(args, 'json', false)) {
    jsonOut({ ok: res.ok, checked: res.checked, problems: res.problems })
    process.exitCode = res.ok ? 0 : 1
    return
  }
  if (res.ok) {
    process.stdout.write(`${c.green('OK')} ${res.checked} asset(s) verified, all payload hashes match\n`)
  } else {
    process.stderr.write(`${c.red('FAIL')} ${res.problems.length} problem(s)\n`)
    for (const p of res.problems.slice(0, 40)) process.stderr.write(`  - ${p}\n`)
    process.exitCode = 1
  }
}

/**
 * `uppenv tools` — inventory of MCP tool surfaces recorded by previous imports,
 * optionally re-probing the live servers to report drift against the image.
 */
async function cmdTools(args) {
  const hosts = args.lists.host.length ? args.lists.host : HOSTS
  const live = Boolean(flag(args, 'live', false))
  const rows = []
  for (const host of hosts) {
    const snapshots = listToolSnapshots(path.join(upenvHome(), 'tools', host))
    for (const snap of snapshots) {
      let drift = '-'
      let status = snap.ok ? c.green('ok') : c.yellow('stale')
      if (live) {
        const ctx = makeCtx(args, { host })
        const probe = snap.probe ?? {}
        const expanded = ctx.tpl.expandValue(probe)
        if (!expanded.command) {
          drift = 'no stdio command'
        } else {
          const res = await probeServer(
            { command: expanded.command, args: expanded.args, env: expanded.env, cwd: ctx.roots.home },
            { timeoutMs: Number(flag(args, 'probe-timeout', 8000)) || 8000 },
          )
          if (!res.ok) {
            drift = `probe failed: ${res.error}`
          } else {
            const diff = compareToolSurface(snap.tools ?? [], res.tools ?? [])
            if (diff.same) {
              drift = 'in sync'
            } else {
              status = c.yellow('drift')
              drift = `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`
            }
          }
        }
      }
      rows.push([host, snap.server?.name ?? path.basename(snap.file, '.json'), String((snap.tools ?? []).length), status, drift])
    }
  }
  if (flag(args, 'json', false)) {
    return jsonOut(
      rows.map((r, i) => ({
        host: r[0],
        server: r[1],
        tools: Number(r[2]),
        status: i < 0 ? '' : String(r[3]).replace(/\x1b\[[0-9;]*m/g, ''),
        drift: r[4],
      })),
    )
  }
  if (!rows.length) {
    process.stdout.write(`${c.dim(`no tool snapshots under ${path.join(upenvHome(), 'tools')}`)}\n`)
    process.stdout.write(`${c.dim('import an image that contains tool assets first, e.g. uppenv import env.uppenv')}\n`)
    return
  }
  printTable(rows, ['host', 'server', 'tools', 'status', 'drift'], { maxWidth: 60 })
}

async function cmdImport(args) {
  const file = args.positional[0]
  if (!file) fail('import needs an image file')
  const abs = path.resolve(file)
  if (!exists(abs)) fail(`no such image: ${abs}`)

  const dryRun = Boolean(flag(args, 'dry-run', false))
  const onConflict = String(flag(args, 'on-conflict', 'overwrite'))
  if (!['skip', 'overwrite', 'rename'].includes(onConflict)) fail(`invalid --on-conflict ${onConflict}`)
  const kinds = args.lists.kind.length ? args.lists.kind : KINDS
  const hosts = args.lists.host.length ? args.lists.host : HOSTS
  const ids = args.lists.id

  if (!flag(args, 'no-verify', false)) {
    const v = verifyImage(abs)
    if (!v.ok) {
      if (flag(args, 'json', false)) jsonOut({ ok: false, problems: v.problems })
      fail(`image failed verification (${v.problems.length} problems); use --no-verify to force`)
    }
  }

  const mat = materialize(abs)
  const tx = createTx(txRoot(), { dryRun, label: path.basename(abs) })
  const results = []
  try {
    const selected = mat.assets.filter(
      (a) => hosts.includes(a.host) && kinds.includes(a.kind) && (!ids.length || ids.includes(a.id)),
    )
    process.stderr.write(
      `${c.cyan(dryRun ? 'planning import (dry-run)' : 'importing')} ${selected.length}/${mat.assets.length} asset(s) from ${path.basename(abs)}\n`,
    )
    for (const asset of selected) {
      const ctx = makeCtx(args, { host: asset.host, dryRun, onConflict })
      try {
        // `tool` assets are MCP tool-surface snapshots: hosts discover tools at
        // runtime, so importing one records the expected surface in uppenv's own
        // store instead of touching the host.
        if (asset.kind === 'tool') {
          const res = applyToolSnapshot(asset, {
            snapshotRoot: path.join(upenvHome(), 'tools', asset.host),
            tx,
            dryRun,
          })
          results.push({ asset, result: { ...res, reason: 'tool-surface snapshot (verified by host at runtime)' } })
          continue
        }
        let adapter
        try {
          adapter = await loadAdapter(asset.host, ctx)
        } catch (err) {
          results.push({ asset, action: 'missing-host', reason: err.message, targets: [] })
          continue
        }
        if (asset.requires?.length) {
          const missing = missingPrereqs(asset.requires)
          if (missing.length) {
            results.push({ asset, action: 'missing-prereq', reason: `missing prerequisites: ${missing.join(', ')}`, targets: [] })
            continue
          }
        }
        if (dryRun) {
          const plan = await adapter.plan(asset, ctx)
          results.push({ asset, plan })
          continue
        }
        if (onConflict === 'rename') await renameConflicting(asset, adapter, ctx, tx)
        const res = await adapter.apply(asset, ctx, tx)
        results.push({ asset, result: res })
      } catch (err) {
        results.push({ asset, action: 'error', reason: err.message, targets: [] })
      }
    }

    const summary = tx.commit({ dryRun, image: abs, results: results.map(simplify) })
    if (flag(args, 'json', false)) {
      jsonOut({ dryRun, tx: tx.id, results: results.map(simplify), actions: summary.actions ?? null })
      if (results.some((r) => actionOf(r) === 'error')) process.exitCode = 1
      return
    }

    const rows = results.map((r) => {
      const action = actionOf(r)
      const targets = (r.plan?.targets ?? r.result?.targets ?? []).map((t) => t.path)
      const reason = r.reason ?? r.result?.reason ?? r.result?.error ?? ''
      const color =
        action === 'error' || action === 'missing-host' || action === 'missing-prereq'
          ? c.red
          : action === 'skip' || action === 'noop'
            ? c.dim
            : c.green
      return [color(action), r.asset.kind, r.asset.host, r.asset.id, targets[0] ?? '', targets.length > 1 ? `+${targets.length - 1}` : '', reason]
    })
    printTable(rows, ['action', 'kind', 'host', 'id', 'first target', 'more', 'reason'])

    const counts = {}
    for (const r of results) {
      const a = actionOf(r)
      counts[a] = (counts[a] ?? 0) + 1
    }
    process.stdout.write(`\n${c.dim('summary:')} ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}\n`)
    if (dryRun) {
      process.stdout.write(`${c.yellow('dry-run: nothing was written')} — rerun without --dry-run to apply\n`)
    } else {
      process.stdout.write(`${c.dim(`transaction: ${tx.id}`)}\n`)
      process.stdout.write(`${c.dim('undo with:')} uppenv rollback --last\n`)
    }
    if (results.some((r) => actionOf(r) === 'error')) process.exitCode = 1
  } finally {
    mat.cleanup()
    if (dryRun) rmrf(tx.dir)
  }
}

const actionOf = (r) => r.action ?? r.plan?.action ?? r.result?.action ?? '?'
const simplify = (r) => ({
  key: assetKey(r.asset),
  kind: r.asset.kind,
  host: r.asset.host,
  id: r.asset.id,
  action: actionOf(r),
  targets: (r.plan?.targets ?? r.result?.targets ?? []).map((t) => ({ path: t.path, action: t.action })),
  reason: r.reason ?? r.plan?.reason ?? r.result?.reason ?? r.result?.error,
})

/** --on-conflict rename: move colliding targets aside, then apply as overwrite. */
async function renameConflicting(asset, adapter, ctx, tx) {
  const plan = await adapter.plan(asset, ctx)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  for (const target of plan.targets ?? []) {
    if (target.action !== 'update') continue
    if (!exists(target.path)) continue
    const to = `${target.path}.uppenv-bak-${stamp}`
    tx.rename(target.path, to)
    process.stderr.write(`${c.dim(`  renamed aside: ${target.path} -> ${path.basename(to)}`)}\n`)
  }
}

function cmdRollback(args) {
  let id = args.positional[0]
  if (!id && flag(args, 'last', false)) id = listTx()[0]?.id
  if (!id) fail('rollback needs a transaction id (see: uppenv tx list) or --last')
  const txDir = path.join(txRoot(), id)
  if (!exists(txDir)) fail(`no such transaction: ${id}`)
  const res = rollbackTx(txDir)
  if (flag(args, 'json', false)) return jsonOut(res)
  process.stdout.write(`${c.green('rolled back')} ${res.tx}: restored ${res.restored}, removed ${res.removed}\n`)
  if (res.skipped.length) {
    process.stdout.write(`${c.yellow(`${res.skipped.length} command(s) were not undone automatically:`)}\n`)
    for (const s of res.skipped) process.stdout.write(`  - ${s}\n`)
  }
}

function listTx() {
  const root = txRoot()
  if (!exists(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(root, d.name)
      let result = null
      try {
        result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'))
      } catch {
        result = null
      }
      return { id: d.name, dir, result, rolled: exists(path.join(dir, 'rolled-back.json')) }
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1))
}

function cmdTx(args) {
  const sub = args.positional[0] ?? 'list'
  if (sub !== 'list') fail(`unknown tx subcommand: ${sub}`)
  const txs = listTx()
  if (flag(args, 'json', false)) {
    return jsonOut(txs.map((t) => ({ id: t.id, label: t.result?.label, rolledBack: t.rolled, actions: t.result?.actions?.length ?? 0 })))
  }
  printTable(
    txs.slice(0, 30).map((t) => [
      t.id,
      t.result?.label ?? '-',
      t.rolled ? c.dim('rolled back') : t.result ? c.green('applied') : c.yellow('incomplete'),
      String(t.result?.actions?.length ?? 0),
    ]),
    ['tx', 'label', 'status', 'actions'],
  )
}

async function cmdDoctor(args) {
  const roots = detectRoots()
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail })
  add('node >= 22', Number(process.versions.node.split('.')[0]) >= 22, process.version)
  add('uppenv home', true, upenvHome())
  add('tx dir', true, txRoot())
  const homeChecks = [
    ['DSH home', roots.dshHome],
    ['DSH profile', path.join(roots.dshHome, 'profiles', 'desktop')],
    ['WorkBuddy home', roots.workbuddyHome],
    ['CodeBuddy mcp.json', path.join(roots.codebuddyHome, 'mcp.json')],
    ['Accio home', roots.accioHome],
    ['UPP store', path.join(roots.uppStore, 'store')],
  ]
  for (const [name, p] of homeChecks) add(name, exists(p), p)
  for (const host of HOSTS) {
    try {
      const adapter = await loadAdapter(host, makeCtx(args, { host }))
      const info = await adapter.detect()
      add(`adapter ${host}`, info.available !== false, info.reason ?? info.version ?? 'ok')
    } catch (err) {
      add(`adapter ${host}`, false, err.message)
    }
  }
  if (flag(args, 'json', false)) {
    return jsonOut(checks.map((ch) => ({ ...ch, detail: String(ch.detail) })))
  }
  for (const ch of checks) {
    const mark = ch.ok ? c.green('ok  ') : c.yellow('warn')
    process.stdout.write(`${mark} ${pad(ch.name, 22)} ${c.dim(String(ch.detail ?? ''))}\n`)
  }
  const bad = checks.filter((ch) => !ch.ok).length
  process.stdout.write(`\n${bad ? c.yellow(`${bad} warning(s)`) : c.green('all checks passed')}\n`)
}

// ----------------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const args = parseArgs(argv.slice(1))
  switch (command) {
    case 'detect':
      return cmdDetect(args)
    case 'scan':
    case 'ls':
      return cmdScan(args)
    case 'export':
    case 'build':
    case 'save':
      return cmdExport(args)
    case 'inspect':
    case 'info':
      return cmdInspect(args)
    case 'verify':
      return cmdVerify(args)
    case 'import':
    case 'load':
      return cmdImport(args)
    case 'rollback':
      return cmdRollback(args)
    case 'tools':
      return cmdTools(args)
    case 'tx':
      return cmdTx(args)
    case 'doctor':
      return cmdDoctor(args)
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`uppenv ${TOOL.version} (schema 1)\n`)
      return
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return usage(0)
    default:
      process.stderr.write(`${c.red('unknown command:')} ${command}\n`)
      return usage(1)
  }
}

main().catch((err) => {
  process.stderr.write(`${c.red('fatal:')} ${err?.stack ?? err}\n`)
  process.exit(1)
})
