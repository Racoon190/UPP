/**
 * apply.mjs — shared, transactional materialization helpers for host adapters.
 *
 * Adapters own *host knowledge* (where things live, what shape the config has);
 * this module owns *mechanics* (merge a JSON fragment, replace a tree, decide
 * create/update/noop). Every helper takes the Tx so rollback stays complete.
 */
import fs from 'node:fs'
import path from 'node:path'
import { posix, readJson, readText, shouldIgnore, treeDigest, walk } from './util.mjs'

/**
 * Deep merge with explicit array semantics.
 * - objects merge recursively
 * - arrays are replaced (host configs treat arrays as ordered settings)
 * - `undefined` in patch means "leave alone", `null` means "set null"
 */
export function deepMerge(base, patch) {
  if (patch === undefined) return base
  if (patch === null) return null
  if (Array.isArray(patch) || typeof patch !== 'object') return patch
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = v === null ? null : deepMerge(out[k], v)
  }
  return out
}

/** Decide what an import of `expectedDigest` onto `dest` means. */
export function fileAction(dest, expectedDigest) {
  if (!fs.existsSync(dest)) return 'create'
  const current = treeDigest(path.dirname(dest), { ignore: false })
  const entry = current.files.find((f) => f.rel === posix(path.basename(dest)))
  if (!entry) return 'update'
  return entry.sha256 === expectedDigest ? 'noop' : 'update'
}

export function textAction(dest, text) {
  if (!fs.existsSync(dest)) return 'create'
  return readText(dest) === text ? 'noop' : 'update'
}

/** JSON config action: noop when the merge changes nothing. */
export function jsonAction(dest, fragment) {
  if (!fs.existsSync(dest)) return 'create'
  const before = readJson(dest)
  const after = deepMerge(before, fragment)
  return JSON.stringify(before) === JSON.stringify(after) ? 'noop' : 'update'
}

export function treeAction(destDir, assetDir, { ignore = true } = {}) {
  if (!fs.existsSync(destDir)) return 'create'
  const a = treeDigest(destDir, { ignore })
  const b = treeDigest(assetDir, { ignore })
  return a.digest === b.digest ? 'noop' : 'update'
}

/**
 * Merge a JSON fragment into a host config file (creating it when missing).
 * Returns the action taken: create | update | noop | skip.
 */
export function applyMergeJson(tx, file, fragment, { onConflict = 'overwrite', dryRun = false } = {}) {
  const action = jsonAction(file, fragment)
  if (action === 'noop') return { action, file }
  if (action === 'update' && onConflict === 'skip') return { action: 'skip', file }
  const base = readJson(file, {})
  const merged = deepMerge(base, fragment)
  if (!dryRun) tx.writeText(file, `${JSON.stringify(merged, null, 2)}\n`)
  return { action, file, merged }
}

export function applyWriteText(tx, file, text, { onConflict = 'overwrite', dryRun = false } = {}) {
  const action = textAction(file, text)
  if (action === 'noop') return { action, file }
  if (action === 'update' && onConflict === 'skip') return { action: 'skip', file }
  if (!dryRun) tx.writeText(file, text)
  return { action, file }
}

/** Append a marked block to a text config, idempotently. */
export function applyAppendText(tx, file, text, { marker = 'uppenv', dryRun = false } = {}) {
  const current = readText(file, '')
  const begin = `<!-- ${marker}:begin -->`
  const end = `<!-- ${marker}:end -->`
  const block = `${begin}\n${text.trim()}\n${end}\n`
  if (current.includes(block)) return { action: 'noop', file }
  let next
  if (current.includes(begin) && current.includes(end)) {
    const start = current.indexOf(begin)
    const stop = current.indexOf(end) + end.length
    next = `${current.slice(0, start)}${block.trimEnd()}${current.slice(stop)}`
  } else {
    next = current.endsWith('\n') || current === '' ? `${current}${block}` : `${current}\n${block}`
  }
  if (!dryRun) tx.writeText(file, next)
  return { action: current.includes(begin) ? 'update' : 'create', file }
}

/** Replace a directory with the payload tree of an asset. */
export function applyCopyTree(tx, destDir, assetDir, { onConflict = 'overwrite', dryRun = false } = {}) {
  const action = treeAction(destDir, assetDir)
  if (action === 'noop') return { action, destDir }
  if (action === 'update' && onConflict === 'skip') return { action: 'skip', destDir }
  if (!dryRun) tx.replaceTree(destDir, assetDir)
  return { action, destDir }
}

/** Copy just the payload files of an asset into an existing directory (merge). */
export function applyMergeTree(tx, destDir, assetDir, { dryRun = false } = {}) {
  let changed = 0
  for (const abs of walk(assetDir)) {
    const rel = posix(path.relative(assetDir, abs))
    if (shouldIgnore(rel)) continue
    const dest = path.join(destDir, ...rel.split('/'))
    const body = fs.readFileSync(abs)
    let same = false
    try {
      same = fs.readFileSync(dest).equals(body)
    } catch {
      same = false
    }
    if (same) continue
    if (!dryRun) tx.writeFile(dest, body)
    changed += 1
  }
  return { action: changed === 0 ? 'noop' : fs.existsSync(destDir) ? 'update' : 'create', destDir, files: changed }
}

/** Copy a single payload file to an exact destination path. */
export function applyFile(tx, dest, srcFile, { onConflict = 'overwrite', dryRun = false } = {}) {
  const body = fs.readFileSync(srcFile)
  const digest = treeDigest(path.dirname(srcFile)).files.find((f) => f.rel === posix(path.basename(srcFile)))?.sha256
  const action = fileAction(dest, digest)
  if (action === 'noop') return { action, dest }
  if (action === 'update' && onConflict === 'skip') return { action: 'skip', dest }
  if (!dryRun) tx.writeFile(dest, body)
  return { action, dest }
}

/** Resolve a payload-relative path inside a materialized asset. */
export function assetFile(asset, rel) {
  const p = path.join(asset.dir, ...posix(rel).split('/'))
  if (!fs.existsSync(p)) throw new Error(`uppenv: asset ${asset.id} missing payload file ${rel}`)
  return p
}
