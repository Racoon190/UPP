/**
 * uppmem host adapter — WorkBuddy (CodeBuddy-family desktop host).
 *
 * Host memory file (verified against a real install):
 *
 *   ~/.workbuddy/memory/<account-uid>_memory.md
 *     # User Memory Profile
 *     > Last updated: <ISO>
 *     > Version: 0
 *
 *     ## Memory Block
 *     <host-native memory text>
 *     ---
 *     <!-- RAW_JSON_START
 *     { "uid": "...", "memoryBlock": "...", "updatedAt": "..." }
 *     RAW_JSON_END -->
 *
 * Format decision (documented, deliberate): the shared pool is written into an
 * `<!-- uppmem:begin --> ... <!-- uppmem:end -->` section **appended after the
 * RAW_JSON_END marker**, never inside the JSON block. The host rewrites the JSON
 * block wholesale (uid/updatedAt/memoryBlock are host-owned), so touching it
 * would either corrupt the file or be silently reverted. Everything outside the
 * managed section stays byte-for-byte identical, and a managed section that
 * somehow ends up inside the RAW block makes push refuse (see rawGuard).
 *
 * The account id is discovered at runtime (env override -> memory file name ->
 * storage/user-<uid>-personal); it is never hardcoded.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { detectRoots, isDir } from '../../uppenv/core/util.mjs'
import { createTx } from '../../uppenv/core/tx.mjs'

export const name = 'workbuddy'
/** Descriptive: a markdown file with an appended managed section. */
export const memoryFileFormat = 'markdown-managed-section'

const HOST = name
const BEGIN = '<!-- uppmem:begin -->'
const END = '<!-- uppmem:end -->'
const BLOCK_RE = /<!--\s*uppmem:begin\s*-->[\s\S]*?<!--\s*uppmem:end\s*-->\r?\n?/
const RAW_RE = /<!--\s*RAW_JSON_START\s*([\s\S]*?)RAW_JSON_END\s*-->/
const ENTRY_RE = /^-\s+\[([a-z]+)\]\s+(.*?)(?:\s+<!--\s*uppmem:\s*(.*?)\s*-->)?\s*$/
const KINDS = new Set(['fact', 'preference', 'decision', 'project', 'convention', 'task', 'note'])

// ---------------------------------------------------------------------------
// small helpers (kept local so the adapter is self-contained)
// ---------------------------------------------------------------------------

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

/**
 * Text form used for rendering/round-trips: trim + collapse whitespace only.
 * Full-width punctuation and CJK spacing are preserved, so a memory written as
 * 「WB 往返：用户偏好中文界面」comes back byte-identical instead of being NFKC-folded.
 */
const normText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const esc = (text) => text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;')
const unesc = (text) => text.replace(/&lt;!--/g, '<!--').replace(/--&gt;/g, '-->')

const nowIso = (ctx) => {
  const value = typeof ctx?.now === 'function' ? ctx.now() : new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/** ctx may be minimal in tests/CLI: merge detectRoots() with explicit roots. */
function rootsOf(ctx) {
  const env = ctx?.env ?? process.env
  return { ...detectRoots(env), ...(ctx?.roots ?? {}) }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// managed-section rendering / parsing
// ---------------------------------------------------------------------------

function sanitizeKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase()
  return KINDS.has(k) ? k : 'note'
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  for (const raw of tags) {
    const tag = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!tag) continue
    seen.add(tag)
  }
  return [...seen].sort()
}

/** Dedupe by key (LWW) or by normalized-text hash (first wins). */
function dedupeEntries(entries) {
  const out = []
  const byKey = new Map()
  const byHash = new Set()
  for (const raw of entries ?? []) {
    const text = normText(raw?.text)
    if (!text) continue
    const entry = {
      text,
      kind: sanitizeKind(raw?.kind),
      tags: sanitizeTags(raw?.tags),
      updatedAt: raw?.updatedAt ? String(raw.updatedAt) : undefined,
    }
    const key = raw?.key === undefined || raw?.key === null ? '' : String(raw.key).trim()
    if (key) {
      entry.key = key
      if (byKey.has(key)) {
        out[byKey.get(key)] = entry // same key: later definition wins
        continue
      }
      byKey.set(key, out.length)
      out.push(entry)
      continue
    }
    const hash = sha256(text)
    if (byHash.has(hash)) continue
    byHash.add(hash)
    out.push(entry)
  }
  return out
}

/** Render the managed section; always ends with exactly one newline. */
function renderBlock(entries) {
  const lines = [BEGIN, '## Shared memory (managed by uppmem)', '']
  for (const e of entries) {
    const meta = []
    if (e.key) meta.push(`key=${e.key}`)
    if (e.tags?.length) meta.push(`tags=${e.tags.join(',')}`)
    if (e.updatedAt) meta.push(`updated=${e.updatedAt}`)
    const suffix = meta.length ? ` <!-- uppmem:${meta.join(' ')} -->` : ''
    lines.push(`- [${e.kind}] ${esc(e.raw ?? e.text)}${suffix}`)
  }
  if (!entries.length) lines.push('_No entries._')
  lines.push('', END)
  return `${lines.join('\n')}\n`
}

function parseMeta(text) {
  const out = {}
  for (const m of String(text ?? '').matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)=("[^"]*"|\S+)/g)) {
    out[m[1]] = m[2].replace(/^"|"$/g, '')
  }
  return out
}

function parseBlock(body) {
  const entries = []
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = ENTRY_RE.exec(line)
    if (!m) continue
    const text = normText(unesc(m[2] ?? ''))
    if (!text) continue
    const entry = { text, kind: sanitizeKind(m[1]), tags: [], managed: true }
    const meta = parseMeta(m[3])
    if (meta.key) entry.key = meta.key
    if (meta.tags) entry.tags = sanitizeTags(meta.tags.split(','))
    if (meta.updated) entry.updatedAt = meta.updated
    entries.push(entry)
  }
  return entries
}

/**
 * Replace the managed section, or append one after the existing content.
 * Bytes outside the section are never re-serialized.
 */
function spliceBlock(content, block) {
  if (BLOCK_RE.test(content)) return content.replace(BLOCK_RE, block)
  const base = content.endsWith('\n') ? content : `${content}\n`
  return `${base}\n${block}`
}

/** True when the managed markers sit inside the host-owned RAW_JSON block. */
function rawGuard(content) {
  const raw = RAW_RE.exec(content)
  const begin = content.indexOf('uppmem:begin')
  if (!raw || begin < 0) return true
  return begin < raw.index || begin > raw.index + raw[0].length
}

// ---------------------------------------------------------------------------
// account / target discovery (read-only)
// ---------------------------------------------------------------------------

function discoverAccount(ctx, roots) {
  const env = ctx?.env ?? process.env
  const memDir = path.join(roots.workbuddyHome, 'memory')
  const memoryDirExists = isDir(memDir)

  const fromEnv = String(env.UPPENV_WORKBUDDY_ACCOUNT ?? env.WORKBUDDY_ACCOUNT ?? '').trim()
  const candidates = []
  if (memoryDirExists) {
    let names = []
    try {
      names = fs.readdirSync(memDir)
    } catch {
      names = []
    }
    for (const file of names) {
      const m = /^(.+)_memory\.md$/i.exec(file)
      if (!m) continue
      if (file.endsWith('.bak')) continue
      const abs = path.join(memDir, file)
      let mtime = 0
      try {
        mtime = fs.statSync(abs).mtimeMs
      } catch {
        continue
      }
      candidates.push({ account: m[1], mtime, source: 'memory-file' })
    }
  }

  // storage/user-<uid>-personal/... is the other place the account id shows up.
  const storageDir = path.join(roots.workbuddyHome, 'storage')
  if (isDir(storageDir)) {
    let names = []
    try {
      names = fs.readdirSync(storageDir)
    } catch {
      names = []
    }
    for (const dir of names) {
      const m = /^user-(.+)-personal$/.exec(dir)
      if (m) candidates.push({ account: m[1], mtime: 0, source: 'storage' })
    }
  }

  const unique = new Map()
  for (const c of candidates) {
    const prev = unique.get(c.account)
    if (!prev || c.mtime > prev.mtime) unique.set(c.account, c)
  }
  const all = [...unique.values()]

  let account = fromEnv || ''
  let source = fromEnv ? 'env' : ''
  if (!account) {
    const fromMemory = all.filter((c) => c.source === 'memory-file').sort((a, b) => b.mtime - a.mtime)
    if (fromMemory.length) {
      account = fromMemory[0].account
      source = 'memory-file'
    } else if (all.length === 1) {
      account = all[0].account
      source = 'storage'
    }
  }

  return {
    memoryDir: memDir,
    memoryDirExists,
    account: account || null,
    source,
    otherAccounts: all.map((c) => c.account).filter((a) => a !== account),
  }
}

/** @returns {{available:boolean, reason?:string, paths:object, account?:string}} */
function resolveTarget(ctx) {
  const roots = rootsOf(ctx)
  const info = discoverAccount(ctx, roots)
  const paths = {
    memoryDir: info.memoryDir,
    account: info.account ?? undefined,
  }
  if (!info.memoryDirExists) {
    return {
      available: false,
      reason: `WorkBuddy memory directory not found: ${info.memoryDir}`,
      paths,
    }
  }
  if (!info.account) {
    return {
      available: false,
      reason: 'no WorkBuddy account id found (looked at memory/*_memory.md and storage/user-<uid>-personal)',
      paths,
    }
  }
  paths.memoryFile = path.join(info.memoryDir, `${info.account}_memory.md`)
  return { available: true, paths, account: info.account, discovery: info.source, others: info.otherAccounts }
}

// ---------------------------------------------------------------------------
// detect / pull / push
// ---------------------------------------------------------------------------

export function detect(ctx) {
  try {
    const target = resolveTarget(ctx)
    const paths = { ...target.paths }
    const out = {
      host: HOST,
      available: Boolean(target.available),
      paths,
    }
    if (target.reason) out.reason = target.reason
    if (!target.available) return out

    out.paths.account = target.account
    const content = readTextSafe(paths.memoryFile)
    out.paths.exists = content !== null
    if (content !== null) {
      out.paths.size = Buffer.byteLength(content, 'utf8')
      const version = />\s*Version:\s*([^\r\n]+)/.exec(content)
      if (version) out.version = version[1].trim()
      const updated = />\s*Last updated:\s*([^\r\n]+)/.exec(content)
      if (updated) out.paths.updatedAt = updated[1].trim()
      out.paths.hasManagedBlock = BLOCK_RE.test(content)
    }
    if (target.discovery) out.paths.accountSource = target.discovery
    if (target.others?.length) out.paths.otherAccounts = target.others
    return out
  } catch (err) {
    return { host: HOST, available: false, reason: `detect failed: ${err.message}`, paths: {} }
  }
}

export async function pull(ctx) {
  const warnings = []
  const target = resolveTarget(ctx)
  if (!target.available) {
    return { host: HOST, available: false, files: [], warnings: [target.reason] }
  }
  const file = target.paths.memoryFile
  const content = readTextSafe(file)
  if (content === null) {
    return {
      host: HOST,
      available: true,
      files: [{ path: file, format: memoryFileFormat, exists: false, entries: [] }],
      warnings: [`memory file does not exist yet: ${file}`],
    }
  }

  const block = BLOCK_RE.exec(content)
  const entries = block ? parseBlock(block[0]) : []
  if (!block) {
    warnings.push('no managed section yet (nothing has been pushed to this WorkBuddy memory file)')
    if (/^-\s+/m.test(content)) {
      warnings.push(
        'host-native markdown bullets outside the managed section were not imported (ownership is ambiguous: the host may rewrite them)',
      )
    }
  }

  // Host-native memory text lives in the RAW JSON block; surface it read-only.
  const raw = RAW_RE.exec(content)
  if (raw) {
    try {
      const parsed = JSON.parse(raw[1].trim())
      const native = normText(parsed?.memoryBlock)
      if (native) {
        entries.push({
          key: 'workbuddy.memoryBlock',
          text: native,
          kind: 'note',
          tags: [],
          updatedAt: parsed?.updatedAt,
          managed: false,
        })
        warnings.push('host-native memoryBlock imported as a managed:false note entry')
      }
      if (parsed?.uid && target.account && String(parsed.uid) !== String(target.account)) {
        warnings.push(
          `RAW_JSON uid "${parsed.uid}" does not match the memory file name account "${target.account}"`,
        )
      }
    } catch {
      warnings.push('RAW_JSON block is not valid JSON; left untouched and not imported')
    }
  } else {
    warnings.push('no RAW_JSON block found; only the managed section was parsed')
  }

  if (target.others?.length) {
    warnings.push(`other WorkBuddy account memory files present (${target.others.join(', ')}); only "${target.account}" was read`)
  }

  return {
    host: HOST,
    available: true,
    files: [
      {
        path: file,
        format: memoryFileFormat,
        exists: true,
        size: Buffer.byteLength(content, 'utf8'),
        sha256: sha256(content),
        entries,
      },
    ],
    warnings,
  }
}

export async function push(ctx, options = {}) {
  const dryRun = Boolean(options.dryRun ?? ctx?.options?.dryRun ?? false)
  const warnings = []
  const target = resolveTarget(ctx)
  if (!target.available) {
    return {
      host: HOST,
      files: [{ path: target.paths.memoryFile ?? target.paths.memoryDir, action: 'skip', entries: 0, skipped: target.reason }],
      warnings: [target.reason],
    }
  }

  const file = target.paths.memoryFile
  const entries = dedupeEntries(options.entries)
  if (!entries.length) {
    return {
      host: HOST,
      files: [{ path: file, action: 'skip', entries: 0, skipped: 'no entries to push' }],
      warnings: ['push called with 0 entries; the host file was not changed'],
    }
  }

  const current = readTextSafe(file)
  if (current !== null && !rawGuard(current)) {
    const reason = 'managed markers are inside the host-owned RAW_JSON block; refusing to edit this file'
    return { host: HOST, files: [{ path: file, action: 'skip', entries: 0, skipped: reason }], warnings: [reason] }
  }

  // A missing memory file is only created when the account id is known; the
  // skeleton matches the host format so WorkBuddy can keep using it.
  const base =
    current ??
    [
      '# User Memory Profile',
      `> Last updated: ${nowIso(ctx)}`,
      '> Version: 0',
      '',
      '## Memory Block',
      '',
      '',
      '',
      '---',
      '',
      '<!-- RAW_JSON_START',
      '{',
      `  "uid": "${target.account}",`,
      '  "memoryBlock": "",',
      `  "updatedAt": "${nowIso(ctx)}"`,
      '}',
      'RAW_JSON_END -->',
      '',
    ].join('\n')

  const block = renderBlock(entries)
  const next = spliceBlock(base, block)
  const action = current === null ? 'create' : next === current ? 'noop' : 'update'
  const bytes = Buffer.byteLength(next, 'utf8')

  if (action !== 'noop' && !dryRun) {
    const tx = options.tx ?? createTx(path.join(rootsOf(ctx).uppMemHome ?? path.join(rootsOf(ctx).home, '.uppmem'), 'tx'), {
      dryRun: false,
      label: `uppmem push ${HOST}`,
    })
    if (current !== null) tx.backup(file)
    tx.writeFile(file, next)
    tx.log?.({ op: action, host: HOST, path: file, entries: entries.length })
  }

  return {
    host: HOST,
    files: [{ path: file, action, entries: entries.length, bytes }],
    warnings,
  }
}

export default { name, memoryFileFormat, detect, pull, push }
