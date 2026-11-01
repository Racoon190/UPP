/**
 * uppmem — one shared memory pool for every agent on the machine (DSH /
 * WorkBuddy / Accio), plus sync adapters for each host's native memory file.
 *
 * Layout (under UPPMEM_HOME or ~/.uppmem):
 *   pool/entries/<id>.json   one canonical entry per file
 *   index.json               light index (rebuildable)
 *   MEMORY.md                generated digest an agent can read directly
 *   state.json               per-host sync bookkeeping
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { detectRoots, posix, walk, writeFileAtomic } from '../uppenv/core/util.mjs'
import { readZip, writeZip } from '../uppenv/core/archive.mjs'

export const SCHEMA = 'uppmem/1'
export const KINDS = ['fact', 'preference', 'decision', 'project', 'convention', 'task', 'note']
export const MAX_TEXT = 4000
export const MEMORY_MD_LIMIT = 200

export function now() {
  return new Date().toISOString()
}

export function root(env = process.env) {
  return detectRoots(env).uppMemHome
}

export function paths(home = root()) {
  return {
    home,
    entries: path.join(home, 'pool', 'entries'),
    index: path.join(home, 'index.json'),
    memoryMd: path.join(home, 'MEMORY.md'),
    state: path.join(home, 'state.json'),
  }
}

function ensureDirs(home) {
  const p = paths(home)
  fs.mkdirSync(p.entries, { recursive: true })
  return p
}

/** Stored form: author's characters preserved, whitespace folded. */
export function canonicalText(text) {
  // Stored form: keep the author's characters (full-width punctuation, CJK spacing);
  // only fold runs of whitespace so the same sentence does not fork into two entries.
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** NFKC + collapse whitespace: the identity used for dedupe/ids. */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

export function hashText(text) {
  return crypto.createHash('sha256').update(normalizeText(text)).digest('hex')
}

export function idFor({ key, text }) {
  const seed = key ? `key:${normalizeText(key)}` : `text:${hashText(text)}`
  return `m-${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
}

export class MemError extends Error {
  constructor(message, code = 'E_MEM') {
    super(message)
    this.code = code
  }
}

export function loadEntries(home = root()) {
  const p = paths(home)
  if (!fs.existsSync(p.entries)) return []
  const rows = []
  for (const name of fs.readdirSync(p.entries)) {
    if (!name.endsWith('.json')) continue
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(p.entries, name), 'utf8'))
      if (entry?.schema !== SCHEMA) continue
      rows.push(entry)
    } catch {
      // skip corrupt entry file; doctor reports it
    }
  }
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))
  return rows
}

export function readEntry(home, id) {
  const file = path.join(paths(home).entries, `${id}.json`)
  if (!fs.existsSync(file)) return null
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    return entry?.schema === SCHEMA ? entry : null
  } catch {
    return null
  }
}

export function writeEntry(home, entry) {
  ensureDirs(home)
  writeFileAtomic(path.join(paths(home).entries, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`)
}

function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',')
  return [...new Set(list.map((t) => normalizeText(t).toLowerCase().replace(/\s+/g, '-')).filter(Boolean))]
}

export function addEntry(home, { text, kind = 'fact', tags = [], key, scope = 'global', source } = {}) {
  const verbatim = canonicalText(text)
  const body = verbatim
  if (!body) throw new MemError('memory text is required', 'E_USAGE')
  if (body.length > MAX_TEXT) throw new MemError(`memory text too long (${body.length} > ${MAX_TEXT})`, 'E_LIMIT')
  if (!KINDS.includes(kind)) throw new MemError(`unknown kind "${kind}" (expected ${KINDS.join('|')})`, 'E_USAGE')
  ensureDirs(home)

  const hash = hashText(body)
  const id = idFor({ key, text: body })
  const existing = readEntry(home, id) ?? loadEntries(home).find((e) => e.hash === hash)
  const ts = now()

  if (existing) {
    const entry = {
      ...existing,
      text: body,
      key: key ?? existing.key ?? null,
      kind,
      tags: normalizeTags(tags).length ? normalizeTags(tags) : existing.tags,
      scope,
      source: source ?? existing.source ?? null,
      hash,
      updatedAt: ts,
    }
    writeEntry(home, entry)
    return { created: false, updated: true, entry }
  }

  const entry = {
    schema: SCHEMA,
    id,
    key: key ? normalizeText(key) : null,
    text: body,
    raw: null,
    kind,
    tags: normalizeTags(tags),
    scope,
    source: source ?? null,
    createdAt: ts,
    updatedAt: ts,
    hash,
    managed: true,
  }
  writeEntry(home, entry)
  return { created: true, updated: false, entry }
}

/** Upsert used by host pull; keeps provenance and native (managed:false) marks. */
export function upsertEntry(home, { text, kind = 'note', tags = [], key, source, managed = false, updatedAt }) {
  const verbatim = canonicalText(text)
  const body = verbatim
  if (!body) return { skipped: true, reason: 'empty text' }
  if (body.length > MAX_TEXT) return { skipped: true, reason: 'too long' }
  ensureDirs(home)
  const hash = hashText(body)
  const id = idFor({ key, text: body })
  const existing = readEntry(home, id) ?? loadEntries(home).find((e) => e.hash === hash)
  const ts = updatedAt ?? now()
  if (existing) {
    if (String(existing.updatedAt) > String(ts)) return { skipped: true, reason: 'newer local copy (LWW)' }
    const entry = {
      ...existing,
      text: body,
      kind: existing.managed === false && existing.kind === 'note' ? existing.kind : kind || existing.kind,
      tags: normalizeTags(tags).length ? normalizeTags(tags) : existing.tags,
      source: source ?? existing.source,
      hash,
      updatedAt: ts > existing.updatedAt ? ts : now(),
    }
    writeEntry(home, entry)
    return { updated: true, entry }
  }
  const entry = {
    schema: SCHEMA,
    id,
    key: key ? normalizeText(key) : null,
    text: body,
    raw: null,
    kind: KINDS.includes(kind) ? kind : 'note',
    tags: normalizeTags(tags),
    scope: 'global',
    source: source ?? null,
    createdAt: ts,
    updatedAt: ts,
    hash,
    managed,
  }
  writeEntry(home, entry)
  return { created: true, entry }
}

export function resolveEntry(home, ref) {
  const needle = normalizeText(ref)
  if (!needle) throw new MemError('memory id/key is required', 'E_USAGE')
  const entries = loadEntries(home)
  const exact = entries.find((e) => e.id === needle || e.key === needle)
  if (exact) return exact
  const hits = entries.filter((e) => e.id.startsWith(needle) || (e.key ?? '').includes(needle))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new MemError(`ambiguous ref "${needle}": ${hits.map((e) => e.id).join(', ')}`, 'E_AMBIGUOUS')
  throw new MemError(`memory entry not found: ${needle}`, 'E_NOT_FOUND')
}

export function listEntries(home, { kind, tag, scope, limit } = {}) {
  const tags = tag ? normalizeTags(tag) : []
  const rows = loadEntries(home).filter((e) => {
    if (kind && e.kind !== kind) return false
    if (scope && e.scope !== scope) return false
    if (tags.length && !tags.every((t) => (e.tags ?? []).includes(t))) return false
    return true
  })
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id))
  return limit ? rows.slice(0, Number(limit)) : rows
}

export function searchEntries(home, query, { kind, tag, limit = 20 } = {}) {
  const q = normalizeText(query)
  if (!q) return []
  const tokens = q.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length > 1)
  const cands = listEntries(home, { kind, tag })
  const rows = []
  for (const e of cands) {
    const hay = `${e.text} ${(e.tags ?? []).join(' ')} ${e.kind} ${e.key ?? ''}`.toLowerCase()
    let score = 0
    if (hay.includes(q.toLowerCase())) score += 1
    const hits = tokens.filter((t) => hay.includes(t)).length
    if (tokens.length) score += hits / tokens.length
    if ((e.key ?? '').toLowerCase().includes(q.toLowerCase())) score += 0.5
    if (score > 0) rows.push({ ...e, score: Number(score.toFixed(2)) })
  }
  rows.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return rows.slice(0, Number(limit))
}

export function removeEntry(home, ref) {
  const entry = resolveEntry(home, ref)
  fs.unlinkSync(path.join(paths(home).entries, `${entry.id}.json`))
  return { removed: true, entry }
}

/** Stable identity digest of a set of entries: sha256 of sorted `<id>:<hash>` lines. */
export function entriesDigest(entries = []) {
  const body = entries
    .map((e) => `${e.id}:${e.hash}`)
    .sort()
    .join(String.fromCharCode(10))
  return crypto.createHash('sha256').update(body).digest('hex')
}

export function rebuildIndex(home = root()) {
  const p = ensureDirs(home)
  const entries = loadEntries(home)
  const index = {
    schema: SCHEMA,
    updatedAt: now(),
    count: entries.length,
    digest: entriesDigest(entries),
    byKind: entries.reduce((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1
      return acc
    }, {}),
    entries: entries.map((e) => ({ id: e.id, key: e.key, kind: e.kind, tags: e.tags, updatedAt: e.updatedAt, hash: e.hash, scope: e.scope })),
  }
  writeFileAtomic(p.index, `${JSON.stringify(index, null, 2)}\n`)
  writeFileAtomic(p.memoryMd, renderMemoryMd(entries))
  return index
}

const KIND_ORDER = ['preference', 'convention', 'fact', 'decision', 'project', 'task', 'note']

export function renderMemoryMd(entries, { limit = MEMORY_MD_LIMIT, org = 'uppmem' } = {}) {
  const lines = [
    '# Shared Agent Memory (generated by uppmem)',
    '',
    `> This file is generated from \`~/.uppmem/pool\` — the single memory pool shared by every agent on this machine.`,
    `> Edit with \`${org} add/search/rm\`, not by hand; it is rewritten on every build.`,
    '',
  ]
  const top = entries
    .slice()
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit)
  for (const kind of KIND_ORDER) {
    const group = top.filter((e) => e.kind === kind)
    if (!group.length) continue
    lines.push(`## ${kind}`)
    for (const e of group) {
      const tags = (e.tags ?? []).length ? `  #${e.tags.join(' #')}` : ''
      const key = e.key ? ` [${e.key}]` : ''
      const text = e.text.length > 500 ? `${e.text.slice(0, 497)}…` : e.text
      lines.push(`- ${text}${key}${tags}`)
    }
    lines.push('')
  }
  if (entries.length > limit) lines.push(`_(${entries.length - limit} older entries not shown; use \`uppmem search\`)_`, '')
  return `${lines.join('\n').trimEnd()}\n`
}

export function readState(home = root()) {
  const file = paths(home).state
  if (!fs.existsSync(file)) return { schema: SCHEMA, hosts: {} }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { schema: SCHEMA, hosts: {} }
  }
}

export function writeState(home, state) {
  writeFileAtomic(paths(home).state, `${JSON.stringify(state, null, 2)}\n`)
}

export function stats(home = root()) {
  const entries = loadEntries(home)
  const index = fs.existsSync(paths(home).index) ? JSON.parse(fs.readFileSync(paths(home).index, 'utf8')) : null
  const state = readState(home)
  return {
    home,
    entries: entries.length,
    byKind: entries.reduce((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1
      return acc
    }, {}),
    tags: [...new Set(entries.flatMap((e) => e.tags ?? []))].sort(),
    indexBuiltAt: index?.updatedAt ?? null,
    hosts: Object.keys(state.hosts ?? {}),
    state,
  }
}

export function exportBundle(home, outFile) {
  const entries = loadEntries(home)
  const manifest = {
    schema: SCHEMA,
    kind: 'uppmem-bundle',
    createdAt: now(),
    tool: { name: 'uppmem', version: '1.0.0' },
    entries: entries.map((e) => e.id),
  }
  const rows = [
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
    ...entries.map((e) => ({ name: `pool/entries/${e.id}.json`, data: Buffer.from(`${JSON.stringify(e, null, 2)}\n`) })),
  ]
  rows.sort((a, b) => (a.name < b.name ? -1 : 1))
  const abs = path.resolve(outFile)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  writeZip(abs, rows)
  return { file: abs, entries: entries.length, size: fs.statSync(abs).size }
}

export function importBundle(home, file, { onConflict = 'skip' } = {}) {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) throw new MemError(`bundle not found: ${abs}`, 'E_NOT_FOUND')
  const rows = readZip(abs)
  const manifestRow = rows.find((r) => posix(r.name) === 'manifest.json')
  if (!manifestRow) throw new MemError('bundle has no manifest.json', 'E_INVALID')
  const manifest = JSON.parse(manifestRow.data.toString('utf8'))
  if (manifest.schema !== SCHEMA || manifest.kind !== 'uppmem-bundle') {
    throw new MemError(`unsupported bundle schema: ${manifest.schema}/${manifest.kind}`, 'E_INVALID')
  }
  ensureDirs(home)
  const results = []
  for (const row of rows) {
    const rel = posix(row.name)
    if (rel === 'manifest.json') continue
    if (!rel.startsWith('pool/entries/') || rel.includes('..')) throw new MemError(`illegal entry: ${rel}`, 'E_INVALID')
    const entry = JSON.parse(row.data.toString('utf8'))
    if (entry?.schema !== SCHEMA || !entry.id || !entry.text) {
      results.push({ id: rel, action: 'error', problems: ['invalid entry'] })
      continue
    }
    const existing = readEntry(home, entry.id) ?? loadEntries(home).find((e) => e.hash === entry.hash)
    if (existing) {
      if (onConflict === 'skip') {
        results.push({ id: entry.id, action: 'skip' })
        continue
      }
      const merged = {
        ...existing,
        ...entry,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: String(entry.updatedAt) > String(existing.updatedAt) ? entry.updatedAt : now(),
      }
      writeEntry(home, merged)
      results.push({ id: existing.id, action: 'update' })
      continue
    }
    writeEntry(home, { ...entry, managed: entry.managed !== false })
    results.push({ id: entry.id, action: 'create' })
  }
  rebuildIndex(home)
  return { file: abs, results }
}

export function poolEntriesForHost(home, host, { scope = 'global' } = {}) {
  return loadEntries(home).filter((e) => e.scope === 'global' || e.scope === `host:${host}` || e.scope === scope)
}

export function doctor(home = root()) {
  const p = paths(home)
  const checks = []
  const push = (name, ok, detail) => checks.push({ check: name, ok, detail })
  push('home.writable', canWrite(home), p.home)
  push('entries.readable', fs.existsSync(p.entries) || !fs.existsSync(p.home), p.entries)
  const entries = loadEntries(home)
  const ids = new Set()
  let dup = 0
  let bad = 0
  for (const e of entries) {
    if (ids.has(e.id)) dup += 1
    ids.add(e.id)
    if (!e.text || hashText(e.text) !== e.hash) bad += 1
  }
  push('entries.valid', bad === 0, bad ? `${bad} entries with text/hash mismatch` : `${entries.length} entries ok`)
  push('ids.unique', dup === 0, dup ? `${dup} duplicate id(s)` : 'unique')
  const index = fs.existsSync(p.index) ? JSON.parse(fs.readFileSync(p.index, 'utf8')) : null
  push('index.fresh', Boolean(index) && index.count === entries.length, index ? `count=${index.count} actual=${entries.length}` : 'index missing')
  push('memory.md', fs.existsSync(p.memoryMd), p.memoryMd)
  return { home: p.home, checks, ok: checks.every((c) => c.ok), entries: entries.length }
}

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.uppmem-probe-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** Walk the pool for backup/inspection helpers. */
export function entryFiles(home = root()) {
  const dir = paths(home).entries
  return fs.existsSync(dir) ? walk(dir) : []
}
