#!/usr/bin/env node
/**
 * uppmem — one shared memory pool for every agent on this machine.
 *
 *   uppmem add "用户偏好中文回答" --kind preference --tag lang
 *   uppmem search "语言"
 *   uppmem sync --host workbuddy --both       # pull native memory, push the pool back
 *   uppmem mcp                               # expose the pool over MCP (stdio)
 *   uppmem build                             # regenerate MEMORY.md + index.json
 *
 * Zero dependencies. State lives in UPPMEM_HOME (default ~/.uppmem).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as mem from '../lib/uppmem/core.mjs'
import { detectMemoryHosts, createContext, loadMemoryAdapter, MEMORY_HOSTS } from '../lib/uppmem/hosts/index.mjs'
import { runMcpServer } from '../lib/uppmem/mcp-server.mjs'
import { createTx } from '../lib/uppenv/core/tx.mjs'
import { detectRoots } from '../lib/uppenv/core/util.mjs'

const TOOL = { name: 'uppmem', version: '1.1.0' }
const HERE = path.dirname(fileURLToPath(import.meta.url))

const BOOLEAN = new Set(['json', 'help', 'version', 'force', 'dry-run', 'pull', 'push', 'both', 'live', 'quiet', 'summary', 'remove'])
const VALUED = new Set(['kind', 'tag', 'tags', 'key', 'scope', 'source', 'limit', 'host', 'o', 'output', 'on-conflict', 'tx-root'])

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      const inline = eq === -1 ? undefined : arg.slice(eq + 1)
      if (BOOLEAN.has(key)) {
        flags[key] = true
        continue
      }
      if (VALUED.has(key)) {
        const value = inline ?? argv[++i]
        if (value === undefined) usageError(`--${key} needs a value`)
        flags[key] = value
        continue
      }
      usageError(`unknown flag: --${key}`)
    }
    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const key = arg.slice(1)
      if (VALUED.has(key)) {
        const value = argv[++i]
        if (value === undefined) usageError(`-${key} needs a value`)
        flags[key] = value
        continue
      }
      usageError(`unknown flag: ${arg}`)
    }
    positional.push(arg)
  }
  return { flags, positional }
}

function usageError(message) {
  process.stderr.write(`error: ${message}\n`)
  const err = new Error(message)
  err.code = 'E_USAGE'
  throw err
}

const out = (line = '') => process.stdout.write(`${line}\n`)

function printJson(value) {
  out(JSON.stringify(value, null, 2))
  return 0
}

function short(entry) {
  return {
    id: entry.id,
    key: entry.key,
    kind: entry.kind,
    text: entry.text,
    tags: entry.tags,
    updatedAt: entry.updatedAt,
  }
}

function printEntries(rows) {
  if (!rows.length) {
    out('(no memory entries)')
    return
  }
  for (const e of rows) {
    const tags = (e.tags ?? []).length ? `  #${e.tags.join(' #')}` : ''
    out(`${e.id}  [${e.kind}]${e.key ? ` ${e.key}` : ''}  ${e.text}${tags}`)
  }
}

function parseList(value) {
  return value
    ? String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
}

async function cmdAdd(args, home) {
  const text = args.positional.join(' ')
  const result = mem.addEntry(home, {
    text,
    kind: args.flags.kind ?? 'fact',
    tags: parseList(args.flags.tag ?? args.flags.tags),
    key: args.flags.key,
    scope: args.flags.scope ?? 'global',
    source: { host: args.flags.source ?? 'cli', path: null },
  })
  mem.rebuildIndex(home)
  if (args.flags.json) return printJson(result)
  out(`${result.created ? 'added' : 'updated'} ${result.entry.id}  [${result.entry.kind}]`)
  return 0
}

function cmdList(args, home) {
  const rows = mem.listEntries(home, {
    kind: args.flags.kind,
    tag: args.flags.tag,
    scope: args.flags.scope,
    limit: args.flags.limit ? Number(args.flags.limit) : undefined,
  })
  if (args.flags.json) return printJson({ count: rows.length, entries: rows })
  printEntries(rows)
  return 0
}

function cmdSearch(args, home) {
  const query = args.positional.join(' ')
  if (!query) usageError('usage: uppmem search <query>')
  const rows = mem.searchEntries(home, query, {
    kind: args.flags.kind,
    tag: args.flags.tag,
    limit: args.flags.limit ? Number(args.flags.limit) : 20,
  })
  if (args.flags.json) return printJson({ query, count: rows.length, entries: rows })
  printEntries(rows)
  return 0
}

function cmdGet(args, home) {
  const entry = mem.resolveEntry(home, args.positional[0])
  if (args.flags.json) return printJson(entry)
  out(`${entry.id}  [${entry.kind}]${entry.key ? ` ${entry.key}` : ''}`)
  out(entry.text)
  if ((entry.tags ?? []).length) out(`tags: ${entry.tags.join(', ')}`)
  out(`updated: ${entry.updatedAt}`)
  return 0
}

function cmdRemove(args, home) {
  const ref = args.positional[0]
  if (!ref) usageError('usage: uppmem rm <id|key>')
  const result = mem.removeEntry(home, ref)
  mem.rebuildIndex(home)
  if (args.flags.json) return printJson(result)
  out(`removed ${result.entry.id}`)
  return 0
}

function cmdBuild(args, home) {
  const index = mem.rebuildIndex(home)
  if (args.flags.json) return printJson(index)
  out(`built ${index.count} entr${index.count === 1 ? 'y' : 'ies'}`)
  out(`  index    ${mem.paths(home).index}`)
  out(`  digest   ${mem.paths(home).memoryMd}`)
  for (const [kind, n] of Object.entries(index.byKind).sort()) out(`  ${kind.padEnd(12)} ${n}`)
  return 0
}

function cmdExport(args, home) {
  const file = args.flags.o ?? args.flags.output ?? args.positional[0]
  if (!file) usageError('usage: uppmem export -o <file.uppmem>')
  const result = mem.exportBundle(home, file)
  if (args.flags.json) return printJson(result)
  out(`bundle written ${result.file} (${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}, ${(result.size / 1024).toFixed(1)} KB)`)
  return 0
}

function cmdImport(args, home) {
  const file = args.positional[0]
  if (!file) usageError('usage: uppmem import <file.uppmem> [--on-conflict skip|overwrite]')
  const result = mem.importBundle(home, file, { onConflict: args.flags['on-conflict'] ?? 'skip' })
  if (args.flags.json) return printJson(result)
  for (const r of result.results) out(`${String(r.action).padEnd(8)} ${r.id}`)
  return 0
}

async function cmdSync(args, home) {
  const hosts = parseList(args.flags.host ?? MEMORY_HOSTS.join(','))
  const mode = args.flags.pull ? 'pull' : args.flags.push ? 'push' : 'both'
  const dryRun = Boolean(args.flags['dry-run'])
  const roots = detectRoots()
  const results = []
  for (const host of hosts) {
    const row = { host, mode, dryRun }
    try {
      const ctx = createContext({ host, roots, options: { dryRun, onConflict: args.flags['on-conflict'] ?? 'skip' }, log: () => {} })
      const adapter = await loadMemoryAdapter(host, ctx)
      row.available = (await adapter.detect())?.available !== false
      if (mode === 'pull' || mode === 'both') {
        const pulled = await adapter.pull()
        let created = 0
        let updated = 0
        let skipped = 0
        const known = dryRun
          ? new Set(mem.loadEntries(home).flatMap((e) => [e.id, e.hash, e.key].filter(Boolean)))
          : null
        for (const file of pulled.files ?? []) {
          for (const e of file.entries ?? []) {
            if (dryRun) {
              const id = mem.idFor({ key: e.key, text: e.text })
              const hit = known.has(id) || known.has(mem.hashText(e.text)) || (e.key && known.has(e.key))
              if (hit) updated += 1
              else created += 1
              continue
            }
            const res = mem.upsertEntry(home, {
              text: e.text,
              kind: e.kind ?? 'note',
              tags: e.tags ?? [],
              key: e.key,
              source: { host, path: file.path },
              managed: false,
              updatedAt: e.updatedAt,
            })
            if (res.created) created += 1
            else if (res.updated) updated += 1
            else skipped += 1
          }
        }
        row.pull = { files: (pulled.files ?? []).length, created, updated, skipped, warnings: pulled.warnings ?? [] }
      }
      if (mode === 'push' || mode === 'both') {
        const txRoot = args.flags['tx-root'] ?? path.join(home, 'tx')
        const tx = createTx(txRoot, { dryRun, label: `sync-${host}` })
        const entries = mem.poolEntriesForHost(home, host)
        const pushed = await adapter.push({ entries, dryRun, tx })
        row.push = { files: pushed.files ?? [], warnings: pushed.warnings ?? [] }
        if (!dryRun) {
          tx.log({ op: 'sync', host, entries: entries.length })
          tx.commit()
        }
      }
      if (!dryRun) {
        const state = mem.readState(home)
        state.hosts = state.hosts ?? {}
        state.hosts[host] = { lastSyncAt: mem.now(), mode, pull: row.pull ?? null, push: row.push ?? null }
        mem.writeState(home, state)
        mem.rebuildIndex(home)
      }
      row.ok = true
    } catch (err) {
      row.ok = false
      row.error = err?.message ?? String(err)
      row.code = err?.code ?? 'E_SYNC'
    }
    results.push(row)
  }
  if (args.flags.json) return printJson({ dryRun, results })
  for (const r of results) {
    if (!r.ok) {
      out(`FAIL ${r.host}: ${r.error}`)
      continue
    }
    out(`ok   ${r.host}${r.available === false ? ' (host not available)' : ''}`)
    if (r.pull) out(`     pulled ${r.pull.files} file(s): +${r.pull.created} new, ~${r.pull.updated} updated, ${r.pull.skipped} skipped`)
    for (const f of r.push?.files ?? []) out(`     ${String(f.action).padEnd(8)} ${f.path}${f.entries !== undefined ? ` (${f.entries} entries)` : ''}${f.skipped ? ` — ${f.skipped}` : ''}`)
    for (const w of [...(r.pull?.warnings ?? []), ...(r.push?.warnings ?? [])]) out(`     warning: ${w}`)
  }
  if (dryRun) out('dry-run: nothing was written')
  return results.every((r) => r.ok) ? 0 : 1
}

async function cmdHosts(args, home) {
  const roots = detectRoots()
  const ctx = createContext({ host: 'dsh', roots, options: {}, log: () => {} })
  const rows = await detectMemoryHosts(ctx)
  if (args.flags.json) return printJson(rows)
  for (const r of rows) {
    const where = r.paths?.memoryFile ?? r.paths?.skillsDir ?? ''
    const mcp = r.paths?.mcpRegistered ? ' +mcp' : ''
    out(`${r.available ? 'ok  ' : 'none'} ${r.host.padEnd(10)} ${r.installed ? '' : 'adapter missing'} ${where}${mcp}`)
    if (r.reason) out(`     ${r.reason}`)
  }
  return 0
}

async function cmdInstall(args, home) {
  const hosts = parseList(args.flags.host)
  const wantHosts = hosts.length ? hosts : ['dsh']
  const roots = detectRoots()
  const dryRun = Boolean(args.flags['dry-run'])
  const remove = Boolean(args.flags.remove)
  const json = Boolean(args.flags.json)
  const results = []
  let failed = 0

  for (const host of wantHosts) {
    const ctx = createContext({ host, roots, options: { dryRun }, log: () => {} })
    try {
      const adapter = await loadMemoryAdapter(host, ctx)
      if (!adapter.install) {
        const reason = `host "${host}" has no install hook (${MEMORY_HOSTS.join('|')} are the known hosts)`
        results.push({ host, ok: false, error: reason, files: [], warnings: [] })
        if (!json) out(`FAIL     ${host}  ${reason}`)
        failed += 1
        continue
      }
      const tx = createTx(args.flags['tx-root'] ?? path.join(home, 'tx'), { dryRun, label: `install-${host}` })
      const result = await adapter.install({ dryRun, tx, remove })
      if (!dryRun) tx.commit()
      results.push({ host, ok: true, ...result })
      if (!json) {
        for (const f of result.files ?? []) {
          const detail = f.detail ?? f.skipped ?? ''
          out(`${String(f.action).padEnd(8)} ${host.padEnd(10)} ${detail || f.path}`)
          if (detail && f.path) out(`${' '.repeat(8)} ${host.padEnd(10)} ${f.path}`)
        }
        for (const w of result.warnings ?? []) out(`         ${host.padEnd(10)} warning: ${w}`)
      }
    } catch (err) {
      results.push({ host, ok: false, error: err?.message ?? String(err), files: [], warnings: [] })
      if (!json) out(`FAIL     ${host.padEnd(10)} ${err?.message ?? String(err)}`)
      failed += 1
    }
  }

  if (json) printJson(results)
  else if (!dryRun && !failed && !remove) {
    const registered = results.flatMap((r) => (r.files ?? []).map((f) => f.server).filter(Boolean))
    if (registered.length) out(`\nregistered MCP server "${registered[0]}" on ${results.map((r) => r.host).join(', ')} — restart the host to pick it up`)
  }
  return failed ? 1 : 0
}

async function cmdMcp() {
  await runMcpServer({})
  return 0
}

function cmdDoctor(args, home) {
  const report = mem.doctor(home)
  if (args.flags.json) return printJson(report)
  for (const c of report.checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check.padEnd(18)} ${c.detail ?? ''}`)
  return report.ok ? 0 : 1
}

function cmdStats(args, home) {
  const s = mem.stats(home)
  if (args.flags.json) return printJson(s)
  out(`home      ${s.home}`)
  out(`entries   ${s.entries}`)
  for (const [kind, n] of Object.entries(s.byKind).sort()) out(`  ${kind.padEnd(12)} ${n}`)
  out(`tags      ${s.tags.join(', ') || '-'}`)
  out(`hosts     ${s.hosts.join(', ') || '(never synced)'}`)
  return 0
}

function help() {
  out(`uppmem ${TOOL.version} — one shared memory pool for every agent on this machine

USAGE
  uppmem <command> [options]

COMMANDS
  add <text>        store a fact/preference/decision (dedupes by text or --key)
  list              list entries (newest first)
  search <query>    keyword search
  get <id|key>      show one entry
  rm <id|key>       delete an entry
  build             regenerate index.json + MEMORY.md
  export -o <file>  bundle the pool into one .uppmem file
  import <file>     merge a bundle (--on-conflict skip|overwrite)
  sync              pull native memory from hosts and/or push the pool back
  hosts             detect DSH / WorkBuddy / Accio memory locations
  install           register the pool with a host (skill / MCP server)
  mcp               run a stdio MCP server exposing the pool
  doctor            integrity check
  stats             pool statistics

OPTIONS
  add:    --kind fact|preference|decision|project|convention|task|note
          --tag a,b  --key semantic.key  --scope global|host:<name>  --source host
  sync:   --host dsh,workbuddy,accio  --pull|--push|--both (default)  --dry-run
  install:--host dsh,workbuddy,accio  --dry-run  --remove
  common: --json

KEEPING THREE HOSTS IN SYNC
  Agents on all hosts read/write the same pool at ~/.uppmem. Point each host's
  own memory at it with:  uppmem sync --host workbuddy --both
                          uppmem sync --host accio --both
                          uppmem install --host dsh

REGISTERING THE MCP SERVER (agent-callable memory)
  uppmem install --host workbuddy        # ~/.codebuddy/mcp.json -> mcpServers.uppmem
  uppmem install --host accio            # <account>/mcp-servers/custom.json -> servers.uppmem
  uppmem install --host workbuddy,accio --remove
  Then an MCP-capable agent can use:  uppmem mcp
`)
  return 0
}

const COMMANDS = {
  add: cmdAdd,
  list: cmdList,
  search: cmdSearch,
  get: cmdGet,
  rm: cmdRemove,
  build: cmdBuild,
  export: cmdExport,
  import: cmdImport,
  sync: cmdSync,
  hosts: cmdHosts,
  install: cmdInstall,
  mcp: cmdMcp,
  doctor: cmdDoctor,
  stats: cmdStats,
  version: () => {
    out(`${TOOL.name} ${TOOL.version} (schema ${mem.SCHEMA})`)
    return 0
  },
  help: () => help(),
}

async function main() {
  const argv = process.argv.slice(2)
  let args
  try {
    args = parseArgs(argv)
  } catch {
    return 2
  }
  const command = args.positional.shift() ?? (args.flags.version ? 'version' : args.flags.help ? 'help' : 'help')
  const handler = COMMANDS[command]
  if (!handler) {
    process.stderr.write(`error: unknown command "${command}"\n`)
    help()
    return 2
  }
  const home = mem.root()
  try {
    return (await handler(args, home)) ?? 0
  } catch (err) {
    if (err?.code === 'E_USAGE') return 2
    process.stderr.write(`error: ${err?.message ?? err}\n`)
    return 1
  }
}

main().then((code) => {
  process.exitCode = code
})
