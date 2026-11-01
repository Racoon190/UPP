/**
 * uppenv core utilities — path templates, hashing, tree walking, atomic writes.
 *
 * Zero dependencies. Everything here must stay platform-neutral: uppenv images
 * are built on one machine and imported on another (possibly different home,
 * user name and drive letters).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const posix = (p) => String(p).split(path.sep).join('/')

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file))
}

export function sha256Json(value) {
  return sha256(JSON.stringify(value))
}

/** files only, deterministic order, follows no symlinks (records them as is). */
export function walk(dir, base = dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isSymbolicLink()) {
      out.push(abs)
      continue
    }
    if (e.isDirectory()) walk(abs, base, out)
    else if (e.isFile()) out.push(abs)
  }
  return out
}

/** Default junk that must never enter an image. */
export const IGNORE_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db', '__pycache__'])
export const IGNORE_SUFFIX = ['.log', '.tmp', '.swp', '.pyc', '.bak']

export function shouldIgnore(relPosix) {
  const parts = relPosix.split('/')
  if (parts.some((p) => IGNORE_NAMES.has(p))) return true
  return IGNORE_SUFFIX.some((s) => relPosix.toLowerCase().endsWith(s))
}

/**
 * Hash a directory tree: sha256 over `${rel}\0${fileSha}\n` lines.
 * Identical content on two machines yields the identical digest — this is how
 * `apply*` helpers decide create / update / noop.
 */
export function treeDigest(dir, { ignore = false } = {}) {
  const files = []
  let bytes = 0
  for (const abs of walk(dir)) {
    let st
    try {
      st = fs.lstatSync(abs)
    } catch {
      continue
    }
    const rel = posix(path.relative(dir, abs))
    if (ignore && shouldIgnore(rel)) continue
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(abs)
      files.push({ rel, sha256: sha256(`symlink:${target}`), size: 0, link: target })
      continue
    }
    const body = fs.readFileSync(abs)
    bytes += body.length
    files.push({ rel, sha256: sha256(body), size: body.length })
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  const digest = sha256(files.map((f) => `${f.rel}\0${f.sha256}`).join('\n'))
  return { digest, files, bytes }
}

export function fileDigest(file) {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return null
  }
}

export function copyTree(srcDir, destDir, { ignore = true, symlink = false } = {}) {
  for (const abs of walk(srcDir)) {
    const rel = posix(path.relative(srcDir, abs))
    if (ignore && shouldIgnore(rel)) continue
    const dest = path.join(destDir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const st = fs.lstatSync(abs)
    if (st.isSymbolicLink() && symlink) {
      fs.rmSync(dest, { force: true })
      fs.symlinkSync(fs.readlinkSync(abs), dest)
    } else if (st.isSymbolicLink()) {
      // dereference by default: vendored plugins must be self-contained
      const real = fs.statSync(abs)
      if (real.isDirectory()) copyTree(abs, dest, { ignore, symlink })
      else fs.copyFileSync(abs, dest)
    } else {
      fs.copyFileSync(abs, dest)
    }
  }
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.uppenv-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export function writeJson(file, data) {
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

export function slug(s, max = 60) {
  const s2 = String(s)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (!s2) return 'x'
  if (s2.length <= max) return s2
  return `${s2.slice(0, max - 9)}-${sha256(String(s)).slice(0, 8)}`
}

export function uniqueBy(list, keyOf) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const key = keyOf(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export function bytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.html', '.htm', '.sh', '.ps1', '.cmd', '.bat', '.toml', '.ini', '.cfg', '.csv',
  '.xml', '.svg', '.py', '.rs', '.go', '.java', '.sql', '.env', '.gitignore', '.gitattributes',
])

export function looksTextual(file, buf) {
  const ext = path.extname(String(file)).toLowerCase()
  if (!TEXT_EXT.has(ext) && !TEXT_EXT.has(path.basename(String(file)).toLowerCase())) {
    // allow extensionless files that are valid utf8 and short
    if (ext) return false
  }
  if (buf.includes(0)) return false
  return true
}

/**
 * Root templates. Order matters: longest roots are replaced first so that
 * `~/.upp/store` is not shadowed by `~` or by a parent root.
 *
 * `pathToTemplate` rewrites an absolute path into `${TOKEN}/rel` for storage.
 * `expandTemplate` performs the reverse against the *importing* machine roots.
 */
export function createTemplates(roots = {}) {
  const entries = Object.entries(roots)
    .filter(([, v]) => typeof v === 'string' && v.length > 2)
    .map(([k, v]) => [k, path.resolve(v)])
    .sort((a, b) => b[1].length - a[1].length)

  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '')
  const lower = (p) => (process.platform === 'win32' ? norm(p).toLowerCase() : norm(p))

  function pathToTemplate(absPath) {
    // Only absolute paths may be rewritten. Without this guard a bare word such
    // as "node" would resolve against process.cwd() and be mistaken for a path
    // under the WORKSPACE root on the exporting machine.
    if (!path.isAbsolute(String(absPath))) return null
    const p = norm(absPath)
    for (const [token, root] of entries) {
      const rootNorm = norm(root)
      const pl = lower(p)
      const rl = lower(rootNorm)
      if (pl === rl) return `\${${token}}`
      if (pl.startsWith(`${rl}${path.sep}`)) {
        return `\${${token}}/${posix(p.slice(rootNorm.length + 1))}`
      }
    }
    return null
  }

  function expandTemplate(value) {
    if (typeof value !== 'string') return value
    let out = value.replace(/\$\{([A-Z0-9_]+)\}/g, (m, token) => {
      const root = roots[token]
      return typeof root === 'string' ? root : m
    })
    if (out.includes('${')) return out
    // normalize the separator shape that the placeholder carried
    return out
  }

  /** Deep-expand every string inside a JSON-safe value. */
  function expandValue(value) {
    if (typeof value === 'string') return expandTemplate(value)
    if (Array.isArray(value)) return value.map(expandValue)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = expandValue(v)
      return out
    }
    return value
  }

  /** Deep-rewrite absolute host roots into `${TOKEN}` placeholders. */
  function templateValue(value) {
    if (typeof value === 'string') {
      const exact = pathToTemplate(value)
      if (exact) return exact
      // embedded path inside a longer string (command line, docs): rewrite the
      // root plus the path-ish tail that follows it, in posix form.
      let out = value
      for (const [token, root] of entries) {
        const rootPosix = posix(norm(root))
        const pattern = escapeRegex(rootPosix).replace(/\//g, '[\\\\/]')
        const re = new RegExp(`${pattern}([^\\s"'\`,;)]*)`, process.platform === 'win32' ? 'gi' : 'g')
        out = out.replace(re, (m, tail) => `\${${token}}/${posix(tail).replace(/^\/+/, '')}`.replace(/\/+$/, tail === '' ? '' : '/'))
      }
      return out
    }
    if (Array.isArray(value)) return value.map(templateValue)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = templateValue(v)
      return out
    }
    return value
  }

  return { roots, entries, pathToTemplate, expandTemplate, expandValue, templateValue }
}

/** Shared app roots for every adapter (resolved once, never guessed twice). */
export function detectRoots(env = process.env) {
  const home = env.USERPROFILE || env.HOME || env.HOMEPATH || process.cwd()
  const dshHome = env.DSH_HOME || path.join(home, '.dsh')
  const workbuddyHome = path.join(home, '.workbuddy')
  const codebuddyHome = path.join(home, '.codebuddy')
  const accioHome = path.join(home, '.accio')
  return {
    home,
    dshHome,
    uppStore: path.join(home, '.upp'),
    workbuddyHome,
    codebuddyHome,
    accioHome,
    workspace: process.cwd(),
    platform: process.platform,
    node: process.version,
    arch: process.arch,
  }
}

export function exists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name))))
      .map((e) => path.join(dir, e.name))
      .sort()
  } catch {
    return []
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function withTimeout(promise, ms, label = 'operation') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    if (timer.unref) timer.unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
