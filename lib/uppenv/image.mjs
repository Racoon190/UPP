/**
 * image.mjs — the "docker build / docker save" half of uppenv.
 *
 *   buildImage()  scan adapters -> hash every payload file -> write image dir
 *   packImage()   image dir -> single .uppenv file (ZIP)
 *   inspectImage() manifest summary without extracting payload
 *   verifyImage() hash + schema + path safety check
 *   materialize() extract -> assets ready for adapter.apply()
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  SCHEMA,
  KINDS,
  HOSTS,
  normalizeScanAsset,
  toAssetJson,
  assertImageAsset,
  assetSlug,
  digestFileList,
} from './core/model.mjs'
import { packImage as zipDir, readZip, unpackImage } from './core/archive.mjs'
import { probeServer, compareToolSurface } from './core/mcp-tools.mjs'
import { assetFile } from './core/apply.mjs'
import {
  bytes,
  posix,
  readJson,
  rmrf,
  sha256,
  shouldIgnore,
  slug,
  walk,
  writeJson,
} from './core/util.mjs'
import { loadAdapter, createContext } from './hosts/index.mjs'

export const TOOL = { name: 'uppenv', version: '1.0.0' }

function nowIso() {
  return new Date().toISOString()
}

function cleanOptions(options = {}) {
  const kinds = options.kinds && options.kinds.length ? options.kinds : [...KINDS]
  const hosts = options.hosts && options.hosts.length ? options.hosts : [...HOSTS]
  for (const k of kinds) if (!KINDS.includes(k)) throw new Error(`unknown kind: ${k}`)
  for (const h of hosts) if (!HOSTS.includes(h)) throw new Error(`unknown host: ${h}`)
  return { ...options, kinds, hosts }
}

/**
 * Build an image directory from the live hosts.
 * @returns {{ dir: string, manifest: object, skipped: object[] }}
 */
export async function buildImage(outDir, options = {}) {
  const opts = cleanOptions(options)
  const log = opts.log ?? (() => {})
  const baseCtx = opts.ctx ?? createContext({ options: opts, roots: opts.roots, log })
  const dir = path.resolve(outDir)
  const payloadRoot = path.join(dir, 'payload')
  rmrf(dir)
  fs.mkdirSync(payloadRoot, { recursive: true })

  const assets = []
  const skipped = []
  const hostsInfo = {}

  for (const host of opts.hosts) {
    let adapter
    const hostCtx = createContext({ ...baseCtx, host, options: opts, log })
    try {
      adapter = await loadAdapter(host, hostCtx)
    } catch (err) {
      skipped.push({ host, reason: err.message })
      log(`skip host ${host}: ${err.message}`)
      continue
    }
    let info = {}
    try {
      info = await adapter.detect(hostCtx)
    } catch (err) {
      skipped.push({ host, reason: `detect failed: ${err.message}` })
      continue
    }
    hostsInfo[host] = info
    if (info && info.available === false) {
      skipped.push({ host, reason: info.reason ?? 'host not detected' })
      continue
    }

    // A `tool` asset is a live snapshot of an MCP server's tool surface, so an
    // export that wants tools must also look at the host's MCP servers.
    const scanKinds = opts.kinds.includes('tool') ? [...new Set([...opts.kinds, 'mcp'])] : opts.kinds
    let scanned = []
    try {
      scanned =
        (await adapter.scan(hostCtx, {
          kinds: scanKinds,
          ids: opts.ids,
          includeBuiltin: Boolean(opts.includeBuiltin),
        })) ?? []
    } catch (err) {
      skipped.push({ host, reason: `scan failed: ${err.message}` })
      log(`scan ${host} failed: ${err.message}`)
      continue
    }

    const candidates = []
    for (const raw of scanned) {
      const asset = normalizeScanAsset({ ...raw, host })
      if (asset.kind !== 'mcp' && !opts.kinds.includes(asset.kind)) continue
      if (opts.ids && opts.ids.length && !opts.ids.includes(asset.id)) continue
      if (asset.builtin && !opts.includeBuiltin) {
        skipped.push({ host, kind: asset.kind, id: asset.id, reason: 'builtin (use --include-builtin)' })
        continue
      }
      candidates.push(asset)
    }

    let probeTmp = null
    try {
      if (opts.kinds.includes('tool') && opts.probeTools !== false) {
        probeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uppenv-probe-'))
        for (const mcpAsset of candidates.filter((a) => a.kind === 'mcp')) {
          if (opts.ids && opts.ids.length && !opts.ids.includes(mcpAsset.id)) continue
          const { asset: toolAsset, snapshot } = await synthesizeToolAsset(mcpAsset, hostCtx, probeTmp, {
            timeoutMs: opts.probeTimeout ?? 8000,
          })
          candidates.push(toolAsset)
          if (snapshot.ok) {
            log(`  ~ tools/${host}/${mcpAsset.id}: ${snapshot.tools.length} tool(s) from ${snapshot.server?.name ?? 'server'}`)
          } else {
            log(`  ~ tools/${host}/${mcpAsset.id}: no live surface (${snapshot.error})`)
          }
        }
      }

      for (const asset of candidates) {
        if (!opts.kinds.includes(asset.kind)) continue
        try {
          const written = writeAsset(payloadRoot, asset, { log })
          assets.push(written.index)
          log(`  + ${asset.kind}/${asset.host}/${asset.id} (${written.files.length} files, ${bytes(written.bytes)})`)
        } catch (err) {
          skipped.push({ host, kind: asset.kind, id: asset.id, reason: err.message })
          log(`  ! ${asset.kind}/${host}/${asset.id}: ${err.message}`)
        }
      }
    } finally {
      if (probeTmp) rmrf(probeTmp)
    }
  }

  const manifest = {
    schema: SCHEMA,
    kind: 'uppenv-image',
    createdAt: nowIso(),
    tool: TOOL,
    source: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: os.hostname(),
      home: baseCtx.tpl.pathToTemplate(baseCtx.roots.home) ?? '(unmapped)',
    },
    filters: {
      hosts: opts.hosts,
      kinds: opts.kinds,
      ids: opts.ids ?? null,
      includeBuiltin: Boolean(opts.includeBuiltin),
      vendor: opts.vendor ?? 'auto',
      probeTools: opts.probeTools !== false,
    },
    hosts: hostsInfo,
    assets,
    stats: summarize(assets),
    skipped,
  }
  writeJson(path.join(dir, 'manifest.json'), manifest)
  fs.writeFileSync(
    path.join(dir, 'README.txt'),
    imageReadme(manifest),
  )
  return { dir, manifest, skipped }
}

/** Copy one scanned asset into payload/ and return its manifest index entry. */
function writeAsset(payloadRoot, asset, { log } = {}) {
  const key = assetSlug(asset)
  const assetDir = path.join(payloadRoot, key)
  const filesDir = path.join(assetDir, 'files')
  fs.mkdirSync(filesDir, { recursive: true })

  const files = []
  let total = 0
  const seen = new Set()
  for (const f of asset.files) {
    if (seen.has(f.rel)) throw new Error(`duplicate payload path: ${f.rel}`)
    seen.add(f.rel)
    if (shouldIgnore(f.rel)) throw new Error(`refusing to export ignored path: ${f.rel}`)
    const src = f.src
    let st
    try {
      st = fs.lstatSync(src)
    } catch {
      throw new Error(`missing source file: ${src}`)
    }
    if (st.isDirectory()) throw new Error(`file.src is a directory: ${src}`)
    const body = fs.readFileSync(src)
    const dest = path.join(filesDir, ...posix(f.rel).split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, body)
    files.push({ rel: posix(f.rel), sha256: sha256(body), size: body.length })
    total += body.length
  }

  const assetJson = toAssetJson(asset, files)
  writeJson(path.join(assetDir, 'asset.json'), assetJson)

  return {
    files,
    bytes: total,
    index: {
      key,
      kind: asset.kind,
      host: asset.host,
      id: asset.id,
      label: asset.label,
      version: asset.version,
      builtin: asset.builtin,
      strategy: asset.strategy,
      requires: asset.requires,
      digest: assetJson.digest,
      files: files.length,
      bytes: total,
      managedBy: asset.meta?.managedBy,
      source: asset.meta?.source,
      payload: `payload/${key}`,
    },
  }
}

function summarize(assets) {
  const byKind = {}
  const byHost = {}
  let totalBytes = 0
  for (const a of assets) {
    byKind[a.kind] = (byKind[a.kind] ?? 0) + 1
    byHost[a.host] = (byHost[a.host] ?? 0) + 1
    totalBytes += a.bytes
  }
  return { assets: assets.length, byKind, byHost, bytes: totalBytes, human: bytes(totalBytes) }
}

function imageReadme(manifest) {
  const lines = [
    'uppenv image (Universal Plugin Package - environment)',
    '',
    `schema:  ${manifest.schema}`,
    `created: ${manifest.createdAt}`,
    `tool:    ${manifest.tool.name} ${manifest.tool.version}`,
    '',
    'This file is a plain ZIP archive. It contains:',
    '  manifest.json                 index of every exported asset',
    '  payload/<kind>__<host>__<id>/ files + asset.json per asset',
    '  hosts/<host>.json             host detection snapshot',
    '',
    'Install it with:  uppenv import <this-file> --dry-run',
    'Inspect it with:  uppenv inspect <this-file>',
    '',
    ...Object.entries(manifest.stats.byKind).map(([k, v]) => `  ${k.padEnd(8)} ${v} asset(s)`),
    '',
  ]
  return `${lines.join('\n')}`
}

/** Zip a built image directory into one portable .uppenv file. */
export function saveImage(imageDir, outFile, { allowOverwrite = false } = {}) {
  const manifestFile = path.join(imageDir, 'manifest.json')
  if (!fs.existsSync(manifestFile)) throw new Error(`not an image dir (no manifest.json): ${imageDir}`)
  const target = path.resolve(outFile)
  if (fs.existsSync(target) && !allowOverwrite) throw new Error(`output exists (use --force): ${target}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const res = zipDir(imageDir, target)
  return { ...res, manifest: readJson(manifestFile) }
}

/** Accept either a packed .uppenv file or a built image directory. */
function imageFilePath(fileOrDir) {
  const abs = path.resolve(fileOrDir)
  let st = null
  try {
    st = fs.statSync(abs)
  } catch {
    st = null
  }
  if (!st) throw new Error(`no such image: ${abs}`)
  if (!st.isDirectory()) return { file: abs, cleanup: () => {} }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uppenv-pack-'))
  const out = path.join(tmp, 'image.uppenv')
  saveImage(abs, out, { allowOverwrite: true })
  return { file: out, cleanup: () => rmrf(tmp) }
}

/** Read only manifest.json out of a .uppenv file (or a built image dir). */
export function readImageManifest(file) {
  const { file: abs, cleanup } = imageFilePath(file)
  try {
    const entries = readZip(abs)
    const m = entries.find((e) => e.name === 'manifest.json')
    if (!m) throw new Error(`not a uppenv image (missing manifest.json): ${file}`)
    const manifest = JSON.parse(m.data.toString('utf8'))
    if (manifest.schema !== SCHEMA) throw new Error(`unsupported image schema ${manifest.schema} (expected ${SCHEMA})`)
    return manifest
  } finally {
    cleanup()
  }
}

export function inspectImage(file) {
  const { file: abs, cleanup } = imageFilePath(file)
  try {
    const manifest = readImageManifest(abs)
    return { file: path.resolve(file), size: fs.statSync(abs).size, manifest, stats: manifest.stats }
  } finally {
    cleanup()
  }
}

/** Verify every payload file against the manifest hashes. */
export function verifyImage(file) {
  const { file: abs, cleanup } = imageFilePath(file)
  try {
    return verifyPacked(abs, file)
  } finally {
    cleanup()
  }
}

function verifyPacked(abs, original) {
  const entries = readZip(abs)
  const nameOf = new Map(entries.map((e) => [e.name, e]))
  const problems = []
  const checked = []
  let manifest
  try {
    manifest = readImageManifest(abs)
  } catch (err) {
    return { ok: false, problems: [err.message], checked: 0, manifest: null }
  }
  let totalBytes = 0
  for (const asset of manifest.assets) {
    const assetPath = `${asset.payload}/asset.json`
    const assetEntry = nameOf.get(assetPath)
    if (!assetEntry) {
      problems.push(`missing ${assetPath}`)
      continue
    }
    let assetJson
    try {
      assetJson = JSON.parse(assetEntry.data.toString('utf8'))
    } catch (err) {
      problems.push(`corrupt ${assetPath}: ${err.message}`)
      continue
    }
    if (assetJson.kind !== asset.kind || assetJson.host !== asset.host || assetJson.id !== asset.id) {
      problems.push(`asset.json identity mismatch for ${asset.key}`)
    }
    const listed = []
    for (const f of assetJson.files) {
      const rel = posix(f.rel)
      const entry = nameOf.get(`${asset.payload}/files/${rel}`)
      if (!entry) {
        problems.push(`missing payload file ${asset.payload}/files/${rel}`)
        continue
      }
      const digest = sha256(entry.data)
      if (digest !== f.sha256) problems.push(`hash mismatch ${asset.payload}/files/${rel}`)
      totalBytes += entry.data.length
      listed.push({ rel, sha256: digest, size: entry.data.length })
    }
    if (digestFileList(listed) !== assetJson.digest) {
      problems.push(`digest mismatch for ${asset.key}`)
    }
    checked.push({ key: asset.key, files: listed.length })
  }
  if (manifest.stats.bytes !== totalBytes) {
    problems.push(`byte total mismatch: manifest ${manifest.stats.bytes} vs payload ${totalBytes}`)
  }
  return { ok: problems.length === 0, problems, checked: checked.length, assets: checked, manifest }
}

/**
 * Extract an image and return materialized assets:
 *   { ...assetJson, dir: '<abs payload files dir>', files: [{rel, sha256, size, path}] }
 */
export function materialize(file, { workDir = undefined } = {}) {
  const { file: abs, cleanup: cleanupPacked } = imageFilePath(file)
  const target = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'uppenv-'))
  const { destDir } = unpackImage(abs, target)
  cleanupPacked()
  const manifest = readJson(path.join(destDir, 'manifest.json'))
  if (!manifest || manifest.schema !== SCHEMA) throw new Error(`not a uppenv image: ${file}`)
  const assets = []
  for (const index of manifest.assets) {
    const assetDir = path.join(destDir, ...index.payload.split('/'))
    const assetJson = readJson(path.join(assetDir, 'asset.json'))
    if (!assetJson) continue
    const filesDir = path.join(assetDir, 'files')
    const asset = {
      ...assetJson,
      key: index.key,
      dir: filesDir,
      manifestEntry: index,
      files: assetJson.files.map((f) => ({
        rel: posix(f.rel),
        sha256: f.sha256,
        size: f.size,
        path: path.join(filesDir, ...posix(f.rel).split('/')),
      })),
    }
    assertImageAsset(asset)
    assets.push(asset)
  }
  return { dir: destDir, manifest, assets, cleanup: () => rmrf(destDir) }
}

/** Names of files inside the image for a given asset (used by apply copy-tree). */
export function assetPayloadDir(imageDir, payloadRel) {
  return path.join(imageDir, ...String(payloadRel).split('/'))
}

// --------------------------------------------------------- tool surface assets
//
// `tool` assets are synthesized from the MCP servers a host already has: the
// snapshot is the server's real tools/list surface at export time. They are
// informational for the host (nothing to install — hosts discover tools at
// runtime) but they make "tools" a first-class, verifiable part of an image.

function mcpProbeConfig(mcpAsset) {
  const entry = mcpAsset.meta?.entry ?? {}
  const command = Array.isArray(entry.command) ? entry.command[0] : entry.command
  const args = Array.isArray(entry.args) ? [...entry.args] : []
  const env = entry.env ?? entry.environment ?? {}
  return { command, args, env }
}

async function synthesizeToolAsset(mcpAsset, ctx, tmpDir, { timeoutMs = 8000 } = {}) {
  const raw = mcpProbeConfig(mcpAsset)
  const expanded = ctx.tpl.expandValue(raw)
  const templated = ctx.tpl.templateValue(raw)
  let snapshot
  if (!raw.command || typeof raw.command !== 'string') {
    snapshot = {
      ok: false,
      server: null,
      tools: [],
      error: `no stdio command (transport: ${mcpAsset.meta?.transport ?? 'unknown'})`,
    }
  } else {
    const probe = await probeServer(
      { command: expanded.command, args: expanded.args, env: expanded.env, cwd: ctx.roots.home },
      { timeoutMs },
    )
    snapshot = {
      ok: probe.ok,
      server: probe.server ?? null,
      tools: (probe.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ? summarizeSchema(t.inputSchema) : undefined,
      })),
      error: probe.error ?? null,
    }
  }

  const payload = {
    schema: 'uppenv/tools/1',
    server: snapshot.server,
    ok: snapshot.ok,
    error: snapshot.error,
    probedAt: nowIso(),
    probe: templated,
    tools: snapshot.tools,
  }
  const src = path.join(tmpDir, `${slug(mcpAsset.id)}.json`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(src, `${JSON.stringify(payload, null, 2)}\n`)

  const asset = normalizeScanAsset({
    kind: 'tool',
    host: mcpAsset.host,
    id: mcpAsset.id,
    label: `${mcpAsset.id} tool surface`,
    version: snapshot.server?.version,
    strategy: 'write-file',
    requires: [],
    meta: {
      serverName: mcpAsset.id,
      source: 'mcp-snapshot',
      transport: mcpAsset.meta?.transport ?? 'stdio',
      ok: snapshot.ok,
      toolCount: snapshot.tools.length,
      error: snapshot.error,
      probe: templated,
      tools: snapshot.tools,
      managedBy: mcpAsset.meta?.managedBy,
    },
    files: [{ rel: 'tools.json', src }],
  })
  return { asset, snapshot }
}

/** Keep inputSchema small enough for a JSON inventory but still useful. */
function summarizeSchema(schema) {
  const props = schema?.properties
  if (!props || typeof props !== 'object') return { type: schema?.type ?? 'object' }
  const out = { type: schema?.type ?? 'object', properties: {} }
  for (const [k, v] of Object.entries(props)) {
    out.properties[k] = { type: v?.type ?? 'unknown', description: v?.description ?? '' }
  }
  if (Array.isArray(schema.required)) out.required = [...schema.required]
  return out
}

/** Destination file for a materialized tool snapshot. */
export function toolSnapshotTarget(snapshotRoot, asset) {
  return path.join(snapshotRoot, `${slug(asset.id)}.json`)
}

/**
 * Materialize a tool snapshot into uppenv's own store (never into the host):
 * hosts discover MCP tools at runtime, so the honest import action is to record
 * the expected surface for later drift checks.
 */
export function applyToolSnapshot(asset, { snapshotRoot, tx, dryRun = false }) {
  const src = assetFile(asset, 'tools.json')
  const body = fs.readFileSync(src)
  const dest = toolSnapshotTarget(snapshotRoot, asset)
  const action = !fs.existsSync(dest)
    ? 'create'
    : fs.readFileSync(dest).equals(body)
      ? 'noop'
      : 'update'
  if (action !== 'noop' && !dryRun) tx.writeFile(dest, body)
  return { asset, action, targets: [{ path: dest, action }] }
}

/** Read the tool snapshots recorded by previous imports. */
export function listToolSnapshots(snapshotRoot) {
  if (!fs.existsSync(snapshotRoot)) return []
  const out = []
  for (const abs of walk(snapshotRoot)) {
    if (!abs.endsWith('.json')) continue
    const data = readJson(abs)
    if (!data) continue
    out.push({ file: abs, ...data })
  }
  return out
}

export { compareToolSurface }

