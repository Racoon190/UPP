/**
 * uppmem host adapter — Accio Work.
 *
 * Host memory file (verified against a real install):
 *
 *   ~/.accio/accounts/<account-id>/global-memory/PROFILE.md
 *     # User Profile (Global Memory)
 *     Account-level personalization shared across Main Agent conversations.
 *     This profile is read-only to the Main Agent and managed by the host application.
 *
 *     ## Accounts & Stores
 *     - <!-- e.g. Taobao shop URL, ... -->
 *     ## Preferences
 *     - <!-- language, tone, ... -->
 *     ## Notes
 *     - <!-- other durable personalization -->
 *
 * Format decision (documented, deliberate): the host declares PROFILE.md
 * host-managed and rewrites it from its own model, so the adapter never
 * re-serializes existing lines — it only replaces (or appends, on first write)
 * the `<!-- uppmem:begin --> ... <!-- uppmem:end -->` section at the end of the
 * file. All other bytes stay identical; the managed block therefore survives a
 * host rewrite that keeps unknown trailing content, and is cheap to re-add
 * (idempotent) if the host drops it.
 *
 * Everything in Accio is account-scoped, so the account id is discovered from
 * `<accioHome>/accounts/*` (preferring accounts that have a `skills/` dir) and
 * is never hardcoded. When several accounts exist and no env override selects
 * one, the adapter reports unavailable instead of guessing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { detectRoots, isDir } from '../../uppenv/core/util.mjs'
import { createTx } from '../../uppenv/core/tx.mjs'

export const name = 'accio'
/** Descriptive: a markdown file with an appended managed section. */
export const memoryFileFormat = 'markdown-managed-section'

const HOST = name
const BEGIN = '<!-- uppmem:begin -->'
const END = '<!-- uppmem:end -->'
const BLOCK_RE = /<!--\s*uppmem:begin\s*-->[\s\S]*?<!--\s*uppmem:end\s*-->\r?\n?/
const ENTRY_RE = /^-\s+\[([a-z]+)\]\s+(.*?)(?:\s+<!--\s*uppmem:\s*(.*?)\s*-->)?\s*$/
const KINDS = new Set(['fact', 'preference', 'decision', 'project', 'convention', 'task', 'note'])

// Native section -> canonical kind. Accio's template has exactly these headings;
// unknown headings fall back to `note`. Only used for pull (managed:false).
const SECTION_KIND = [
  [/accounts?|stores?|店铺|账号/i, 'fact'],
  [/preferences?|偏好/i, 'preference'],
  [/notes?|备注|说明/i, 'note'],
]

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
    if (tag) seen.add(tag)
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
        out[byKey.get(key)] = entry
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
 * Replace the managed section, or append one at the end of the file.
 * Existing (host-managed) lines are never re-serialized.
 */
function spliceBlock(content, block) {
  if (BLOCK_RE.test(content)) return content.replace(BLOCK_RE, block)
  const base = content.endsWith('\n') ? content : `${content}\n`
  return `${base}\n${block}`
}

/**
 * Native bullets outside the managed block, mapped to `managed: false` entries.
 * Placeholder bullets that only contain an HTML comment (Accio's template
 * examples) are skipped: they carry no user content.
 */
function parseNativeBullets(content) {
  const out = []
  const mutable = BLOCK_RE.test(content) ? content.replace(BLOCK_RE, '') : content
  let heading = ''
  for (const line of mutable.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      heading = h[1]
      continue
    }
    const b = /^-\s+(.+?)\s*$/.exec(line)
    if (!b) continue
    let text = b[1]
    const comment = /^(?:<!--[\s\S]*?-->)$/.test(text.trim())
    if (comment) continue // pure template placeholder
    text = normText(text.replace(/<!--[\s\S]*?-->/g, ''))
    if (!text) continue
    let kind = 'note'
    for (const [re, k] of SECTION_KIND) {
      if (re.test(heading)) {
        kind = k
        break
      }
    }
    out.push({ text, kind, tags: [], managed: false })
  }
  return out
}

// ---------------------------------------------------------------------------
// account / target discovery (read-only)
// ---------------------------------------------------------------------------

function discoverAccount(ctx, roots) {
  const env = ctx?.env ?? process.env
  const accountsDir = path.join(roots.accioHome, 'accounts')
  const out = { accountsDir, accounts: [], account: null, source: '' }
  if (!isDir(accountsDir)) return out

  try {
    out.accounts = fs
      .readdirSync(accountsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    out.accounts = []
  }
  if (!out.accounts.length) return out

  const fromEnv = String(env.UPPENV_ACCIO_ACCOUNT ?? env.ACCIO_ACCOUNT ?? '').trim()
  if (fromEnv) {
    out.account = out.accounts.includes(fromEnv) ? fromEnv : null
    out.source = out.account ? 'env' : ''
    if (!out.account) out.envMiss = fromEnv
    return out
  }

  // Prefer accounts that actually have an initialized skills/ workspace.
  const initialized = out.accounts.filter((a) => isDir(path.join(accountsDir, a, 'skills')))
  const candidates = initialized.length ? initialized : out.accounts
  if (candidates.length === 1) {
    out.account = candidates[0]
    out.source = 'accounts-dir'
  } else {
    out.ambiguous = candidates
  }
  return out
}

/** @returns {{available:boolean, reason?:string, paths:object, account?:string}} */
function resolveTarget(ctx) {
  const roots = rootsOf(ctx)
  const info = discoverAccount(ctx, roots)
  const paths = { accountsDir: info.accountsDir, account: info.account ?? undefined }
  if (info.accounts.length === 0) {
    return { available: false, reason: `no Accio account workspace under ${info.accountsDir}`, paths }
  }
  if (info.envMiss) {
    return { available: false, reason: `Accio account "${info.envMiss}" (from env) does not exist under ${info.accountsDir}`, paths }
  }
  if (!info.account) {
    return {
      available: false,
      reason: `multiple Accio accounts (${(info.ambiguous ?? info.accounts).join(', ')}); set UPPENV_ACCIO_ACCOUNT to choose one`,
      paths,
    }
  }
  const accountDir = path.join(info.accountsDir, info.account)
  paths.accountDir = accountDir
  paths.memoryDir = path.join(accountDir, 'global-memory')
  paths.memoryFile = path.join(paths.memoryDir, 'PROFILE.md')
  return { available: true, paths, account: info.account, discovery: info.source, others: info.ambiguous }
}

// ---------------------------------------------------------------------------
// detect / pull / push
// ---------------------------------------------------------------------------

export function detect(ctx) {
  try {
    const target = resolveTarget(ctx)
    const out = { host: HOST, available: Boolean(target.available), paths: { ...target.paths } }
    if (target.reason) out.reason = target.reason
    out.paths.accounts = discoverAccount(ctx, rootsOf(ctx)).accounts
    if (!target.available) return out

    out.paths.account = target.account
    const content = readTextSafe(target.paths.memoryFile)
    out.paths.exists = content !== null
    if (content !== null) {
      out.paths.size = Buffer.byteLength(content, 'utf8')
      const version = />\s*Version:\s*([^\r\n]+)/.exec(content)
      if (version) out.version = version[1].trim()
      out.paths.hasManagedBlock = BLOCK_RE.test(content)
      // The host's own wording: PROFILE.md is host-managed and read-only to
      // the agent. We only append, so this is informational for the CLI.
      out.paths.hostManaged = /read-only to the Main Agent/i.test(content)
    }
    if (target.discovery) out.paths.accountSource = target.discovery
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
      warnings: [`global memory profile does not exist yet: ${file}`],
    }
  }

  const block = BLOCK_RE.exec(content)
  const entries = block ? parseBlock(block[0]) : []
  if (block) entries.push(...parseNativeBullets(content))

  const native = entries.filter((e) => !e.managed).length
  if (!block) {
    warnings.push(
      native
        ? `no managed section found; imported ${native} host-native bullet(s) as managed:false`
        : 'no managed section found (host template placeholders only); nothing imported',
    )
  } else if (native) {
    warnings.push(
      `${native} host-native profile bullet(s) imported as managed:false entries; PROFILE.md is host-managed, so treat them as read-only context`,
    )
  }
  if (/read-only to the Main Agent/i.test(content)) {
    warnings.push('PROFILE.md declares itself host-managed/read-only; uppmem only appends a managed section')
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
      files: [{ path: target.paths.memoryFile ?? target.paths.accountsDir, action: 'skip', entries: 0, skipped: target.reason }],
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
  // Missing PROFILE.md (fresh account workspace): create the host template
  // skeleton plus the managed section, so Accio and uppmem agree on the file.
  const base =
    current ??
    [
      '# User Profile (Global Memory)',
      '',
      'Account-level personalization shared across Main Agent conversations.',
      'This profile is read-only to the Main Agent and managed by the host application.',
      '',
      '## Accounts & Stores',
      '',
      '## Preferences',
      '',
      '## Notes',
      '',
    ].join('\n')

  const block = renderBlock(entries)
  const next = spliceBlock(base, block)
  const action = current === null ? 'create' : next === current ? 'noop' : 'update'
  const bytes = Buffer.byteLength(next, 'utf8')

  if (action !== 'noop' && !dryRun) {
    const roots = rootsOf(ctx)
    const tx =
      options.tx ??
      createTx(path.join(roots.uppMemHome ?? path.join(roots.home, '.uppmem'), 'tx'), {
        dryRun: false,
        label: `uppmem push ${HOST}`,
      })
    if (current !== null) tx.backup(file)
    tx.writeFile(file, next)
    tx.log?.({ op: action, host: HOST, path: file, entries: entries.length })
    if (action === 'create') warnings.push(`created ${file} with the Accio profile template skeleton`)
  } else if (action !== 'noop' && dryRun) {
    warnings.push('dry-run: managed section planned, nothing written')
  }

  return {
    host: HOST,
    files: [{ path: file, action, entries: entries.length, bytes }],
    warnings,
  }
}

export default { name, memoryFileFormat, detect, pull, push }
