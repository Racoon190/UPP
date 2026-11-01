/**
 * Adapter registry.
 *
 * Adapters are plain ESM files in this directory. They are imported lazily so a
 * partially-written checkout still works for `uppenv detect` on other hosts,
 * and so a missing adapter is a clear, friendly error rather than a crash at
 * module load.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOSTS } from '../core/model.mjs'
import { createTemplates, detectRoots } from '../core/util.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export { HOSTS }

/** Build the read-only ctx handed to adapters (also used by the CLI). */
export function createContext({ host, roots = detectRoots(), options = {}, env = process.env, log } = {}) {
  const r = { ...detectRoots(env), ...roots }
  const tpl = createTemplates({
    HOME: r.home,
    DSH_HOME: r.dshHome,
    UPP_STORE: r.uppStore,
    WORKBUDDY_HOME: r.workbuddyHome,
    CODEBUDDY_HOME: r.codebuddyHome,
    ACCIO_HOME: r.accioHome,
    WORKSPACE: r.workspace,
  })
  return {
    host,
    roots: r,
    tpl,
    env,
    options: { dryRun: false, onConflict: 'overwrite', verbose: false, ...options },
    log: log ?? (() => {}),
  }
}

const cache = new Map()

export async function loadAdapter(name, ctx) {
  if (!HOSTS.includes(name)) throw new Error(`unknown host: ${name} (expected ${HOSTS.join('|')})`)
  if (cache.has(name)) return withContext(cache.get(name), ctx)
  const file = path.join(HERE, `${name}.mjs`)
  let mod
  try {
    mod = await import(new URL(`./${name}.mjs`, import.meta.url).href)
  } catch (err) {
    const e = new Error(`adapter for host "${name}" is unavailable (${file}): ${err.message}`)
    e.code = 'ADAPTER_UNAVAILABLE'
    throw e
  }
  const adapter = mod.default ?? mod.adapter
  if (!adapter || typeof adapter.scan !== 'function') {
    throw new Error(`adapter "${name}" does not export { scan(), apply() }: ${file}`)
  }
  cache.set(name, adapter)
  return withContext(adapter, ctx)
}

function withContext(adapter, ctx) {
  return {
    name: adapter.name ?? ctx.host,
    detect: (c = ctx) => adapter.detect(c),
    scan: (c = ctx, opts = {}) => adapter.scan(c, opts),
    plan: (asset, c = ctx) => (adapter.plan ? adapter.plan(asset, c) : genericPlan(asset)),
    apply: (asset, c = ctx, tx) => adapter.apply(asset, c, tx),
    verify: (asset, c = ctx) => (adapter.verify ? adapter.verify(asset, c) : { ok: true, checked: 0 }),
  }
}

/** Fallback plan when an adapter has no plan(): report intent from meta. */
export function genericPlan(asset) {
  const targets = []
  if (asset.meta?.targetPath) targets.push({ path: asset.meta.targetPath, action: 'create' })
  return { asset, action: 'create', targets, reason: 'adapter has no plan(); import will apply directly' }
}

export async function loadAll(ctx, names = HOSTS) {
  const out = []
  for (const name of names) {
    try {
      out.push(await loadAdapter(name, createContext({ ...ctx, host: name })))
    } catch (err) {
      if (err.code === 'ADAPTER_UNAVAILABLE') {
        ctx.log?.(`host ${name}: ${err.message}`)
        continue
      }
      throw err
    }
  }
  return out
}
