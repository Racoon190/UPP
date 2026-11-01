/**
 * uppmem host adapter — DSH (DeepSeek Harness).
 *
 * Host knowledge encoded here:
 *   - DSH has NO native memory file. Sessions/storages are host-managed, so there
 *     is nothing to "pull" from the host in the way WorkBuddy/Accio have memory
 *     files. Instead this adapter installs a SKILL that makes the shared uppmem
 *     pool discoverable to a DSH agent, plus a bounded snapshot it can read
 *     directly:
 *
 *       <dshHome>/skills/upp-memory/SKILL.md    instructions (installed once)
 *       <dshHome>/skills/upp-memory/MEMORY.md   generated snapshot (managed region)
 *
 *   - Skills are hot-watched by DSH; a directory with SKILL.md is picked up
 *     without a restart. Extra files next to SKILL.md (MEMORY.md) are fine.
 *   - The canonical pool lives in ~/.uppmem; MEMORY.md is only a cache so an
 *     agent can answer common questions without a tool call. `uppmem search`
 *     against the pool remains the source of truth.
 *
 * Managed region grammar (also emitted by `push`, parsed by `pull`):
 *
 *   <!-- uppmem:begin -->
 *   - [fact] 用户偏好用中文回答 #lang #preference
 *   <!-- uppmem:end -->
 *
 * One bullet per entry: `- [<kind>] <one-line text> [#tag ...]`. Text is
 * whitespace-collapsed; trailing `#token` groups are read back as tags. The
 * snapshot is lossy by design (bounded ~200 entries, no ids/timestamps per
 * entry) — the pool keeps the canonical record.
 *
 * All writes go through the uppmem `tx` (lib/uppenv/core/tx.mjs) so an import
 * can be rolled back; `dryRun` never touches the filesystem. Paths come only
 * from `ctx.roots` (never hard-coded).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { exists, isDir, readText, sha256, writeFileAtomic } from '../../uppenv/core/util.mjs'

export const name = 'dsh'

/** DSH memory is a generated skill snapshot, not a host-native memory file. */
export const memoryFileFormat = 'skill-snapshot'

const SKILL_DIR_NAME = 'upp-memory'
const SKILL_FILE = 'SKILL.md'
const MEMORY_FILE = 'MEMORY.md'

const BEGIN = '<!-- uppmem:begin -->'
const END = '<!-- uppmem:end -->'

/** Entry kinds from the frozen uppmem schema; anything else degrades to `note`. */
const KINDS = ['fact', 'preference', 'decision', 'convention', 'project', 'task', 'note']
const KIND_ORDER = new Map(KINDS.map((k, i) => [k, i]))
const MAX_ENTRIES = 200
const MAX_TAGS = 8

// `uppmem` CLI path for the instructions we hand to the agent. We are inside
// <repo>/lib/uppmem/hosts, so the repo root is three levels up. Forward slashes
// keep the command valid in cmd.exe, PowerShell and POSIX shells.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const CLI = path.join(REPO_ROOT, 'tools', 'uppmem.mjs').split(path.sep).join('/')

const posixPath = (p) => String(p ?? '').split(path.sep).join('/')
const byteLength = (s) => Buffer.byteLength(String(s), 'utf8')

// ---------------------------------------------------------------- locations

/** Absolute locations for this host, derived from roots only. */
function paths(ctx) {
  const dshHome = ctx?.roots?.dshHome ? path.resolve(String(ctx.roots.dshHome)) : ''
  const skillsDir = dshHome ? path.join(dshHome, 'skills') : ''
  const dir = skillsDir ? path.join(skillsDir, SKILL_DIR_NAME) : ''
  return {
    dshHome,
    skillsDir,
    dir,
    skillFile: dir ? path.join(dir, SKILL_FILE) : '',
    memoryFile: dir ? path.join(dir, MEMORY_FILE) : '',
  }
}

// ------------------------------------------------------------------ content

/** Collapse whitespace and neutralise HTML-comment markers so our own
 *  `<!-- uppmem:end -->` cannot be spoofed by entry text. */
function cleanText(raw) {
  return String(raw ?? '')
    .replace(/<!--/g, '<! --')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalise one pool entry into the snapshot shape (or null if unusable). */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  // Only global entries and entries pinned to this host belong in this snapshot.
  const scope = entry.scope == null ? 'global' : String(entry.scope)
  if (scope !== 'global' && scope !== 'host:dsh') return null
  const text = cleanText(entry.text)
  if (!text) return null
  const kind = KINDS.includes(String(entry.kind)) ? String(entry.kind) : 'note'
  const rawTags = Array.isArray(entry.tags) ? entry.tags : []
  const tags = []
  for (const t of rawTags) {
    const tag = String(t ?? '')
      .replace(/^#+/, '')
      .toLowerCase()
      .trim()
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(tag)) continue
    if (!tags.includes(tag)) tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return { text, kind, tags, updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined }
}

/** Stable preparation used by push: normalise, dedupe, sort by kind then text, cap. */
function prepareEntries(entries) {
  const seen = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const norm = normalizeEntry(entry)
    if (!norm) continue
    // Same text with different kinds/tags: last writer wins (pool merge already
    // collapses by hash; this only guards a duplicated snapshot row).
    seen.set(norm.text, { ...seen.get(norm.text), ...norm, tags: norm.tags.length ? norm.tags : seen.get(norm.text)?.tags ?? [] })
  }
  const all = [...seen.values()].sort((a, b) => {
    const ka = KIND_ORDER.get(a.kind) ?? KINDS.length
    const kb = KIND_ORDER.get(b.kind) ?? KINDS.length
    if (ka !== kb) return ka - kb
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0
  })
  return { all, shown: all.slice(0, MAX_ENTRIES) }
}

/** Render one bullet in the managed grammar. */
function renderBullet(entry) {
  const tags = entry.tags.map((t) => ` #${t}`).join('')
  return `- [${entry.kind}] ${entry.raw ?? entry.text}${tags}`
}

/** Render MEMORY.md. Deterministic: identical entries -> identical bytes (idempotency). */
function renderMemory(entries, ctx) {
  const { all, shown } = prepareEntries(entries)
  const lines = [
    '# UPP 共享记忆快照（自动生成，请勿手工编辑）',
    '',
    '<!-- 由 `uppmem sync --host dsh --push` 生成；完整记忆池在 ~/.uppmem/pool/。 -->',
    `<!-- 条目 ${shown.length}${shown.length !== all.length ? ` / 共 ${all.length}（已截断）` : ''} -->`,
    '<!-- 需要更精确的检索时运行: node ' + CLI + ' search "<关键词>" --limit 10 --json -->',
    '',
  ]
  if (shown.length < all.length) {
    lines.push(`> 快照只展开前 ${MAX_ENTRIES} 条（共 ${all.length} 条），其余请用 \`uppmem search\` 查询。`, '')
  }
  lines.push(BEGIN)
  for (const entry of shown) lines.push(renderBullet(entry))
  lines.push(END, '')
  return lines.join('\n')
}

/** Render SKILL.md — installed once, but rewritten when the instructions change
 *  (e.g. the checkout moved, so the CLI path in the examples differs). */
function renderSkill(ctx) {
  const p = paths(ctx)
  const memory = posixPath(p.memoryFile)
  return [
    '---',
    'name: upp-memory',
    'description: 共享记忆池（uppmem）——跨 DSH / WorkBuddy / Accio 的长期记忆；先读 MEMORY.md 快照，再用 uppmem CLI 检索与写入。',
    '---',
    '',
    '# upp-memory',
    '',
    '本技能给你访问三端共享的长期记忆池。记忆池的权威副本在 `~/.uppmem/pool/`，',
    '本目录的 `MEMORY.md` 只是有界快照（事实/偏好/约定等常见条目）。',
    '',
    '## 使用顺序',
    '',
    `1. 先读快照：\`${memory}\`（条目有限，但覆盖最常见的偏好与约定）。`,
    '2. 快照里没有时，用 shell 工具检索权威池：',
    '',
    '   ```sh',
    `   node "${CLI}" search "<关键词>" --limit 10 --json`,
    '   ```',
    '',
    '3. 用户告诉你一条值得长期记住的信息时，写入共享池：',
    '',
    '   ```sh',
    `   node "${CLI}" add "<一句话事实>" --kind fact --tag <tag> --json`,
    '   ```',
    '',
    '   `--kind` 取值：fact / preference / decision / convention / project / task / note。',
    '   只记结论与偏好，不要记一次性任务细节；`--key` 可用于可覆盖的语义键（如 `user.language`）。',
    '',
    '4. 需要更多上下文时：',
    '',
    '   ```sh',
    `   node "${CLI}" list --kind preference --json`,
    `   node "${CLI}" get <id|key> --json`,
    '   ```',
    '',
    '## 约束',
    '',
    '- 写入前先 `search` 一次，避免重复条目（同 key / 同文本会被合并）。',
    '- 记忆是共享的：不要写入凭据、令牌、密码或个人隐私。',
    '- `MEMORY.md` 由 `uppmem sync` 生成，不要手工编辑；编辑会在下次同步时被覆盖。',
    '',
  ].join('\n')
}

// ------------------------------------------------------------------- parser

/** Parse the managed bullet region out of a MEMORY.md body. */
function parseMemory(raw) {
  const body = String(raw ?? '')
  const start = body.indexOf(BEGIN)
  const end = start < 0 ? -1 : body.indexOf(END, start + BEGIN.length)
  if (start < 0 || end < 0) return { managed: false, entries: [] }
  const entries = []
  for (const line of body.slice(start + BEGIN.length, end).split(/\r?\n/)) {
    const trimmed = line.trim()
    const m = /^[-*]\s+\[([^\]]*)\]\s+(.+)$/.exec(trimmed)
    if (!m) continue
    const rawKind = String(m[1]).trim().toLowerCase()
    const kind = KINDS.includes(rawKind) ? rawKind : 'note'
    let text = String(m[2]).trim()
    const tags = []
    // Tags live at the end of the bullet: peel `#token` groups while present.
    for (;;) {
      const t = /^(.*?)\s+#([a-z0-9][a-z0-9._-]*)$/i.exec(text)
      if (!t) break
      const tag = t[2].toLowerCase()
      text = t[1].trim()
      if (tag && !tags.includes(tag) && tags.length < MAX_TAGS) tags.unshift(tag)
    }
    if (!text) continue
    entries.push({ text, kind, tags })
  }
  return { managed: true, entries }
}

// ---------------------------------------------------------------- fs helpers

/** create / update / noop for a file whose desired content is `text`. */
function fileAction(file, text) {
  if (!file) return 'skip'
  if (!exists(file)) return 'create'
  return readText(file, '') === text ? 'noop' : 'update'
}

/** A minimal tx-compatible writer for direct module use (tests, one-off scripts).
 *  The uppmem core always passes a real Tx; this only keeps `push` usable alone. */
function fallbackTx(dryRun) {
  return {
    dryRun,
    writeText(file, text) {
      if (dryRun) return false
      writeFileAtomic(file, Buffer.from(String(text), 'utf8'))
      return true
    },
    writeFile(file, data) {
      if (dryRun) return false
      writeFileAtomic(file, data)
      return true
    },
    backup() {
      return null
    },
    log(action) {
      return action
    },
  }
}

/** Resolve the writer + effective dryRun for one call. */
function writer(ctx, tx, dryRunArg) {
  const dryRun = Boolean(dryRunArg ?? ctx?.options?.dryRun ?? tx?.dryRun ?? false)
  const sink = tx ?? fallbackTx(dryRun)
  return { sink, dryRun }
}

/** Write one generated file under tx, reporting the action. Never writes in dryRun. */
function commitFile({ sink, dryRun }, file, text, entryCount) {
  const action = fileAction(file, text)
  const report = { path: file, action, entries: entryCount, bytes: byteLength(text) }
  if (action === 'skip') return { ...report, skipped: 'no path resolved (missing host root)' }
  if (action === 'noop') return report
  if (dryRun) return { ...report, skipped: 'dry-run' }
  try {
    const before = exists(file)
    if (before) sink.backup?.(file)
    sink.writeText(file, text)
    // Record the action on the transaction report (core Tx.log is a plain list).
    sink.log?.({ op: action, host: name, path: posixPath(file) })
  } catch (err) {
    return { ...report, action: 'skip', skipped: `write failed: ${err?.message ?? err}` }
  }
  return report
}

// ------------------------------------------------------------------- adapter

/** Read-only capability report. Never throws on a missing DSH home. */
export function detect(ctx) {
  const p = paths(ctx)
  const available = Boolean(p.dshHome && isDir(p.dshHome))
  const info = {
    host: name,
    available,
    paths: {
      dshHome: p.dshHome || '(unresolved)',
      skillsDir: p.skillsDir || '(unresolved)',
      memoryFile: p.memoryFile || '(unresolved)',
      skillFile: p.skillFile || '(unresolved)',
      installed: exists(p.memoryFile),
    },
  }
  if (!available) info.reason = `no DSH home at ${p.dshHome || '(unresolved)'} — set DSH_HOME or run DSH once`
  return info
}

/** Read back the snapshot this adapter pushed. Read-only; missing file -> empty. */
export function pull(ctx) {
  const p = paths(ctx)
  const available = Boolean(p.dshHome && isDir(p.dshHome))
  const warnings = []
  const file = { path: p.memoryFile, format: memoryFileFormat, exists: false, entries: [] }
  if (!p.memoryFile) {
    warnings.push('DSH home unresolved; cannot read the memory snapshot')
    return { host: name, available, files: [file], warnings }
  }
  let raw = null
  try {
    raw = fs.readFileSync(p.memoryFile, 'utf8')
  } catch {
    raw = null
  }
  if (raw == null) {
    if (available) warnings.push(`no memory snapshot yet at ${p.memoryFile} (run: uppmem sync --host dsh --push)`)
    return { host: name, available, files: [file], warnings }
  }
  file.exists = true
  file.size = byteLength(raw)
  file.sha256 = sha256(Buffer.from(raw, 'utf8'))
  const parsed = parseMemory(raw)
  file.entries = parsed.entries
  if (!parsed.managed) {
    warnings.push(`${p.memoryFile} has no uppmem managed region; ignored (unmanaged content is preserved by hand only)`)
    file.raw = raw
  }
  return { host: name, available, files: [file], warnings }
}

/** Install/refresh SKILL.md and regenerate MEMORY.md from the pool entries. */
export async function push(ctx, { entries = [], dryRun = undefined, tx = undefined } = {}) {
  const p = paths(ctx)
  const { sink, dryRun: effectiveDryRun } = writer(ctx, tx, dryRun)
  const warnings = []
  const files = []
  if (!p.dir) {
    return { host: name, files: [{ path: '(unresolved)', action: 'skip', entries: 0, skipped: 'no DSH home' }], warnings: ['no DSH home; cannot install the upp-memory skill'] }
  }

  const skillText = renderSkill(ctx)
  files.push(commitFile({ sink, dryRun: effectiveDryRun }, p.skillFile, skillText, 0))

  const memoryText = renderMemory(entries, ctx)
  const { all, shown } = prepareEntries(entries)
  if (shown.length < all.length) warnings.push(`MEMORY.md holds the first ${shown.length} of ${all.length} entries; the rest stay in the pool`)
  if (exists(p.memoryFile) && !readText(p.memoryFile, '').includes(BEGIN)) {
    warnings.push(`${p.memoryFile} existed without uppmem markers; it was regenerated (tx keeps a backup when not in dry-run)`)
  }
  files.push(commitFile({ sink, dryRun: effectiveDryRun }, p.memoryFile, memoryText, shown.length))

  if (effectiveDryRun) warnings.push('dry-run: no files were written')
  return { host: name, files, warnings }
}

/** Same as push but only the skill instructions (used by `uppmem hosts`). */
export async function install(ctx, { dryRun = undefined, tx = undefined } = {}) {
  const p = paths(ctx)
  const { sink, dryRun: effectiveDryRun } = writer(ctx, tx, dryRun)
  if (!p.skillFile) return { host: name, files: [{ path: '(unresolved)', action: 'skip', entries: 0, skipped: 'no DSH home' }], warnings: ['no DSH home; cannot install the upp-memory skill'] }
  const report = commitFile({ sink, dryRun: effectiveDryRun }, p.skillFile, renderSkill(ctx), 0)
  const warnings = effectiveDryRun ? ['dry-run: no files were written'] : []
  return { host: name, files: [report], warnings }
}

export default { name, memoryFileFormat, detect, pull, push, install }
