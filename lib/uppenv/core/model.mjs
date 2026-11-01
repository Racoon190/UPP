/**
 * uppenv asset model — the single data contract shared by the core engine and
 * every host adapter.
 *
 * Lifecycle of an asset:
 *
 *   scan()    adapter describes it:      { kind, host, id, strategy, meta, files: [{rel, src}] }
 *   export    core hashes + copies files into payload/<kind>/<host>/<slug>/
 *   image     on disk: asset.json (this object minus `files`) + the files themselves
 *   import    core materializes it as:   { ...asset, dir: '<abs payload dir>', files: FileEntry[] }
 *
 * `apply()` only ever receives the materialized form, so adapters never need to
 * know where the image came from.
 */
import path from 'node:path'
import { sha256, posix, slug, uniqueBy } from './util.mjs'

export const SCHEMA = 'uppenv/1'
export const KINDS = Object.freeze(['plugin', 'skill', 'mcp', 'tool', 'memory'])
export const HOSTS = Object.freeze(['dsh', 'workbuddy', 'accio'])
export const STRATEGIES = Object.freeze([
  'copy-tree', // a directory is written verbatim to a target root
  'write-file', // a single file/asset is written (fragment lives in meta.fragment)
  'merge-json', // meta.fragment is deep-merged into a host JSON config file
  'append-text', // meta.text is appended to a host text config (idempotent marker)
  'exec', // adapter runs a host CLI to materialize (e.g. `upp install`, gateway add)
])

export const KIND_LABEL = Object.freeze({
  plugin: '插件',
  skill: '技能',
  mcp: 'MCP 服务',
  tool: '工具清单',
  memory: '记忆',
})

const ID_RE = /^[a-zA-Z0-9@._:/-]+$/

export function assertValid(cond, message) {
  if (!cond) throw new Error(`uppenv.model: ${message}`)
}

/** Stable directory name for an asset inside the image payload. */
export function assetSlug(asset) {
  return `${asset.kind}__${asset.host}__${slug(asset.id)}`
}

/** Validate and normalize one asset produced by a `scan()` implementation. */
export function normalizeScanAsset(asset) {
  assertValid(asset && typeof asset === 'object', 'asset must be an object')
  assertValid(KINDS.includes(asset.kind), `invalid kind: ${asset.kind}`)
  assertValid(HOSTS.includes(asset.host), `invalid host: ${asset.host}`)
  assertValid(typeof asset.id === 'string' && asset.id.length > 0, 'asset.id is required')
  assertValid(ID_RE.test(asset.id), `asset.id has illegal characters: ${asset.id}`)
  assertValid(STRATEGIES.includes(asset.strategy), `invalid strategy: ${asset.strategy}`)

  const files = (asset.files ?? []).map((f) => {
    assertValid(f && typeof f.rel === 'string', `${asset.id}: file.rel is required`)
    const rel = posix(f.rel)
    assertValid(!rel.startsWith('/') && !rel.includes('..'), `${asset.id}: illegal rel path ${f.rel}`)
    assertValid(typeof f.src === 'string', `${asset.id}: file.src is required for ${f.rel}`)
    return { rel, src: f.src }
  })

  const meta = asset.meta && typeof asset.meta === 'object' ? JSON.parse(JSON.stringify(asset.meta)) : {}

  return {
    kind: asset.kind,
    host: asset.host,
    id: asset.id,
    label: asset.label ? String(asset.label) : undefined,
    version: asset.version ? String(asset.version) : undefined,
    builtin: Boolean(asset.builtin),
    strategy: asset.strategy,
    requires: Array.isArray(asset.requires) ? asset.requires.map(String) : [],
    meta,
    files,
    secrets: asset.secrets && typeof asset.secrets === 'object' ? asset.secrets : undefined,
    placeholders: asset.placeholders && typeof asset.placeholders === 'object' ? asset.placeholders : undefined,
  }
}

/** Hash of the file list, used for the asset-level digest in manifest.json. */
export function digestFileList(files) {
  const norm = uniqueBy(
    [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1)),
    (f) => f.rel,
  )
  return sha256(norm.map((f) => `${f.rel}\0${f.sha256}`).join('\n'))
}

/** Serialize a scanned asset into the on-disk `asset.json` (files stripped). */
export function toAssetJson(asset, files) {
  return {
    kind: asset.kind,
    host: asset.host,
    id: asset.id,
    label: asset.label,
    version: asset.version,
    builtin: asset.builtin,
    strategy: asset.strategy,
    requires: asset.requires,
    meta: asset.meta,
    secrets: asset.secrets,
    placeholders: asset.placeholders,
    files: files.map((f) => ({ rel: f.rel, sha256: f.sha256, size: f.size })),
    digest: digestFileList(files),
  }
}

/** Build one file entry from disk without reading twice. */
export function fileEntryFrom(absSrc, rel, readFile) {
  const body = readFile(absSrc)
  return { rel: posix(rel), src: absSrc, sha256: sha256(body), size: body.length }
}

export function describeAsset(asset) {
  const n = asset.files?.length ?? 0
  return `${asset.kind}/${asset.host}/${asset.id} (${n} files${asset.version ? `, v${asset.version}` : ''})`
}

export function assetKey(asset) {
  return `${asset.kind}:${asset.host}:${asset.id}`
}

export function assertImageAsset(asset) {
  assertValid(asset.kind && KINDS.includes(asset.kind), `bad kind in image: ${asset.kind}`)
  assertValid(asset.host && HOSTS.includes(asset.host), `bad host in image: ${asset.host}`)
  assertValid(typeof asset.id === 'string' && asset.id, 'image asset missing id')
  assertValid(asset.strategy && STRATEGIES.includes(asset.strategy), `bad strategy: ${asset.strategy}`)
  assertValid(path.isAbsolute(asset.dir ?? ''), 'image asset missing extracted dir')
  assertValid(Array.isArray(asset.files), 'image asset missing files')
}

export const ACTIONS = Object.freeze([
  'create',
  'update',
  'noop',
  'skip',
  'missing-host',
  'missing-prereq',
  'error',
])
