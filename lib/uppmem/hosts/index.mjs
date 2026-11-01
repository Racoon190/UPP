/**
 * Loader for uppmem host adapters: lib/uppmem/hosts/<host>.mjs
 * Each adapter exports { name, memoryFileFormat?, detect, pull, push, install? }.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const MEMORY_HOSTS = ['dsh', 'workbuddy', 'accio']
const HOSTS_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Absolute path of the uppmem CLI, used when a host entry has to spawn it (`uppmem mcp`). */
const CLI_PATH = path.resolve(HOSTS_DIR, '..', '..', '..', 'tools', 'uppmem.mjs')

export class AdapterError extends Error {
  constructor(message, code = 'ADAPTER_UNAVAILABLE') {
    super(message)
    this.code = code
  }
}

export function createContext({ host, roots, options = {}, env = process.env, log = () => {}, now = () => new Date().toISOString() } = {}) {
  return { host, roots, env, options, log, now, cli: options.cli ?? CLI_PATH }
}

export async function loadMemoryAdapter(host, ctx) {
  const name = String(host ?? '')
  if (!MEMORY_HOSTS.includes(name)) throw new AdapterError(`unknown host "${name}" (expected ${MEMORY_HOSTS.join('|')})`, 'E_USAGE')
  const file = path.join(HOSTS_DIR, `${name}.mjs`)
  if (!fs.existsSync(file)) throw new AdapterError(`host adapter not installed: hosts/${name}.mjs`, 'ADAPTER_UNAVAILABLE')
  const mod = await import(pathToFileURL(file).href)
  if (typeof mod.pull !== 'function' || typeof mod.push !== 'function' || typeof mod.detect !== 'function') {
    throw new AdapterError(`hosts/${name}.mjs does not implement detect/pull/push`, 'ADAPTER_INVALID')
  }
  return {
    name: mod.name ?? name,
    memoryFileFormat: mod.memoryFileFormat ?? 'unknown',
    mod,
    detect: () => mod.detect(ctx),
    pull: () => mod.pull(ctx),
    push: (payload) => mod.push(ctx, payload),
    install: mod.install ? (payload) => mod.install(ctx, payload) : null,
  }
}

export async function loadMemoryAdapters(ctx) {
  const out = {}
  for (const host of MEMORY_HOSTS) {
    try {
      out[host] = { ok: true, adapter: await loadMemoryAdapter(host, { ...ctx, host }) }
    } catch (err) {
      out[host] = { ok: false, error: err?.message ?? String(err), code: err?.code ?? 'ADAPTER_UNAVAILABLE' }
    }
  }
  return out
}

export async function detectMemoryHosts(ctx) {
  const rows = []
  for (const host of MEMORY_HOSTS) {
    try {
      const adapter = await loadMemoryAdapter(host, { ...ctx, host })
      const info = await adapter.detect()
      rows.push({ host, installed: true, ...info })
    } catch (err) {
      rows.push({ host, installed: false, available: false, reason: err?.message ?? String(err) })
    }
  }
  return rows
}
