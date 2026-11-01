#!/usr/bin/env node
/**
 * upptool — local registry of reusable tools.
 *
 *   upptool add ./script.mjs --name sheet-to-csv --tag xlsx,csv
 *   upptool list
 *   upptool run sheet-to-csv -- book.xlsx out.csv
 *   upptool suggest "convert a spreadsheet to csv"
 *   upptool batch jobs.json
 *   upptool export -o tools.upptool
 *   upptool import tools.upptool --on-conflict skip
 *
 * Zero dependencies. State lives in UPPTOOL_HOME (default ~/.upptool).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as core from '../lib/upptool/core.mjs'

const TOOL = { name: 'upptool', version: '1.0.0' }
const HERE = path.dirname(fileURLToPath(import.meta.url))

const BOOLEAN = new Set([
  'json',
  'force',
  'help',
  'version',
  'continue-on-error',
  'dry-run',
  'quiet',
])
const VALUED = new Set([
  'name',
  'desc',
  'kind',
  'runtime',
  'entry',
  'command',
  'tag',
  'tags',
  'task',
  'saved-tokens',
  'from-host',
  'host',
  'cwd',
  'timeout',
  'limit',
  'id',
  'o',
  'output',
  'on-conflict',
  'input',
])

function parseArgs(argv) {
  const flags = {}
  const positional = []
  const rest = []
  let afterDashDash = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (afterDashDash) {
      rest.push(arg)
      continue
    }
    if (arg === '--') {
      afterDashDash = true
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      const inline = eq === -1 ? undefined : arg.slice(eq + 1)
      const negated = key.startsWith('no-')
      const base = negated ? key.slice(3) : key
      if (BOOLEAN.has(base)) {
        flags[base] = negated ? false : true
        continue
      }
      if (VALUED.has(base)) {
        const value = inline ?? argv[++i]
        if (value === undefined) fail(`--${base} needs a value`, 'E_USAGE')
        flags[base] = value
        continue
      }
      fail(`unknown flag: --${key}`, 'E_USAGE')
    }
    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const key = arg.slice(1)
      if (VALUED.has(key)) {
        const value = argv[++i]
        if (value === undefined) fail(`-${key} needs a value`, 'E_USAGE')
        flags[key] = value
        continue
      }
      fail(`unknown flag: ${arg}`, 'E_USAGE')
    }
    positional.push(arg)
  }
  return { flags, positional, rest }
}

function fail(message, code = 'E_USAGE') {
  process.stderr.write(`error: ${message}\n`)
  const err = new Error(message)
  err.code = code
  throw err
}

function out(line = '') {
  process.stdout.write(`${line}\n`)
}

function printTable(rows, columns, { maxWidth = 48 } = {}) {
  const widths = columns.map((c) => Math.max(c.title.length, ...rows.map((r) => String(c.get(r) ?? '').length)))
  const clip = (s, w) => (s.length <= w ? s : `${s.slice(0, w - 1)}…`)
  const line = (cells) => cells.map((c, i) => clip(String(c), Math.min(widths[i], maxWidth)).padEnd(Math.min(widths[i], maxWidth))).join('  ')
  out(line(columns.map((c) => c.title)))
  for (const r of rows) out(line(columns.map((c) => c.get(r) ?? '')))
}

function describeRow(t) {
  return {
    id: t.id,
    kind: t.kind,
    runtime: t.runtime,
    runs: t.runs ?? 0,
    saved: t.savedTotal ?? 0,
    tags: (t.tags ?? []).join(','),
    desc: t.desc ?? '',
  }
}

const handlers = {
  add(args, home) {
    const from = args.positional[0]
    const result = core.addTool(home, {
      from,
      name: args.flags.name,
      desc: args.flags.desc ?? '',
      kind: args.flags.kind,
      runtime: args.flags.runtime,
      entry: args.flags.entry,
      command: args.flags.command,
      tags: splitList(args.flags.tag ?? args.flags.tags),
      task: args.flags.task,
      savedTokens: args.flags['saved-tokens'] !== undefined ? Number(args.flags['saved-tokens']) : undefined,
      host: args.flags['from-host'],
      force: Boolean(args.flags.force),
    })
    if (args.flags.json) return printJson(result)
    if (!result.created) {
      out(`skipped: ${result.duplicateOf} is already registered (same content)`)
      out(`hint: run it with  upptool run ${result.duplicateOf} -- <args>`)
    } else {
      out(`registered ${result.tool.id} (${result.tool.kind}/${result.tool.runtime})`)
      out(`  files: ${(result.tool.files ?? []).length}  savedTokens/run: ~${result.tool.savedTokens}`)
      out(`  usage: ${result.tool.usage}`)
    }
    for (const w of result.warnings ?? []) out(`  warning: ${w}`)
    return 0
  },

  list(args, home) {
    const rows = core.listTools(home, { tag: args.flags.tag, kind: args.flags.kind, q: args.positional[0] })
    if (args.flags.json) return printJson({ count: rows.length, tools: rows })
    if (!rows.length) {
      out('no tools registered yet — try: upptool add ./script.mjs --name my-tool')
      return 0
    }
    printTable(rows, [
      { title: 'ID', get: (r) => r.id },
      { title: 'KIND', get: (r) => r.kind },
      { title: 'RUNTIME', get: (r) => r.runtime },
      { title: 'RUNS', get: (r) => String(r.runs ?? 0) },
      { title: 'SAVED', get: (r) => String(r.savedTotal ?? 0) },
      { title: 'DESC', get: (r) => r.desc ?? '' },
    ])
    return 0
  },

  show(args, home) {
    const rec = core.resolveTool(home, args.positional[0])
    if (args.flags.json) return printJson(rec)
    out(`${rec.id} — ${rec.desc || '(no description)'}`)
    out(`  kind      ${rec.kind} / ${rec.runtime}`)
    out(`  usage     ${rec.usage}`)
    if (rec.command) out(`  command   ${rec.command}`)
    out(`  tags      ${(rec.tags ?? []).join(', ') || '-'}`)
    out(`  files     ${(rec.files ?? []).map((f) => f.rel).join(', ') || '-'}`)
    out(`  runs      ${rec.runs ?? 0}  saved ~${rec.savedTotal ?? 0} tokens`)
    out(`  created   ${rec.createdAt}${rec.createdFrom?.task ? `  from: ${rec.createdFrom.task}` : ''}`)
    return 0
  },

  run(args, home) {
    const id = args.positional[0]
    if (!id) fail('usage: upptool run <id> [--] [args...]')
    const result = core.runTool(home, id, args.rest, {
      cwd: args.flags.cwd,
      timeoutMs: args.flags.timeout ? Number(args.flags.timeout) : undefined,
      input: args.flags.input,
    })
    if (args.flags.json) printJson({ ok: result.ok, exit: result.exit, durationMs: result.durationMs, tool: result.tool, stdout: result.stdout, stderr: result.stderr })
    else {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      if (!result.ok) process.stderr.write(`\n[upptool] ${result.tool} exited ${result.exit}\n`)
    }
    return result.ok ? 0 : result.exit || 1
  },

  batch(args, home) {
    const file = args.positional[0]
    if (!file) fail('usage: upptool batch <file.json|jsonl>')
    const result = core.runBatch(home, file, {
      cwd: args.flags.cwd,
      timeoutMs: args.flags.timeout ? Number(args.flags.timeout) : undefined,
      continueOnError: args.flags['continue-on-error'] !== false,
    })
    if (args.flags.json) return printJson(result)
    for (const r of result.results) {
      const name = r.tool ?? r.command
      out(`${r.ok ? 'ok  ' : 'FAIL'} ${name}${r.exit !== undefined ? ` (exit ${r.exit})` : ''}`)
    }
    out(`${result.results.filter((r) => r.ok).length}/${result.items} succeeded`)
    return result.ok ? 0 : 1
  },

  suggest(args, home) {
    const text = args.positional.join(' ') || args.flags.task || ''
    if (!text) fail('usage: upptool suggest "<task description>"')
    const rows = core.suggestTools(home, text, { limit: args.flags.limit ? Number(args.flags.limit) : 5 })
    if (args.flags.json) return printJson({ query: text, tools: rows, matches: rows })
    if (!rows.length) {
      out('no similar tool found — worth registering this one')
      return 0
    }
    for (const r of rows) out(`${r.score.toFixed(2)}  ${r.id}  (${r.why})`)
    return 0
  },

  search(args, home) {
    const q = args.positional.join(' ')
    if (!q) fail('usage: upptool search <query>')
    const rows = core.listTools(home, { q })
    if (args.flags.json) return printJson({ query: q, count: rows.length, tools: rows })
    for (const r of rows) out(`${r.id}  ${r.desc ?? ''}`)
    if (!rows.length) out('no match')
    return 0
  },

  rm(args, home) {
    const id = args.positional[0]
    if (!id) fail('usage: upptool rm <id> [--force]')
    const result = core.removeTool(home, id, { force: Boolean(args.flags.force) })
    if (args.flags.json) return printJson(result)
    if (!result.removed) out(`not removed: ${result.reason}`)
    else out(`removed ${result.tool.id}`)
    return result.removed ? 0 : 1
  },

  export(args, home) {
    const outFile = args.flags.o ?? args.flags.output ?? args.positional[0]
    if (!outFile) fail('usage: upptool export -o <file.upptool>')
    const result = core.exportBundle(home, outFile, { ids: splitList(args.flags.id) })
    if (args.flags.json) return printJson(result)
    out(`bundle written ${result.file} (${result.tools} tool(s), ${(result.size / 1024).toFixed(1)} KB)`)
    return 0
  },

  import(args, home) {
    const file = args.positional[0]
    if (!file) fail('usage: upptool import <file.upptool> [--on-conflict skip|overwrite|rename]')
    const result = core.importBundle(home, file, { onConflict: args.flags['on-conflict'] ?? 'skip' })
    if (args.flags.json) return printJson(result)
    for (const r of result.results) {
      out(`${r.action.padEnd(10)} ${r.id}${r.problems ? `  ${r.problems.join('; ')}` : ''}`)
    }
    return 0
  },

  stats(args, home) {
    const s = core.stats(home)
    if (args.flags.json) return printJson(s)
    out(`home       ${s.home}`)
    out(`tools      ${s.tools}`)
    out(`runs       ${s.runs} (${s.okRuns} ok, ${s.failedRuns} failed)`)
    out(`saved      ~${s.savedTokens} tokens (estimated)`)
    for (const t of s.topTools) out(`  ${t.id}: ${t.runs} run(s), ~${t.savedTotal} tokens`)
    return 0
  },

  doctor(args, home) {
    const report = core.doctor(home)
    if (args.flags.json) return printJson(report)
    for (const c of report.checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.check.padEnd(18)} ${c.detail ?? ''}`)
    return report.ok ? 0 : 1
  },

  version() {
    out(`${TOOL.name} ${TOOL.version} (schema ${core.SCHEMA})`)
    return 0
  },

  help() {
    out(`upptool ${TOOL.version} — local registry of reusable tools

USAGE
  upptool <command> [options]

COMMANDS
  add <file|dir>        register a script/binary/command as a reusable tool
  list                  list registered tools
  show <id>             show one tool record
  run <id> [-- args]    execute a tool locally (no model tokens)
  batch <file>          run a JSON/JSONL list of tools sequentially
  suggest "<task>"      find an existing tool for a task (avoid duplicates)
  search <query>        text search over id/desc/tags
  rm <id>               remove a tool (--force if it was used)
  export -o <file>      bundle tools into one .upptool file
  import <file>         install a bundle (--on-conflict skip|overwrite|rename)
  stats                 runs and estimated tokens saved
  doctor                integrity check
  version | help

OPTIONS
  add:    --name --desc --kind --runtime --entry --command --tag --task
          --saved-tokens --from-host --force
  run:    --cwd --timeout --input
  common: --json  (machine readable output)

EXAMPLES
  upptool add ./sheet-to-csv.mjs --name sheet-to-csv --desc "xlsx -> csv" --tag xlsx,csv
  upptool run sheet-to-csv -- book.xlsx book.csv
  upptool suggest "convert spreadsheet to csv"
  upptool batch jobs.json
  upptool export -o my-tools.upptool   # move them to another machine
`)
    return 0
  },
}

function splitList(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function printJson(value) {
  out(JSON.stringify(value, null, 2))
  return 0
}

function main() {
  const argv = process.argv.slice(2)
  let args
  try {
    args = parseArgs(argv)
  } catch {
    return 2
  }
  const command = args.positional.shift() ?? (args.flags.version ? 'version' : args.flags.help ? 'help' : 'help')
  if (args.flags.help && command !== 'help') {
    handlers.help()
    return 0
  }
  const handler = handlers[command]
  if (!handler) {
    process.stderr.write(`error: unknown command "${command}"\n`)
    handlers.help()
    return 2
  }
  const home = core.root()
  try {
    return handler(args, home) || 0
  } catch (err) {
    if (err?.code === 'E_USAGE') return 2
    process.stderr.write(`error: ${err?.message ?? err}\n`)
    return 1
  }
}

process.exitCode = main()
