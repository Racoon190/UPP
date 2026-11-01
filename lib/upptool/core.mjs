/**
 * upptool — a local registry of reusable tools so an agent can re-run
 * yesterday's script instead of regenerating it (and re-paying the tokens).
 *
 * Layout (under UPPTOOL_HOME or ~/.upptool):
 *   index.json                light index for list/search
 *   tools/<slug>/tool.json    full record
 *   tools/<slug>/files/...    registered files
 *   runs.jsonl                append-only run log
 *   tmp/                      scratch dir
 *
 * Zero dependencies; only Node builtins plus the uppenv archive/util helpers.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

import { detectRoots, posix, rmrf, sha256File, walk, writeFileAtomic } from '../uppenv/core/util.mjs'
import { readZip, writeZip } from '../uppenv/core/archive.mjs'

export const SCHEMA = 'upptool/1'
export const RUNTIMES = ['node', 'bash', 'python', 'exec', 'cmd']
export const KINDS = ['script', 'command', 'batch', 'pipeline']
export const EXIT_USAGE = 2

const RUNTIME_BY_EXT = {
  '.mjs': 'node',
  '.js': 'node',
  '.cjs': 'node',
  '.ts': 'node',
  '.sh': 'bash',
  '.bash': 'bash',
  '.py': 'python',
  '.ps1': 'cmd',
  '.cmd': 'cmd',
  '.bat': 'cmd',
}
const DEFAULT_SAVED_TOKENS = { script: 500, command: 300, batch: 400, pipeline: 600 }

export function now() {
  return new Date().toISOString()
}

export function root(env = process.env) {
  return detectRoots(env).uppToolHome
}

export function paths(home = root()) {
  return {
    home,
    index: path.join(home, 'index.json'),
    toolsDir: path.join(home, 'tools'),
    runs: path.join(home, 'runs.jsonl'),
    tmp: path.join(home, 'tmp'),
  }
}

function ensureDirs(home) {
  const p = paths(home)
  fs.mkdirSync(p.toolsDir, { recursive: true })
  fs.mkdirSync(p.tmp, { recursive: true })
  return p
}

export function slugify(name) {
  const s = String(name ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s || `tool-${Date.now().toString(36)}`
}

function uniqueSlug(home, base) {
  const toolsDir = paths(home).toolsDir
  let slug = base
  let n = 2
  while (fs.existsSync(path.join(toolsDir, slug))) {
    slug = `${base}-${n}`
    n += 1
  }
  return slug
}

export function toolDir(home, slug) {
  return path.join(paths(home).toolsDir, slug)
}

export function recordFile(home, slug) {
  return path.join(toolDir(home, slug), 'tool.json')
}

export function readTool(home, slug) {
  const file = recordFile(home, slug)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function writeTool(home, record) {
  const dir = toolDir(home, record.id)
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(recordFile(home, record.id), `${JSON.stringify(record, null, 2)}\n`)
}

export function contentHash(record) {
  // Content identity only: a tool is "the same tool" when it runs the same way on the
  // same bytes. Labels (name/desc/tags/usage), timestamps and run counters are ignored,
  // so re-registering an identical script under another name reports `duplicateOf`.
  const identity = {
    kind: record.kind ?? 'script',
    runtime: record.runtime ?? 'node',
    command: record.command ?? null,
    entry: record.entry ?? null,
    args: record.args ?? [],
    files: (record.files ?? []).map((f) => ({ sha256: f.sha256, size: f.size })).sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
  }
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export function fileEntries(files) {
  return files
    .map((abs) => ({ abs, rel: null, sha256: sha256File(abs), size: fs.statSync(abs).size }))
    .sort((a, b) => (a.abs < b.abs ? -1 : 1))
}

export function loadIndex(home = root()) {
  const p = paths(home)
  if (!fs.existsSync(p.index)) return { schema: SCHEMA, updatedAt: null, count: 0, tools: [] }
  try {
    const index = JSON.parse(fs.readFileSync(p.index, 'utf8'))
    if (index?.schema !== SCHEMA) return { schema: SCHEMA, updatedAt: null, count: 0, tools: [] }
    return index
  } catch {
    return { schema: SCHEMA, updatedAt: null, count: 0, tools: [] }
  }
}

export function rebuildIndex(home = root()) {
  const p = ensureDirs(home)
  const tools = fs.existsSync(p.toolsDir) ? fs.readdirSync(p.toolsDir) : []
  const rows = []
  for (const slug of tools) {
    const rec = readTool(home, slug)
    if (!rec) continue
    rows.push({
      id: rec.id,
      name: rec.name,
      desc: rec.desc,
      kind: rec.kind,
      runtime: rec.runtime,
      tags: rec.tags ?? [],
      hash: rec.hash,
      runs: rec.runs ?? 0,
      savedTotal: rec.savedTotal ?? 0,
      updatedAt: rec.updatedAt,
    })
  }
  rows.sort((a, b) => a.id.localeCompare(b.id))
  const index = { schema: SCHEMA, updatedAt: now(), count: rows.length, tools: rows }
  writeFileAtomic(p.index, `${JSON.stringify(index, null, 2)}\n`)
  return index
}

export function listTools(home = root(), { tag, kind, q } = {}) {
  const index = loadIndex(home)
  const tags = tag ? String(tag).split(',').map((t) => t.trim()).filter(Boolean) : null
  const needle = q ? String(q).toLowerCase() : null
  return index.tools.filter((t) => {
    if (kind && t.kind !== kind) return false
    if (tags && !tags.every((x) => (t.tags ?? []).includes(x))) return false
    if (needle) {
      const hay = `${t.id} ${t.name} ${t.desc ?? ''} ${(t.tags ?? []).join(' ')}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
}

export class ToolError extends Error {
  constructor(message, code = 'E_TOOL') {
    super(message)
    this.code = code
  }
}

export function resolveTool(home, ref) {
  const index = loadIndex(home)
  const needle = String(ref ?? '').trim()
  if (!needle) throw new ToolError('tool id is required', 'E_USAGE')
  const exact = index.tools.find((t) => t.id === needle || t.name === needle)
  if (exact) return readTool(home, exact.id)
  const hits = index.tools.filter((t) => t.id.startsWith(needle) || t.name.startsWith(needle))
  if (hits.length === 1) return readTool(home, hits[0].id)
  if (hits.length > 1) throw new ToolError(`ambiguous tool "${needle}": ${hits.map((h) => h.id).join(', ')}`, 'E_AMBIGUOUS')
  const sub = index.tools.filter((t) => t.id.includes(needle) || (t.desc ?? '').toLowerCase().includes(needle.toLowerCase()))
  if (sub.length === 1) return readTool(home, sub[0].id)
  if (sub.length > 1) throw new ToolError(`ambiguous tool "${needle}": ${sub.map((h) => h.id).join(', ')}`, 'E_AMBIGUOUS')
  throw new ToolError(`tool not found: ${needle}`, 'E_NOT_FOUND')
}

function runtimeFor(abs) {
  return RUNTIME_BY_EXT[path.extname(abs).toLowerCase()] ?? 'exec'
}

/** Collect files to register from a file or directory path. */
function collectFiles(from) {
  const abs = path.resolve(from)
  if (!fs.existsSync(abs)) throw new ToolError(`path not found: ${abs}`, 'E_NOT_FOUND')
  if (fs.statSync(abs).isDirectory()) {
    return walk(abs).map((f) => ({ abs: f, rel: posix(path.relative(abs, f)) }))
  }
  return [{ abs, rel: path.basename(abs) }]
}

export function addTool(home, spec) {
  const p = ensureDirs(home)
  if (!spec?.name && !spec?.from) throw new ToolError('--name is required when no file/dir is given', 'E_USAGE')
  const name = String(spec.name ?? path.basename(String(spec.from)).replace(/\.[^.]+$/, ''))
  const kind = KINDS.includes(spec.kind) ? spec.kind : spec.command ? 'command' : 'script'
  const warnings = []
  let files = []
  let runtime = spec.runtime
  let entry = spec.entry ?? null

  if (kind === 'command') {
    if (!spec.command) throw new ToolError('--command is required for kind=command', 'E_USAGE')
    runtime = runtime ?? 'exec'
  } else {
    if (!spec.from) throw new ToolError('a file or directory is required (or use --command)', 'E_USAGE')
    files = collectFiles(spec.from)
    runtime = runtime ?? runtimeFor(files[0].abs)
    if (!entry) {
      entry = files.length === 1 ? files[0].rel : files.find((f) => /\.(mjs|js|cjs|py|sh)$/.test(f.rel))?.rel ?? files[0].rel
    }
    if (!files.some((f) => f.rel === entry)) {
      throw new ToolError(`entry "${entry}" is not one of the collected files`, 'E_USAGE')
    }
    if (files.length === 1 && fs.statSync(files[0].abs).size < 400 && (spec.savedTokens ?? 0) < 200) {
      warnings.push('small file (<400B): a tool entry may cost more to maintain than to regenerate')
    }
  }

  const base = slugify(name)
  const existingSameName = loadIndex(home).tools.find((t) => t.id === base)
  // Hash the *source* files first: dedupe must never touch an existing tool dir.
  const sourceEntries = files.map((f) => ({
    rel: `files/${f.rel}`,
    sha256: sha256File(f.abs),
    size: fs.statSync(f.abs).size,
  }))
  const candidate = {
    schema: SCHEMA,
    id: base,
    name,
    desc: spec.desc ?? '',
    kind,
    runtime,
    entry: entry ? `files/${entry}` : null,
    command: kind === 'command' ? String(spec.command) : null,
    args: spec.args ?? [],
    usage: `upptool run ${base} -- <args>`,
    examples: spec.examples ?? [],
    tags: (spec.tags ?? []).map((t) => String(t).toLowerCase()),
    inputs: spec.inputs ?? '',
    outputs: spec.outputs ?? '',
    files: sourceEntries,
    hash: '',
    createdFrom: { task: spec.task ?? '', source: spec.source ?? 'agent', host: spec.host ?? process.platform },
    savedTokens: Number(spec.savedTokens ?? DEFAULT_SAVED_TOKENS[kind] ?? 300),
    version: 1,
    runs: 0,
    lastRunAt: null,
    savedTotal: 0,
  }
  candidate.createdAt = now()
  candidate.updatedAt = candidate.createdAt
  candidate.hash = contentHash(candidate)

  if (!spec.force) {
    const dup = loadIndex(home).tools.find((t) => t.hash === candidate.hash || t.id === base)
    if (dup) {
      return {
        created: false,
        duplicateOf: dup.id,
        warnings: [...warnings, `already registered as "${dup.id}" — run it, or pass --force to replace it`],
        tool: readTool(home, dup.id),
      }
    }
  }

  const slug = existingSameName && spec.force ? base : uniqueSlug(home, base)
  const dir = toolDir(home, slug)
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  for (const f of files) {
    const dest = path.join(dir, 'files', ...f.rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(f.abs, dest)
  }
  const record = { ...candidate, id: slug, usage: `upptool run ${slug} -- <args>` }
  record.hash = contentHash(record)

  writeTool(home, record)
  rebuildIndex(home)
  return { created: true, tool: readTool(home, slug), warnings }
}

export function updateTool(home, ref, patch = {}) {
  const rec = resolveTool(home, ref)
  const next = { ...rec }
  for (const key of ['desc', 'tags', 'args', 'examples', 'inputs', 'outputs', 'savedTokens', 'command', 'runtime', 'kind']) {
    if (patch[key] !== undefined) next[key] = patch[key]
  }
  next.version = (rec.version ?? 1) + 1
  next.updatedAt = now()
  next.hash = contentHash(next)
  writeTool(home, next)
  rebuildIndex(home)
  return next
}

export function removeTool(home, ref, { force = false } = {}) {
  const rec = resolveTool(home, ref)
  if (rec.runs > 0 && !force) {
    return { removed: false, tool: rec, reason: `"${rec.id}" has ${rec.runs} recorded run(s); pass --force to remove` }
  }
  rmrf(toolDir(home, rec.id))
  rebuildIndex(home)
  return { removed: true, tool: rec }
}

function substitute(command, args) {
  let out = String(command)
  out = out.replace(/\$@/g, args.map((a) => quoteArg(a)).join(' '))
  out = out.replace(/\$(\d+)/g, (_, n) => quoteArg(args[Number(n) - 1] ?? ''))
  if (!/\$@|\$\d/.test(String(command)) && args.length) out = `${out} ${args.map(quoteArg).join(' ')}`
  return out
}

function quoteArg(a) {
  const s = String(a)
  return /[\s"'|&<>^]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

function buildSpawn(home, rec, args) {
  const dir = toolDir(home, rec.id)
  switch (rec.runtime) {
    case 'node':
      return { bin: process.execPath, argv: [path.join(dir, rec.entry), ...args], cwd: dir }
    case 'bash':
      return { bin: 'bash', argv: [path.join(dir, rec.entry), ...args], cwd: dir }
    case 'python':
      return { bin: process.env.PYTHON || 'python', argv: [path.join(dir, rec.entry), ...args], cwd: dir }
    case 'cmd': {
      // "cmd" means "run this string through the platform shell", not literally
      // Windows cmd.exe: on POSIX the same recorded tool must still run, so fall
      // back to /bin/sh -c there (this is what CI and macOS users hit).
      const line = substitute(rec.command ?? rec.entry, args)
      if (process.platform === 'win32') {
        return { bin: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', line], cwd: dir }
      }
      return { bin: '/bin/sh', argv: ['-c', line], cwd: dir }
    }
    case 'exec':
    default:
      if (rec.kind === 'command' && rec.command) {
        return { shell: substitute(rec.command, args), cwd: dir }
      }
      return { bin: path.join(dir, rec.entry), argv: args, cwd: dir }
  }
}

export function runTool(home, ref, args = [], { cwd, input, timeoutMs = 120000, env } = {}) {
  const rec = resolveTool(home, ref)
  const p = ensureDirs(home)
  const plan = buildSpawn(home, rec, args)
  const started = Date.now()
  const res = spawnSync(plan.shell ?? plan.bin, plan.argv ?? [], {
    cwd: cwd ? path.resolve(cwd) : plan.cwd,
    env: { ...process.env, ...(env ?? {}), UPPTOOL_HOME: home, UPPTOOL_TOOL_ID: rec.id },
    encoding: 'utf8',
    timeout: timeoutMs,
    input: input ?? undefined,
    shell: Boolean(plan.shell),
    windowsHide: true,
  })
  const durationMs = Date.now() - started
  const exit = res.status ?? (res.error ? 1 : 0)
  const ok = exit === 0 && !res.error
  const savedTokens = Number(rec.savedTokens ?? 0)

  const line = {
    ts: now(),
    id: rec.id,
    ok,
    exit,
    durationMs,
    savedTokens,
    argv: args,
    via: 'cli',
    error: res.error ? String(res.error.message ?? res.error) : undefined,
  }
  fs.appendFileSync(p.runs, `${JSON.stringify(line)}\n`)
  const next = {
    ...rec,
    runs: (rec.runs ?? 0) + 1,
    lastRunAt: line.ts,
    savedTotal: (rec.savedTotal ?? 0) + savedTokens,
  }
  writeTool(home, next)
  rebuildIndex(home)

  return {
    ok,
    exit,
    durationMs,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    savedTokens,
    tool: rec.id,
    logLine: line,
  }
}

export function runBatch(home, file, { cwd, timeoutMs = 120000, continueOnError = true } = {}) {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) throw new ToolError(`batch file not found: ${abs}`, 'E_NOT_FOUND')
  const text = fs.readFileSync(abs, 'utf8').trim()
  let items = []
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text)
    items = Array.isArray(parsed) ? parsed : [parsed]
  } else {
    items = text
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => JSON.parse(l))
  }
  const results = []
  for (const item of items) {
    if (item.command && !item.tool) {
      const rec = spawnSync(item.command, {
        cwd: cwd ? path.resolve(cwd) : process.cwd(),
        shell: true,
        encoding: 'utf8',
        timeout: timeoutMs,
        input: item.input,
        windowsHide: true,
      })
      results.push({ kind: 'command', command: item.command, ok: rec.status === 0, exit: rec.status ?? 1, stdout: rec.stdout ?? '', stderr: rec.stderr ?? '' })
    } else {
      const r = runTool(home, item.tool, item.args ?? [], { cwd, timeoutMs })
      results.push({ kind: 'tool', tool: item.tool, ...r })
    }
    if (!results[results.length - 1].ok && !continueOnError) break
  }
  return { file: abs, items: results.length, results, ok: results.every((r) => r.ok) }
}

export function suggestTools(home, text, { limit = 5 } = {}) {
  const tokens = new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((t) => t.length > 1),
  )
  const rows = []
  for (const t of loadIndex(home).tools) {
    const hay = `${t.id} ${t.name} ${t.desc ?? ''} ${(t.tags ?? []).join(' ')}`.toLowerCase()
    const words = hay.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)
    const overlap = words.filter((w) => tokens.has(w)).length
    const prefix = [...tokens].some((tok) => t.id.startsWith(tok) || t.name.startsWith(tok)) ? 1 : 0
    if (overlap === 0 && !prefix) continue
    const score = Math.min(0.95, overlap / Math.max(3, tokens.size) + prefix * 0.25)
    rows.push({ id: t.id, score: Number(score.toFixed(2)), why: prefix ? 'name prefix match' : `shares ${overlap} keyword(s)` })
  }
  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return rows.slice(0, limit)
}

export function readRunLog(home = root(), limit = 0) {
  const file = paths(home).runs
  if (!fs.existsSync(file)) return []
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return limit > 0 ? lines.slice(-limit) : lines
}

export function stats(home = root()) {
  const index = loadIndex(home)
  const runs = readRunLog(home)
  const okRuns = runs.filter((r) => r.ok)
  return {
    home,
    tools: index.count,
    runs: runs.length,
    okRuns: okRuns.length,
    failedRuns: runs.length - okRuns.length,
    savedTokens: runs.reduce((n, r) => n + (r.savedTokens ?? 0), 0),
    topTools: index.tools
      .slice()
      .sort((a, b) => (b.savedTotal ?? 0) - (a.savedTotal ?? 0))
      .slice(0, 5)
      .map((t) => ({ id: t.id, runs: t.runs ?? 0, savedTotal: t.savedTotal ?? 0 })),
  }
}

export function exportBundle(home, outFile, { ids } = {}) {
  const wanted = ids?.length ? ids.map((id) => resolveTool(home, id)) : loadIndex(home).tools.map((t) => readTool(home, t.id))
  const entries = []
  const manifest = { schema: SCHEMA, kind: 'upptool-bundle', createdAt: now(), tool: { name: 'upptool', version: '1.0.0' }, tools: [] }
  for (const rec of wanted) {
    if (!rec) continue
    manifest.tools.push(rec)
    const dir = toolDir(home, rec.id)
    for (const abs of walk(dir)) {
      entries.push({ name: `tools/${rec.id}/${posix(path.relative(dir, abs))}`, data: fs.readFileSync(abs) })
    }
  }
  entries.push({ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) })
  entries.sort((a, b) => (a.name < b.name ? -1 : 1))
  const abs = path.resolve(outFile)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  writeZip(abs, entries)
  return { file: abs, tools: manifest.tools.length, entries: entries.length, size: fs.statSync(abs).size }
}

export function importBundle(home, file, { onConflict = 'skip' } = {}) {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) throw new ToolError(`bundle not found: ${abs}`, 'E_NOT_FOUND')
  const entries = readZip(abs)
  const manifestEntry = entries.find((e) => posix(e.name) === 'manifest.json')
  if (!manifestEntry) throw new ToolError('bundle has no manifest.json', 'E_INVALID')
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'))
  if (manifest.schema !== SCHEMA || manifest.kind !== 'upptool-bundle') {
    throw new ToolError(`unsupported bundle schema: ${manifest.schema}/${manifest.kind}`, 'E_INVALID')
  }
  const p = ensureDirs(home)
  const installDir = path.join(p.tmp, `import-${Date.now().toString(36)}`)
  fs.mkdirSync(installDir, { recursive: true })
  for (const e of entries) {
    const rel = posix(e.name)
    if (rel === 'manifest.json') continue
    if (rel.includes('..') || rel.startsWith('/')) throw new ToolError(`illegal entry: ${e.name}`, 'E_INVALID')
    const dest = path.join(installDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, e.data)
  }
  const results = []
  for (const rec of manifest.tools) {
    const exists = fs.existsSync(toolDir(home, rec.id))
    if (exists && onConflict === 'skip') {
      results.push({ id: rec.id, action: 'skip' })
      continue
    }
    let targetId = rec.id
    if (exists && onConflict === 'rename') targetId = uniqueSlug(home, rec.id)
    const src = path.join(installDir, 'tools', rec.id)
    const dst = toolDir(home, targetId)
    rmrf(dst)
    fs.mkdirSync(dst, { recursive: true })
    copyDir(src, dst)
    const record = { ...rec, id: targetId }
    // Verify every registered file is present and unchanged.
    const problems = []
    for (const f of record.files ?? []) {
      const fabs = path.join(dst, ...String(f.rel).split('/'))
      if (!fs.existsSync(fabs)) problems.push(`missing ${f.rel}`)
      else if (sha256File(fabs) !== f.sha256) problems.push(`hash mismatch ${f.rel}`)
    }
    if (problems.length) {
      rmrf(dst)
      results.push({ id: rec.id, action: 'error', problems })
      continue
    }
    writeTool(home, record)
    results.push({ id: targetId, action: exists ? (onConflict === 'rename' ? 'renamed' : 'overwrite') : 'create' })
  }
  rmrf(installDir)
  rebuildIndex(home)
  return { file: abs, results }
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dst, { recursive: true })
  for (const abs of walk(src)) {
    const rel = posix(path.relative(src, abs))
    const dest = path.join(dst, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(abs, dest)
  }
}

export function doctor(home = root()) {
  const p = paths(home)
  const checks = []
  const push = (name, ok, detail) => checks.push({ check: name, ok, detail })
  push('home.writable', canWrite(home), p.home)
  push('index.readable', fs.existsSync(p.index) || !fs.existsSync(p.toolsDir), p.index)
  const index = loadIndex(home)
  push('index.schema', index.schema === SCHEMA, index.schema)
  let bad = 0
  for (const t of index.tools) {
    const rec = readTool(home, t.id)
    if (!rec) {
      bad += 1
      continue
    }
    for (const f of rec.files ?? []) {
      const abs = path.join(toolDir(home, t.id), ...String(f.rel).split('/'))
      if (!fs.existsSync(abs) || sha256File(abs) !== f.sha256) bad += 1
    }
  }
  push('files.intact', bad === 0, bad ? `${bad} file(s) missing or changed` : 'all registered files match')
  return { home: p.home, checks, ok: checks.every((c) => c.ok) }
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.upptool-probe-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}
