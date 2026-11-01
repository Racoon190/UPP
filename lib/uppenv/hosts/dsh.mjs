/**
 * dsh.mjs — DeepSeek Harness (DSH) host adapter for `uppenv`.
 *
 * Host knowledge encoded here (see docs/03-host-dsh.md):
 *   - A DSH install is `<DSH_HOME>` (= $DSH_HOME or ~/.dsh) with one or more
 *     profiles under `profiles/<name>/`. Only the profile is machine-specific.
 *   - Installed plugins are declared twice: `dependencies` in the profile
 *     `package.json`, plus the ordered `dsh.profile.bundles` array. Both are
 *     required for a bundle layer to load; package.json alone means "dep only".
 *   - A plugin package contributes loader rows through `dsh.bundle.patch`
 *     (a YAML patch file next to its package.json). `link:` installs point at
 *     the source dir, so its patch may contain absolute source paths that must
 *     be rewritten when the package is vendored into another profile.
 *   - User overrides live in `profiles/<p>/cordis.patch.yml`: a top-level YAML
 *     array of loader rows (`id`/`name`/`config`/`disabled`/`inject`) and
 *     `- insert:` lists. This file is the only user-owned config; the bundle
 *     layers below it are replaced on upgrade.
 *   - MCP has no config file: an MCP server is a row
 *     `name: '@deepseek-ai/dsh-mcp-client'` with `config.serverName`.
 *     Tools are named `mcp__<serverName>__<tool>` and are discovered at runtime.
 *   - Skills are directories under `<DSH_HOME>/skills/<dir>/SKILL.md`.
 *   - There is NO native memory file: memory must be reported `missing-host`.
 *
 * Everything below is pure read-only scanning until `apply()`, which only
 * mutates through the Tx and only shells out through `tx.exec()`.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  createTemplates,
  detectRoots,
  exists,
  isDir,
  listDirs,
  posix,
  readJson,
  readText,
  sha256,
  sha256File,
  shouldIgnore,
  treeDigest,
} from '../core/util.mjs'
import { applyCopyTree, applyMergeJson, applyWriteText, jsonAction } from '../core/apply.mjs'

const HOST = 'dsh'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const PATCH_FILE = 'cordis.patch.yml'
const SKILL_FILE = 'SKILL.md'
const VENDOR_DIR = '.uppenv/vendor' // profile-local `file:` dependency targets (see applyPluginTree)

const MCP_TRANSPORT = (cfg) => cfg?.transport ?? (cfg?.url ? 'streamable-http' : 'stdio')
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const normWin = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase()

function tplFromRoots(roots = {}) {
  return createTemplates({
    HOME: roots.home,
    DSH_HOME: roots.dshHome,
    UPP_STORE: roots.uppStore,
    WORKBUDDY_HOME: roots.workbuddyHome,
    CODEBUDDY_HOME: roots.codebuddyHome,
    ACCIO_HOME: roots.accioHome,
    WORKSPACE: roots.workspace,
  })
}

/** Context used when a caller invokes the adapter without a core ctx (tests). */
function fallbackCtx() {
  const roots = detectRoots(process.env)
  return {
    host: HOST,
    roots,
    tpl: tplFromRoots(roots),
    env: process.env,
    options: { dryRun: false, onConflict: 'overwrite', verbose: false, vendor: 'auto', includeBuiltin: false },
    log: () => {},
  }
}

/**
 * Accept both documented call shapes because hosts/index.mjs and image.mjs do
 * not agree on scan()'s first argument: `scan(ctx, opts)` (CLI) and
 * `scan({ kinds, ids, includeBuiltin })` (image builder).
 */
function normCtx(ctx, opts) {
  const scanOpts = ['kinds', 'ids', 'includeBuiltin', 'vendor', 'profile', 'dryRun', 'onConflict']
  let c = null
  let o = { ...(opts ?? {}) }
  if (ctx && typeof ctx === 'object' && ctx.roots) {
    c = ctx
    o = { ...(isObj(ctx.options) ? ctx.options : {}), ...o }
  } else {
    if (ctx && typeof ctx === 'object') for (const k of scanOpts) if (ctx[k] !== undefined) o[k] = ctx[k]
    c = fallbackCtx()
  }
  if (!c.tpl || typeof c.tpl.pathToTemplate !== 'function') c = { ...c, tpl: tplFromRoots(c.roots) }
  if (typeof c.log !== 'function') c = { ...c, log: () => {} }
  if (!o.vendor) o.vendor = 'auto'
  return { ctx: c, opts: o }
}

// --------------------------------------------------------------------- state

/** Read-only snapshot of the DSH home + selected profile. */
function profileState(ctx) {
  const roots = ctx.roots ?? {}
  const env = ctx.env ?? process.env
  const dshHome = roots.dshHome ? path.resolve(roots.dshHome) : ''
  const profilesDir = dshHome ? path.join(dshHome, 'profiles') : ''
  const profileDirs = profilesDir ? listDirs(profilesDir) : []
  const requested = ctx.options?.profile || env.DSH_PROFILE || ''
  const profileName = requested || (profileDirs.length ? path.basename(profileDirs[0]) : 'desktop')
  const profileDir = profilesDir ? path.join(profilesDir, profileName) : ''
  const packageJson = profileDir ? path.join(profileDir, 'package.json') : ''
  const pkg = packageJson ? readJson(packageJson, null) : null
  const deps = pkg && isObj(pkg.dependencies) ? { ...pkg.dependencies } : {}
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.map(String) : []
  return {
    dshHome,
    profilesDir,
    profileName,
    profileDir,
    packageJson,
    patchFile: profileDir ? path.join(profileDir, PATCH_FILE) : '',
    nodeModules: profileDir ? path.join(profileDir, 'node_modules') : '',
    skillsDir: dshHome ? path.join(dshHome, 'skills') : '',
    pkg,
    deps,
    bundles,
    profileDirs,
    ok: Boolean(dshHome && isDir(dshHome) && profileDir && isDir(profileDir) && pkg),
  }
}

function profilePatchText(st) {
  return st.patchFile ? readText(st.patchFile, '') : ''
}

function resolveBundlePatch(pkgDir, pkg) {
  const decl = pkg?.dsh?.bundle
  const rel = typeof decl === 'string' ? decl : decl?.patch
  if (!rel) return null
  const abs = path.resolve(pkgDir, String(rel))
  return exists(abs) ? abs : null
}

// ------------------------------------------------------------------- fs walk

/** Every real file under dir with posix rel paths; skips junk and *.upp-bak-* backups. */
function collectFiles(rootDir) {
  const out = []
  const seenDirs = new Set()
  const visit = (dir, relBase, depth) => {
    if (depth > 64) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      const rel = relBase ? `${relBase}/${e.name}` : e.name
      if (shouldIgnore(rel) || /\.upp-bak/.test(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        let real
        try {
          real = fs.realpathSync(abs)
        } catch {
          continue
        }
        let st
        try {
          st = fs.statSync(abs)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          if (seenDirs.has(normWin(real))) continue
          seenDirs.add(normWin(real))
          visit(abs, rel, depth + 1)
        } else if (st.isFile()) {
          out.push({ rel, src: abs }) // dereferenced by image.mjs on export
        }
      } else if (e.isDirectory()) {
        visit(abs, rel, depth + 1)
      } else if (e.isFile()) {
        out.push({ rel, src: abs })
      }
    }
  }
  const realRoot = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : null
  if (realRoot) seenDirs.add(normWin(realRoot))
  visit(rootDir, '', 0)
  out.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  return out
}

// --------------------------------------------------------------- tiny YAML
// DSH patch layers are a small YAML subset: block maps/sequences, flow
// `[...]`/`{...}`, quoted Windows paths, comments, and `!!js` tags. Block
// scalars (`|`, `>`) and anchors are not used by any DSH patch we support;
// they are kept as literal strings rather than guessed at.

const YAML_UNSUPPORTED = Symbol('yaml-unsupported')

function stripYamlComment(line) {
  let single = false
  let double = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (double) {
      if (ch === '\\') i++
      else if (ch === '"') double = false
      continue
    }
    if (single) {
      if (ch === "'") {
        if (line[i + 1] === "'") i++
        else single = false
      }
      continue
    }
    if (ch === "'") single = true
    else if (ch === '"') double = true
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

function parseYaml(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)
  const toks = []
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripYamlComment(lines[i]).replace(/\s+$/, '')
    if (!stripped.trim() || stripped.trim() === '---') continue
    toks.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim(), line: i + 1 })
  }
  let pos = 0
  const err = (msg) => {
    const e = new Error(`yaml: ${msg}`)
    e.code = 'YAML_UNSUPPORTED'
    return e
  }
  const looksMap = (s) => {
    const ci = topColon(s)
    return ci >= 0 && (ci === s.length - 1 || /\s/.test(s[ci + 1]))
  }
  function parseNode(minIndent) {
    const t = toks[pos]
    if (!t || t.indent < minIndent) return null
    if (t.text.startsWith('-') && (t.text.length === 1 || /\s/.test(t.text[1]))) return parseSeq(t.indent)
    return parseMap(t.indent)
  }
  function parseSeq(indent) {
    const out = []
    while (pos < toks.length) {
      const t = toks[pos]
      if (t.indent !== indent || !t.text.startsWith('-') || (t.text.length > 1 && !/\s/.test(t.text[1]))) break
      pos++
      const rest = t.text.slice(1).trimStart()
      const contentIndent = indent + (t.text.length - t.text.slice(1).trimStart().length)
      if (!rest) {
        out.push(parseNode(indent + 1))
      } else if (looksMap(rest)) {
        const map = {}
        parseEntry(map, rest, contentIndent)
        while (pos < toks.length && toks[pos].indent === contentIndent && !toks[pos].text.startsWith('-')) {
          const nt = toks[pos]
          pos++
          parseEntry(map, nt.text, contentIndent)
        }
        out.push(map)
      } else {
        out.push(parseScalar(rest))
      }
    }
    return out
  }
  function parseMap(indent) {
    const map = {}
    while (pos < toks.length) {
      const t = toks[pos]
      if (t.indent !== indent || t.text.startsWith('-')) break
      pos++
      parseEntry(map, t.text, indent)
    }
    return map
  }
  function parseEntry(map, text, indent) {
    const ci = topColon(text)
    if (ci < 0) throw err(`expected "key: value" at column ${indent}`)
    const key = String(parseScalar(text.slice(0, ci).trim()))
    map[key] = parseValue(text.slice(ci + 1).trim(), indent)
  }
  function parseValue(rest, keyIndent) {
    let body = rest
    let tag = null
    const tm = /^(!{1,2}[A-Za-z0-9_:/.-]+)\s+([\s\S]*)$/.exec(body)
    if (tm) {
      tag = tm[1]
      body = tm[2]
    }
    let value
    if (!body) {
      const nt = toks[pos]
      value = nt && nt.indent > keyIndent ? parseNode(nt.indent) : null
    } else if (body.startsWith('[') || body.startsWith('{')) {
      value = parseFlow(body)
    } else {
      value = parseScalar(body)
    }
    if (tag) value = tag === '!!js' ? { $js: String(value) } : value
    return value
  }
  function parseFlow(src) {
    let i = 0
    const ws = () => {
      while (i < src.length && /\s/.test(src[i])) i++
    }
    const quoted = () => {
      const q = src[i++]
      let s = ''
      while (i < src.length) {
        const ch = src[i++]
        if (q === "'") {
          if (ch === "'") {
            if (src[i] === "'") {
              s += "'"
              i++
            } else return s
          } else s += ch
        } else if (ch === '\\') {
          s += src[i++]
        } else if (ch === '"') return s
        else s += ch
      }
      return s
    }
    const value = () => {
      ws()
      if (src[i] === '[') {
        i++
        const arr = []
        ws()
        if (src[i] === ']') {
          i++
          return arr
        }
        for (;;) {
          arr.push(value())
          ws()
          if (src[i] === ',') i++
          else if (src[i] === ']') {
            i++
            return arr
          } else return arr
        }
      }
      if (src[i] === '{') {
        i++
        const obj = {}
        ws()
        if (src[i] === '}') {
          i++
          return obj
        }
        for (;;) {
          ws()
          const k = src[i] === "'" || src[i] === '"' ? quoted() : plain()
          ws()
          if (src[i] === ':') i++
          obj[String(k)] = value()
          ws()
          if (src[i] === ',') i++
          else if (src[i] === '}') {
            i++
            return obj
          } else return obj
        }
      }
      if (src[i] === "'" || src[i] === '"') return quoted()
      return plain()
    }
    const plain = () => {
      const start = i
      while (i < src.length && !/[,\]}]/.test(src[i])) i++
      return parseScalar(src.slice(start, i).trim())
    }
    const v = value()
    return v === YAML_UNSUPPORTED ? null : v
  }
  try {
    const doc = toks.length ? parseNode(0) : null
    return { ok: true, value: doc }
  } catch (e) {
    return { ok: false, value: null, error: e.message }
  }
}

function topColon(text) {
  let single = false
  let double = false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (double) {
      if (ch === '\\') i++
      else if (ch === '"') double = false
      continue
    }
    if (single) {
      if (ch === "'") single = false
      continue
    }
    if (ch === "'") single = true
    else if (ch === '"') double = true
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ':' && depth === 0) return i
  }
  return -1
}

function parseScalar(raw) {
  const s = String(raw).trim()
  if (!s) return null
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+$/.test(s)) return Number(s)
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1).replace(/\\"/g, '"')
    }
  }
  return s
}

/** Serialize a JS value into the YAML block subset used by DSH patches. */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const s = String(value)
  if (s === '') return "''"
  const plainOk =
    /^[A-Za-z0-9_][A-Za-z0-9 _./-]*$/.test(s) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(s) &&
    !s.includes(': ') &&
    !s.includes(' #') &&
    !/[\\]/.test(s) &&
    !s.startsWith('-')
  return plainOk ? s : `'${s.replace(/'/g, "''")}'`
}

function emitBlock(value, indent) {
  const pad = ' '.repeat(indent)
  const out = []
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue
    const key = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(k) ? k : yamlScalar(k)
    if (isObj(v)) {
      if (!Object.keys(v).length) out.push(`${pad}${key}: {}`)
      else out.push(`${pad}${key}:`, ...emitBlock(v, indent + 2))
    } else if (Array.isArray(v)) {
      if (!v.length) out.push(`${pad}${key}: []`)
      else out.push(`${pad}${key}:`, ...emitArray(v, indent + 2))
    } else out.push(`${pad}${key}: ${yamlScalar(v)}`)
  }
  return out
}

function emitArray(arr, indent) {
  const pad = ' '.repeat(indent)
  const out = []
  for (const v of arr) {
    if (isObj(v)) {
      const inner = emitBlock(v, indent + 2)
      out.push(`${pad}- ${inner[0].trimStart()}`, ...inner.slice(1))
    } else if (Array.isArray(v)) {
      out.push(`${pad}-`, ...emitArray(v, indent + 2))
    } else out.push(`${pad}- ${yamlScalar(v)}`)
  }
  return out
}

/** One loader row: `- id: ...` plus its keys (no insert wrapper). */
function emitRow(row, indent) {
  const pad = ' '.repeat(indent)
  const out = [`${pad}- id: ${yamlScalar(row.id ?? row.rowId ?? 'row')}`]
  if (row.name) out.push(`${pad}  name: ${yamlScalar(row.name)}`)
  if (row.inject !== undefined) out.push(`${pad}  inject: ${Array.isArray(row.inject) ? `[${row.inject.map(yamlScalar).join(', ')}]` : yamlScalar(row.inject)}`)
  if (row.disabled !== undefined) out.push(`${pad}  disabled: ${row.disabled}`)
  if (row.config !== undefined) {
    if (isObj(row.config) && !Object.keys(row.config).length) out.push(`${pad}  config: {}`)
    else if (isObj(row.config)) out.push(`${pad}  config:`, ...emitBlock(row.config, indent + 4))
    else out.push(`${pad}  config: ${yamlScalar(row.config)}`)
  }
  return out
}

function emitInsertRow(row, indent) {
  return [`${' '.repeat(indent)}- insert:`, ...emitRow(row, indent + 4)]
}

function indentOf(line) {
  return line.length - line.trimStart().length
}

/** End (exclusive) of the block that starts at `start`: deeper lines + blank/comment lines. */
function blockEnd(lines, start) {
  const base = indentOf(lines[start])
  let end = start + 1
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) {
      end = i + 1
      continue
    }
    if (line.trimStart().startsWith('#')) {
      end = i + 1
      continue
    }
    if (indentOf(line) <= base) break
    end = i + 1
  }
  while (end > start + 1 && !lines[end - 1].trim()) end--
  return end
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

/**
 * Portable template form of one host string.
 *
 * `ctx.tpl.templateValue()` cannot be used directly here: it resolves *every*
 * string as a path, so `link:H:/src/plug`, a version like `1.9.42` and whole
 * YAML patch documents came back as `${WORKSPACE}/...`. This helper mirrors
 * the same token vocabulary but only canonicalizes strings that really are
 * absolute paths and otherwise rewrites embedded root prefixes in place.
 */
function templText(ctx, value) {
  const s = String(value ?? '')
  if (!s) return s
  const tpl = ctx.tpl ?? {}
  if (ABS_PATH_RE.test(s) && typeof tpl.pathToTemplate === 'function') {
    const exact = tpl.pathToTemplate(s)
    if (exact) return exact
  }
  let out = s
  for (const [token, root] of Object.entries(tpl.entries ?? {})) {
    if (!root) continue
    const pattern = String(root).split(/[\\/]+/).map(escapeRe).join('[\\\\/]')
    const re = new RegExp(`${pattern}((?:[\\\\/][^\\s'"\\]]*)?)`, 'gi')
    out = out.replace(re, (_m, tail) => `\${${token}}${tail ? tail.replace(/\\/g, '/') : ''}`)
  }
  return out
}

/** Deep variant of templText for config fragments / row objects. */
function templDeep(ctx, value) {
  if (typeof value === 'string') return templText(ctx, value)
  if (Array.isArray(value)) return value.map((v) => templDeep(ctx, v))
  if (isObj(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = templDeep(ctx, v)
    return out
  }
  return value
}

/**
 * Upsert one loader row into a patch document, preserving comments and layout.
 * Rows inside `- insert:` lists are replaced in place; otherwise a new
 * `- insert:` block is appended (valid and used by real DSH packages).
 */
function upsertPatchRow(text, row, { insert = true } = {}) {
  const src = String(text ?? '')
  const lines = src ? src.split(/\r?\n/) : []
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const idRe = new RegExp(`^\\s*-\\s+id:\\s*(['"]?)${escapeRe(row.id ?? row.rowId)}\\1\\s*$`)
  const serverRe = row.config?.serverName ? new RegExp(`^\\s+serverName:\\s*(['"]?)${escapeRe(row.config.serverName)}\\1\\s*$`, 'm') : null
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s/.test(lines[i])) continue
    const end = blockEnd(lines, i)
    const block = lines.slice(i, end).join('\n')
    const idLine = lines[i].trim()
    const directId = /^-\s+id:\s*(.+)$/.exec(idLine)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
    const matches = directId === row.id || (serverRe && serverRe.test(block))
    if (!matches) continue
    const indent = indentOf(lines[i])
    const replacement = indent > 0 ? emitRow(row, indent) : insert ? emitInsertRow(row, 0) : emitRow(row, 0)
    lines.splice(i, end - i, ...replacement)
    return `${lines.join('\n')}\n`
  }
  const block = insert ? emitInsertRow(row, 0) : emitRow(row, 0)
  if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('')
  lines.push(...block)
  return `${lines.join('\n')}\n`
}

function patchRowsWith(text, rows, rowOpts = {}) {
  let out = text
  for (const row of rows) out = upsertPatchRow(out, row, rowOpts)
  return out
}

/** Flatten a parsed patch document into loader rows (insert lists included). */
function patchRows(doc) {
  const rows = []
  const list = Array.isArray(doc) ? doc : doc ? [doc] : []
  for (const entry of list) {
    if (!isObj(entry)) continue
    if (Array.isArray(entry.insert)) {
      for (const row of entry.insert) if (isObj(row)) rows.push({ ...row, inInsert: true })
    } else if (entry.id !== undefined || entry.name !== undefined) rows.push({ ...entry, inInsert: false })
  }
  return rows
}

function parsePatchFile(file) {
  const text = readText(file, '')
  if (!text.trim()) return { ok: true, value: [], text }
  const parsed = parseYaml(text)
  if (!parsed.ok) return { ok: false, value: [], text, error: parsed.error }
  return { ok: true, value: parsed.value, text }
}

// ------------------------------------------------------------ discovery bits

/** Find the DSH CLI (`dsh plugin ...`) without hardcoding an install path. */
function findDsh(ctx) {
  const env = ctx.env ?? process.env
  const configured = env.DSH_CLI || env.UPPENV_DSH_CLI
  if (configured) return exists(configured) ? { found: true, command: configured, source: 'DSH_CLI' } : { found: false, source: 'DSH_CLI', command: configured }
  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    const candidates = [
      env.ProgramFiles ? path.join(env.ProgramFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') : '',
      localAppData ? path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') : '',
    ].filter(Boolean)
    for (const c of candidates) if (exists(c)) return { found: true, command: c, source: 'app-dir' }
  }
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, `dsh${ext}`)
      if (exists(candidate)) return { found: true, command: candidate, source: 'PATH' }
    }
  }
  return { found: false, source: 'PATH' }
}

const quoteCmd = (s) => (/[\s()]/.test(String(s)) ? `"${String(s)}"` : String(s))

/** Classify one dependency entry into a plugin scan asset. `patchDoc` is the parsed user patch (shared by all plugins). */
function scanPlugin(ctx, st, name, spec, opts, log, patchDoc) {
  const tpl = ctx.tpl
  const lexical = path.join(st.nodeModules, ...String(name).split('/'))
  if (!isDir(lexical)) {
    log(`plugin ${name}: not installed in ${st.nodeModules} (dependency "${spec}") — skipped`)
    return null
  }
  let real = lexical
  try {
    real = fs.realpathSync(lexical)
  } catch {}
  const pkg = readJson(path.join(real, 'package.json'), {}) ?? {}
  const specText = String(spec)
  const storeTpl = templText(ctx, real)
  // Where the package really lives: for link:/file: installs the dependency spec
  // names the source directory (which may be outside every well-known root and
  // may differ from the realpath of the installed entry).
  const specTarget = /^(link|file):/i.test(specText) ? specText.replace(/^(link|file):/i, '') : ''
  const sourceRootAbs = specTarget && path.isAbsolute(specTarget) ? specTarget : real
  const inProfile = normWin(real).startsWith(`${normWin(st.profileDir)}${path.sep}`) || normWin(real) === normWin(st.profileDir)
  const linkSpec = /^(link|file):/i.test(specText) || !inProfile
  const source = storeTpl?.startsWith('${UPP_STORE}/') || storeTpl === '${UPP_STORE}' ? 'upp' : linkSpec ? 'link' : 'registry'
  const vendor = opts.vendor === 'full' ? 'full' : opts.vendor === 'manifest' ? 'manifest' : source === 'registry' ? 'manifest' : 'full'

  const warnings = []
  const deps = isObj(pkg.dependencies) ? Object.keys(pkg.dependencies) : []
  const nodeModulesDir = path.join(real, 'node_modules')
  if (vendor === 'full' && deps.length && isDir(nodeModulesDir)) warnings.push(`${deps.length} runtime dependency(ies) live in the package's own node_modules; a vendored tree may be incomplete`)
  else if (vendor === 'full' && deps.length) warnings.push(`package declares dependencies [${deps.join(', ')}]; a vendored tree does not include them`)

  const patchFile = resolveBundlePatch(real, pkg)
  let bundlePatch = null
  if (patchFile) {
    const raw = readText(patchFile, '')
    bundlePatch = { rel: posix(path.relative(real, patchFile)), text: templText(ctx, raw), sourceRoot: templText(ctx, sourceRootAbs) }
    const parsed = parseYaml(raw)
    if (parsed.ok) {
      for (const row of patchRows(parsed.value)) {
        for (const value of [row.config]) {
          for (const abs of absolutePathsIn(value)) {
            if (tpl.pathToTemplate(abs)) continue
            if (abs.startsWith(patchFile)) continue
            warnings.push(`bundle patch references a host-absolute path outside known roots (${abs}); it may not exist on the importing machine`)
          }
        }
      }
    } else {
      warnings.push(`could not parse ${bundlePatch.rel}: ${parsed.error}`)
    }
  }

  const userRows = patchDoc.ok ? patchRows(patchDoc.value).filter((r) => r.name === name || String(r.name ?? '').startsWith(`${name}/`)) : []

  const hasUi = Boolean(pkg?.dsh?.client?.platform) || Boolean(pkg?.exports?.['./client'])
  const files = vendor === 'full' ? collectFiles(real) : []
  const assets = {
    kind: 'plugin',
    host: HOST,
    id: name,
    label: pkg.description ? String(pkg.description).slice(0, 120) : undefined,
    version: pkg.version ? String(pkg.version) : specText.replace(/^(link|file):/, ''),
    strategy: vendor === 'full' ? 'copy-tree' : 'exec',
    requires: vendor === 'full' ? [] : ['node>=22'],
    files,
    meta: {
      packageName: name,
      installedVersion: pkg.version ? String(pkg.version) : undefined,
      source,
      depSpec: templText(ctx, specText),
      linkPath: source === 'registry' ? undefined : templText(ctx, sourceRootAbs),
      bundles: st.bundles.filter((b) => b === name),
      config: userRows.map((r) => templDeep(ctx, r)),
      hasUi,
      vendor,
      deps,
      bundlePatch,
      warnings: warnings.slice(0, 8),
    },
  }
  return assets
}

/** Collect absolute host paths from a parsed config fragment (for warnings). */
function absolutePathsIn(value, out = []) {
  if (typeof value === 'string') {
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) out.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) absolutePathsIn(v, out)
  } else if (isObj(value)) {
    for (const v of Object.values(value)) absolutePathsIn(v, out)
  }
  return out
}

function scanSkill(ctx, dir, log) {
  const skillMd = path.join(dir, SKILL_FILE)
  if (!exists(skillMd)) {
    log(`skill ${path.basename(dir)}: no ${SKILL_FILE} — skipped`)
    return null
  }
  const front = parseYaml(readText(skillMd, '').replace(/^---\r?\n([\s\S]*?)\r?\n---[\s\S]*$/, '$1'))
  const fm = front.ok && isObj(front.value) ? front.value : {}
  const files = collectFiles(dir)
  return {
    kind: 'skill',
    host: HOST,
    id: path.basename(dir),
    label: fm.name ? String(fm.name) : path.basename(dir),
    version: fm.version ? String(fm.version) : undefined,
    strategy: 'copy-tree',
    files,
    meta: {
      skillRoot: templText(ctx, dir),
      dirName: path.basename(dir),
      files: files.length,
      hasScripts: files.some((f) => /\.(sh|ps1|cmd|bat|py|js|mjs|cjs|ts)$/i.test(f.rel) || /^(scripts|bin)\//.test(f.rel)),
      description: fm.description ? String(fm.description).slice(0, 200) : undefined,
    },
  }
}

/** User-level MCP servers: only rows actually present in user config files. */
function scanMcp(ctx, st, log, patchDoc) {
  const out = []
  if (!st.patchFile) return out
  if (!patchDoc) patchDoc = parsePatchFile(st.patchFile)
  if (!patchDoc.ok) {
    log(`mcp: could not parse ${PATCH_FILE} (${patchDoc.error}); run \`uppenv scan --json\` for details`)
    return out
  }
  const configFile = templText(ctx, st.patchFile)
  for (const row of patchRows(patchDoc.value)) {
    if (row.name !== MCP_CLIENT) continue
    const cfg = row.config
    const serverName = cfg?.serverName
    if (!serverName) {
      log(`mcp: ${PATCH_FILE} has a ${MCP_CLIENT} row without config.serverName — skipped`)
      continue
    }
    out.push({
      kind: 'mcp',
      host: HOST,
      id: String(serverName),
      label: String(serverName),
      strategy: 'write-file',
      requires: [],
      files: [],
      meta: {
        serverName: String(serverName),
        configFile,
        entry: templDeep(ctx, cfg),
        transport: MCP_TRANSPORT(cfg),
        patchId: row.id ? String(row.id) : `${serverName}-mcp`,
        origin: 'profile-patch',
      },
    })
  }
  // Hypothetical standalone JSON MCP files (DSH has none today) — only if present.
  for (const file of [path.join(st.profileDir, 'mcp.json'), path.join(st.dshHome, 'mcp.json')]) {
    if (!exists(file)) continue
    const json = readJson(file, null)
    for (const [serverName, entry] of Object.entries(json?.mcpServers ?? {})) {
      out.push({
        kind: 'mcp',
        host: HOST,
        id: String(serverName),
        strategy: 'merge-json',
        files: [],
        meta: {
          serverName: String(serverName),
          configFile: templText(ctx, file),
          entry: templDeep(ctx, entry),
          transport: MCP_TRANSPORT(entry),
          origin: 'json-file',
        },
      })
    }
  }
  return out
}

/** MCP servers contributed by enabled bundle packages (owned by the plugin, logged only). */
function bundledMcp(ctx, st, log) {
  const found = []
  for (const bundle of st.bundles) {
    const dir = path.join(st.nodeModules, ...bundle.split('/'))
    if (!isDir(dir)) continue
    let real = dir
    try {
      real = fs.realpathSync(dir)
    } catch {}
    const pkg = readJson(path.join(real, 'package.json'), {}) ?? {}
    const file = resolveBundlePatch(real, pkg)
    if (!file) continue
    const parsed = parsePatchFile(file)
    if (!parsed.ok) continue
    for (const row of patchRows(parsed.value)) {
      const serverName = row.name === MCP_CLIENT ? row.config?.serverName : null
      if (serverName) found.push({ serverName: String(serverName), bundle })
    }
  }
  if (found.length) {
    log(
      `mcp: ${found.length} server(s) come from enabled bundles (${found
        .map((f) => `${f.serverName}<-${f.bundle}`)
        .join(', ')}); they travel with the plugin assets, not as separate user config`,
    )
  }
  return found
}

// ---------------------------------------------------------------- scan/plan

function scan(ctxRaw, optsRaw) {
  const { ctx, opts } = normCtx(ctxRaw, optsRaw)
  const log = ctx.log
  const st = profileState(ctx)
  const wanted = Array.isArray(opts.kinds) && opts.kinds.length ? opts.kinds : ['plugin', 'skill', 'mcp', 'tool', 'memory']
  const includeBuiltin = Boolean(opts.includeBuiltin)
  const out = []
  const push = (asset) => {
    if (!asset) return
    if (!wanted.includes(asset.kind)) return
    if (Array.isArray(opts.ids) && opts.ids.length && !opts.ids.includes(asset.id)) return
    if (asset.builtin && !includeBuiltin) return
    out.push(asset)
  }

  if (!st.dshHome || !isDir(st.dshHome)) {
    log(`dsh: no DSH home at ${st.dshHome || '(unresolved)'} — nothing to scan`)
    return out
  }
  const patchDoc = parsePatchFile(st.patchFile)
  if (!patchDoc.ok) log(`dsh: could not parse ${st.patchFile} (${patchDoc.error}); plugin overrides and user-level MCP are skipped`)

  if (wanted.includes('plugin')) {
    for (const [name, spec] of Object.entries(st.deps)) push(scanPlugin(ctx, st, name, spec, opts, log, patchDoc))
    // Bundles whose package is not a dependency are host-shipped (or leftovers).
    for (const bundle of st.bundles) {
      if (bundle in st.deps) continue
      const dir = path.join(st.nodeModules, ...bundle.split('/'))
      if (isDir(dir)) {
        const asset = scanPlugin(ctx, st, bundle, `link:${dir}`, opts, log, patchDoc)
        if (asset) push({ ...asset, builtin: true })
      } else {
        log(`plugin ${bundle}: host-shipped bundle, not a profile dependency — not exportable (use --include-builtin only for profile-local packages)`)
      }
    }
  }

  if (wanted.includes('skill') && st.skillsDir) {
    for (const dir of listDirs(st.skillsDir)) push(scanSkill(ctx, dir, log))
    if (!isDir(st.skillsDir)) log(`dsh: no skills directory at ${st.skillsDir}`)
  }

  if (wanted.includes('mcp')) {
    const userMcp = scanMcp(ctx, st, log, patchDoc)
    for (const asset of userMcp) push(asset)
    // Bundle-contributed MCP servers are part of the plugin, not user config.
    if (!userMcp.length) bundledMcp(ctx, st, log)
  }

  if (wanted.includes('tool')) {
    log('tool: DSH exposes MCP tools at runtime (mcp__<server>__<tool>); there is no static tool snapshot to export')
  }
  if (wanted.includes('memory')) {
    log('memory: DSH has no native memory file (sessions/storages are host-managed); memory assets are not exported')
  }
  return out
}

const schemaTarget = (p, action, detail) => (detail ? { path: p, action, detail } : { path: p, action })

function aggAction(targets) {
  const changed = targets.filter((t) => t.action !== 'noop')
  if (!changed.length) return 'noop'
  if (changed.some((t) => t.action === 'create') && !changed.some((t) => t.action === 'update')) return 'create'
  return 'update'
}

function payloadDir(asset) {
  if (asset?.dir && isDir(asset.dir)) return asset.dir
  return null
}

/** Digest of the image payload; works for materialized assets (files[].path) and raw scans (files[].src). */
function assetDigest(asset, skip = []) {
  const skipSet = new Set((skip ?? []).map((r) => posix(String(r))))
  const list = (asset?.files ?? [])
    .filter((f) => !skipSet.has(posix(String(f.rel))))
    .map((f) => {
      const sha = f.sha256 ?? (f.path ? sha256File(f.path) : f.src ? sha256File(f.src) : '')
      return { rel: posix(String(f.rel)), sha: sha ?? '' }
    })
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return sha256(list.map((f) => `${f.rel}\u0000${f.sha}`).join('\n'))
}

/**
 * create/update/noop for a directory that should match an image payload.
 * Uses payload digests so it does not need a materialized payload directory.
 * `skip` lists rels that apply intentionally rewrites (the bundle patch of a
 * vendored plugin is re-pointed at the install path, so it must not count).
 */
function treeActionFor(dest, asset, skip = []) {
  if (!dest || !isDir(dest)) return 'create'
  if (!asset?.files?.length) return 'update'
  const skipSet = new Set((skip ?? []).map((r) => posix(String(r))))
  const files = treeDigest(dest, { ignore: true }).files.filter((f) => !skipSet.has(f.rel))
  const digest = sha256(files.map((f) => `${f.rel}\u0000${f.sha256}`).join('\n'))
  return digest === assetDigest(asset, skip) ? 'noop' : 'update'
}

function pkgPlan(st, name, spec, { addBundle = true } = {}) {
  const pkg = readJson(st.packageJson, null) ?? {}
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.map(String) : []
  const needsDep = pkg?.dependencies?.[name] !== spec
  const needsBundle = addBundle && !bundles.includes(name)
  const action = !exists(st.packageJson) ? 'create' : needsDep || needsBundle ? 'update' : 'noop'
  const detail = [needsDep ? `dependency ${name} -> ${spec}` : '', needsBundle ? 'dsh.profile.bundles +=' : ''].filter(Boolean).join('; ') || 'up to date'
  return { path: st.packageJson, action, detail }
}

function pluginRowRows(asset, ctx) {
  const rows = Array.isArray(asset.meta?.config) ? asset.meta.config : []
  return ctx.tpl.expandValue(rows).map((r) => ({ ...r, insert: Boolean(r.inInsert) }))
}

function bundlePatchExpected(asset, ctx, installedDir) {
  const bp = asset.meta?.bundlePatch
  if (!bp?.text) return null
  const sourceRoot = ctx.tpl.expandValue(bp.sourceRoot ?? '')
  let text = ctx.tpl.expandValue(bp.text)
  // `link:` installs are symlinks into the source tree: when the installed dir
  // already resolves to the package source root no rewrite is needed.
  if (sourceRoot) {
    const real = (p) => {
      try {
        return fs.realpathSync(p)
      } catch {
        return p
      }
    }
    if (normWin(real(installedDir)) !== normWin(real(sourceRoot))) text = replacePathPrefix(text, sourceRoot, posix(installedDir))
  }
  return { rel: bp.rel, text }
}

/** Deep-normalize `\` to `/` for comparisons: YAML round-trips rewrite Windows separators. */
function slashNorm(value) {
  if (typeof value === 'string') return value.replace(/\\/g, '/')
  if (Array.isArray(value)) return value.map(slashNorm)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = slashNorm(v)
    return out
  }
  return value
}

/** Do the image's user rows already exist verbatim (semantically) in the patch file? */
function patchRowAction(file, rows) {
  if (!rows.length) return 'noop'
  const doc = parsePatchFile(file)
  if (!doc.ok) return 'update'
  const current = patchRows(doc.value)
  const sig = (r) => JSON.stringify(slashNorm([r?.name ?? null, r?.config ?? null, r?.disabled ?? null, r?.inject ?? null]))
  for (const row of rows) {
    const found = current.find((r) => (row.id && r.id === row.id) || (row.config?.serverName && r.config?.serverName === row.config.serverName))
    if (!found || sig(found) !== sig(row)) return 'update'
  }
  return 'noop'
}

function replacePathPrefix(text, from, to) {
  if (!from || !to) return text
  const variants = new Set([posix(from), String(from).replace(/\\/g, '/'), String(from)])
  let out = text
  for (const v of variants) {
    if (!v) continue
    const re = new RegExp(escapeRe(v).replace(/\//g, '[\\\\/]'), 'gi')
    out = out.replace(re, posix(to))
  }
  return out
}

/** Text comparison that ignores `\` vs `/`: Windows paths survive template round-trips with different separators. */
function textActionLoose(file, text) {
  if (!exists(file)) return 'create'
  const norm = (s) => String(s ?? '').replace(/\\/g, '/')
  return norm(readText(file, '')) === norm(text) ? 'noop' : 'update'
}

/**
 * Files that a full-vendor apply intentionally rewrites in place: the bundle
 * patch is re-pointed from the image's source paths at the install path, so it
 * must be excluded from payload/installed-tree digest comparisons.
 */
function rewrittenRels(asset) {
  const rel = asset?.meta?.bundlePatch?.rel
  return rel ? [posix(String(rel))] : []
}

function pluginWantsBundle(asset, name) {
  return Array.isArray(asset.meta?.bundles) && asset.meta.bundles.map(String).includes(name)
}

function planPlugin(asset, ctx, st) {
  if (!st.ok) return { asset, action: 'missing-host', targets: [], reason: `no DSH profile at ${st.profileDir || '(unresolved DSH home)'}` }
  const name = asset.meta?.packageName ?? asset.id
  const vendor = asset.meta?.vendor ?? 'manifest'
  const wantBundle = pluginWantsBundle(asset, name)
  const rows = pluginRowRows(asset, ctx)
  // Rows are compared semantically: a differently formatted but identical row
  // is not an update (patch files are hand-edited and reformatted over time).
  const patchTarget = schemaTarget(st.patchFile, patchRowAction(st.patchFile, rows), rows.length ? 'plugin override rows' : '')
  const targets = []
  if (vendor === 'full') {
    const vendorDir = path.join(st.profileDir, VENDOR_DIR, ...name.split('/'))
    const installedDir = path.join(st.nodeModules, ...name.split('/'))
    targets.push(schemaTarget(vendorDir, treeActionFor(vendorDir, asset), 'vendored package payload'))
    targets.push(schemaTarget(installedDir, treeActionFor(installedDir, asset, rewrittenRels(asset)), 'profile node_modules'))
    targets.push(pkgPlan(st, name, `file:${VENDOR_DIR}/${name}`, { addBundle: wantBundle }))
    const expected = bundlePatchExpected(asset, ctx, installedDir)
    if (expected) {
      const target = path.join(installedDir, ...expected.rel.split('/'))
      targets.push(schemaTarget(target, textActionLoose(target, expected.text), 'rewrite bundle patch to installed paths'))
    }
    if (rows.length) targets.push(patchTarget)
    const warnings = Array.isArray(asset.meta?.warnings) ? asset.meta.warnings : []
    return { asset, action: aggAction(targets), targets, warnings: warnings.length ? warnings : undefined }
  }

  // Registry packages: the only sanctioned install path is the DSH CLI
  // (`dsh plugin --profile <p> add <pkg>`), which forwards to pnpm inside the
  // profile dir. Plan is honest about that: no files are written by us.
  // Bundle membership is only enforced when the image recorded it: a plugin can
  // legitimately be installed as a plain library and not enabled as a bundle.
  const installedDir = path.join(st.nodeModules, ...name.split('/'))
  const pkg = readJson(st.packageJson, null) ?? {}
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.map(String) : []
  const depSpec = ctx.tpl.expandValue(asset.meta?.depSpec ?? '')
  const needsExec = !isDir(installedDir) || !depSpec || pkg?.dependencies?.[name] !== depSpec || (wantBundle && !bundles.includes(name))
  const spec = asset.meta?.installedVersion ? `${name}@${asset.meta.installedVersion}` : name
  if (!needsExec) {
    if (rows.length) targets.push(patchTarget)
    return { asset, action: aggAction(targets), targets }
  }
  const dsh = findDsh(ctx)
  const pkgTarget = schemaTarget(st.packageJson, isDir(installedDir) ? 'update' : 'create', `dsh plugin --profile ${st.profileName} add ${spec}`)
  if (!dsh.found) {
    return {
      asset,
      action: 'missing-prereq',
      needs: ['dsh'],
      reason:
        'registry plugins install through the DSH CLI (`dsh plugin --profile <p> add <pkg>`); no dsh executable found on PATH — set DSH_CLI to its path',
      targets: [pkgTarget, ...(rows.length ? [patchTarget] : [])],
    }
  }
  targets.push(pkgTarget)
  if (rows.length) targets.push(patchTarget)
  return { asset, action: aggAction(targets), targets }
}

function plan(assetRaw, ctxRaw) {
  const { ctx } = normCtx(ctxRaw)
  const asset = assetRaw ?? {}
  const kind = asset.kind
  const st = profileState(ctx)
  const targets = []
  try {
    if (kind === 'memory') {
      return {
        asset,
        action: 'missing-host',
        targets: [],
        reason: 'DSH has no native memory file: memory is stored in host-managed sessions/storages and cannot be imported',
      }
    }
    if (kind === 'tool') return { asset, action: 'skip', targets: [], reason: 'DSH discovers MCP tools at runtime (mcp__<server>__<tool>); nothing to install' }
    if (kind === 'plugin') return planPlugin(asset, ctx, st)
    if (!st.dshHome || !isDir(st.dshHome)) return { asset, action: 'missing-host', targets: [], reason: `no DSH home at ${st.dshHome || '(unresolved)'}` }
    if (kind === 'skill') {
      const dest = path.join(st.skillsDir, String(asset.meta?.dirName ?? asset.id))
      targets.push(schemaTarget(dest, treeActionFor(dest, asset), 'skill directory'))
      return { asset, action: aggAction(targets), targets }
    }
    if (kind === 'mcp') return planMcp(asset, ctx, st)
    return { asset, action: 'skip', targets: [], reason: 'unsupported kind' }
  } catch (err) {
    return { asset, action: 'error', targets, reason: `${err?.message ?? err}` }
  }
}

function mcpFragments(asset, ctx) {
  const meta = asset.meta ?? {}
  const entry = ctx.tpl.expandValue(meta.entry ?? {})
  const serverName = meta.serverName ?? asset.id
  const file = ctx.tpl.expandValue(meta.configFile ?? '')
  if (!file) throw new Error(`${asset.id}: mcp asset has no meta.configFile`)
  if (String(file).toLowerCase().endsWith('.json')) return { file, json: { mcpServers: { [serverName]: entry } } }
  const row = { id: meta.patchId ?? `${serverName}-mcp`, name: MCP_CLIENT, config: entry, insert: true }
  const current = readText(file, '')
  return { file, text: upsertPatchRow(current, row, { insert: true }), row }
}

function planMcp(asset, ctx, st) {
  const frag = mcpFragments(asset, ctx)
  const action = frag.json ? jsonAction(frag.file, frag.json) : frag.row ? patchRowAction(frag.file, [frag.row]) : 'update'
  return { asset, action, targets: [schemaTarget(frag.file, action, `MCP server ${asset.meta?.serverName ?? asset.id}`)] }
}

// ---------------------------------------------------------------- apply side

function writePatchRow(tx, ctx, file, text) {
  const opts = { onConflict: ctx.options?.onConflict ?? 'overwrite', dryRun: Boolean(ctx.options?.dryRun ?? tx.dryRun) }
  return applyWriteText(tx, file, text, opts)
}

function applyPlugin(asset, ctx, st, tx, targets, commands, warnings) {
  const name = asset.meta?.packageName ?? asset.id
  const vendor = asset.meta?.vendor ?? 'manifest'
  const wantBundle = pluginWantsBundle(asset, name)
  const rows = pluginRowRows(asset, ctx)
  const patchNow = () => patchRowsWith(profilePatchText(st), rows, { insert: false })

  if (vendor !== 'full') {
    const dsh = findDsh(ctx)
    const spec = asset.meta?.installedVersion ? `${name}@${asset.meta.installedVersion}` : name
    if (!dsh.found) return { asset, action: 'missing-prereq', targets, commands, error: 'DSH CLI not found (set DSH_CLI); cannot install a registry plugin' }
    const res = tx.exec(`${quoteCmd(dsh.command)} plugin --profile ${st.profileName} add ${quoteCmd(spec)}`, [], { cwd: st.profileDir, timeout: 600000 })
    commands.push({ command: res.command, status: res.status ?? null, skipped: Boolean(res.skipped) })
    if (!res.skipped && (res.status !== 0 || res.error)) {
      return { asset, action: 'error', targets, commands, error: `dsh plugin add failed (status ${res.status}): ${res.stderr || res.error || 'unknown error'}` }
    }
    // The CLI owns the install; bundle membership is a profile declaration, so
    // record it ourselves when the image says this package was enabled.
    if (wantBundle && !res.skipped) {
      const pkgNow = readJson(st.packageJson, null) ?? {}
      const bundlesNow = Array.isArray(pkgNow?.dsh?.profile?.bundles) ? pkgNow.dsh.profile.bundles.map(String) : []
      if (!bundlesNow.includes(name)) {
        const onConflict = ctx.options?.onConflict ?? 'overwrite'
        const dryRun = Boolean(ctx.options?.dryRun ?? tx.dryRun)
        const r = applyMergeJson(tx, st.packageJson, { dsh: { profile: { bundles: [...bundlesNow, name] } } }, { onConflict, dryRun })
        targets.push(schemaTarget(st.packageJson, r.action, `dsh.profile.bundles += ${name}`))
      }
    }
    if (rows.length) {
      if (patchRowAction(st.patchFile, rows) === 'noop') targets.push(schemaTarget(st.patchFile, 'noop', 'plugin override rows'))
      else if (!res.skipped) {
        const r = writePatchRow(tx, ctx, st.patchFile, patchNow())
        targets.push(schemaTarget(st.patchFile, r.action, 'plugin override rows'))
      }
    }
    return { asset, action: res.skipped ? aggAction(targets) : 'update', targets, commands, warnings }
  }

  const dir = payloadDir(asset)
  if (!dir) return { asset, action: 'error', targets, commands, error: 'missing payload directory for full vendor import' }
  const vendorDir = path.join(st.profileDir, VENDOR_DIR, ...name.split('/'))
  const installedDir = path.join(st.nodeModules, ...name.split('/'))
  const onConflict = ctx.options?.onConflict ?? 'overwrite'
  const dryRun = Boolean(ctx.options?.dryRun ?? tx.dryRun)

  const vendorCopy = applyCopyTree(tx, vendorDir, dir, { onConflict, dryRun })
  targets.push(schemaTarget(vendorDir, vendorCopy.action))
  if (vendorCopy.action === 'skip') return { asset, action: 'skip', targets, commands, warnings, error: undefined }

  const installedCopy = applyCopyTree(tx, installedDir, dir, { onConflict, dryRun })
  targets.push(schemaTarget(installedDir, installedCopy.action))
  if (installedCopy.action === 'skip') return { asset, action: 'skip', targets, commands, warnings }

  const expected = bundlePatchExpected(asset, ctx, installedDir)
  if (expected) {
    const target = path.join(installedDir, ...expected.rel.split('/'))
    if (textActionLoose(target, expected.text) === 'noop') {
      targets.push(schemaTarget(target, 'noop', 'bundle patch already points at this install'))
    } else {
      const written = writePatchRow(tx, ctx, target, expected.text)
      targets.push(schemaTarget(target, written.action, 'rewritten bundle patch'))
    }
  }

  const depSpec = `file:${VENDOR_DIR}/${name}`
  const pkgRead = readJson(st.packageJson, null) ?? {}
  const bundles = Array.isArray(pkgRead?.dsh?.profile?.bundles) ? pkgRead.dsh.profile.bundles.map(String) : []
  const nextBundles = wantBundle && !bundles.includes(name) ? [...bundles, name] : bundles
  const pkgRes = applyMergeJson(
    tx,
    st.packageJson,
    { dependencies: { [name]: depSpec }, dsh: { profile: { bundles: nextBundles } } },
    { onConflict, dryRun },
  )
  targets.push(schemaTarget(st.packageJson, pkgRes.action, `dependency + dsh.profile.bundles (${name})`))

  if (rows.length) {
    if (patchRowAction(st.patchFile, rows) === 'noop') targets.push(schemaTarget(st.patchFile, 'noop', 'plugin override rows'))
    else {
      const r = writePatchRow(tx, ctx, st.patchFile, patchNow())
      targets.push(schemaTarget(st.patchFile, r.action, 'plugin override rows'))
    }
  }
  return { asset, action: aggAction(targets) === 'noop' ? 'noop' : 'update', targets, commands, warnings }
}

function applySkill(asset, ctx, st, tx, targets) {
  const dir = payloadDir(asset)
  if (!dir) return { asset, action: 'error', targets, error: 'missing payload directory' }
  const dest = path.join(st.skillsDir, String(asset.meta?.dirName ?? asset.id))
  const res = applyCopyTree(tx, dest, dir, { onConflict: ctx.options?.onConflict ?? 'overwrite', dryRun: Boolean(ctx.options?.dryRun ?? tx.dryRun) })
  targets.push(schemaTarget(dest, res.action))
  return { asset, action: res.action, targets }
}

function applyMcp(asset, ctx, st, tx, targets) {
  const frag = mcpFragments(asset, ctx)
  const onConflict = ctx.options?.onConflict ?? 'overwrite'
  const dryRun = Boolean(ctx.options?.dryRun ?? tx.dryRun)
  let res
  if (frag.json) res = applyMergeJson(tx, frag.file, frag.json, { onConflict, dryRun })
  else if (frag.row && patchRowAction(frag.file, [frag.row]) === 'noop') res = { action: 'noop' }
  else res = applyWriteText(tx, frag.file, frag.text, { onConflict, dryRun })
  targets.push(schemaTarget(frag.file, res.action, `MCP server ${asset.meta?.serverName ?? asset.id}`))
  return { asset, action: res.action === 'skip' ? 'skip' : res.action, targets }
}

function apply(assetRaw, ctxRaw, tx) {
  const { ctx } = normCtx(ctxRaw)
  const asset = assetRaw ?? {}
  const st = profileState(ctx)
  const targets = []
  const commands = []
  const warnings = Array.isArray(asset.meta?.warnings) ? [...asset.meta.warnings] : []
  try {
    if (asset.kind === 'memory') {
      return { asset, action: 'skip', targets, reason: 'DSH has no native memory file; nothing was written' }
    }
    if (asset.kind === 'tool') return { asset, action: 'skip', targets, reason: 'no static tool snapshot on DSH' }
    if (asset.kind === 'plugin') {
      if (!st.ok) return { asset, action: 'missing-host', targets, error: `no DSH profile at ${st.profileDir || '(unresolved)'}` }
      return applyPlugin(asset, ctx, st, tx, targets, commands, warnings)
    }
    if (!st.dshHome || !isDir(st.dshHome)) return { asset, action: 'missing-host', targets, error: `no DSH home at ${st.dshHome || '(unresolved)'}` }
    if (asset.kind === 'skill') return applySkill(asset, ctx, st, tx, targets)
    if (asset.kind === 'mcp') return applyMcp(asset, ctx, st, tx, targets)
    return { asset, action: 'skip', targets, reason: 'unsupported kind' }
  } catch (err) {
    return { asset, action: 'error', targets, commands, warnings, error: `${err?.message ?? err}` }
  }
}

// ------------------------------------------------------------------- verify

function verify(assetRaw, ctxRaw) {
  const { ctx } = normCtx(ctxRaw)
  const asset = assetRaw ?? {}
  const st = profileState(ctx)
  const problems = []
  const targets = []
  let checked = 0
  try {
    if (asset.kind === 'plugin') {
      if (!st.ok) return { ok: false, checked: 0, problems: [`no DSH profile at ${st.profileDir}`], targets }
      const name = asset.meta?.packageName ?? asset.id
      const installedDir = path.join(st.nodeModules, ...name.split('/'))
      checked++
      if (!isDir(installedDir)) problems.push(`plugin ${name}: not installed at ${installedDir}`)
      else if (treeActionFor(installedDir, asset, rewrittenRels(asset)) !== 'noop') problems.push(`plugin ${name}: installed tree differs from image payload`)
      const pkg = readJson(st.packageJson, null) ?? {}
      checked++
      const vendor = asset.meta?.vendor ?? 'manifest'
      const expectedSpec = vendor === 'full' ? `file:${VENDOR_DIR}/${name}` : undefined
      if (expectedSpec && pkg?.dependencies?.[name] !== expectedSpec) problems.push(`plugin ${name}: package.json dependency is ${pkg?.dependencies?.[name] ?? 'missing'} (expected ${expectedSpec})`)
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles.map(String) : []
      checked++
      // Only enforce bundle membership when the image recorded the package as an
      // enabled bundle; a plain library dependency is legitimately not a bundle.
      if (pluginWantsBundle(asset, name) && !bundles.includes(name)) problems.push(`plugin ${name}: missing from dsh.profile.bundles`)
      const doc = parsePatchFile(st.patchFile)
      const rows = Array.isArray(asset.meta?.config) ? asset.meta.config : []
      checked += rows.length
      for (const row of rows) {
        const present = doc.ok && patchRows(doc.value).some((r) => r.id === row.id)
        if (!present) problems.push(`plugin ${name}: patch row "${row.id}" is missing from ${PATCH_FILE}`)
      }
      targets.push(installedDir)
    } else if (asset.kind === 'skill') {
      const dest = st.skillsDir ? path.join(st.skillsDir, String(asset.meta?.dirName ?? asset.id)) : ''
      checked++
      if (!dest || !isDir(dest)) problems.push(`skill ${asset.id}: not installed at ${dest || '(unresolved)'}`)
      else if (treeActionFor(dest, asset) !== 'noop') problems.push(`skill ${asset.id}: installed tree differs from image payload`)
      else if (!exists(path.join(dest, SKILL_FILE))) problems.push(`skill ${asset.id}: ${SKILL_FILE} missing`)
      targets.push(dest)
    } else if (asset.kind === 'mcp') {
      const frag = mcpFragments(asset, ctx)
      checked++
      if (!exists(frag.file)) problems.push(`mcp ${asset.id}: config file missing (${frag.file})`)
      else if (frag.json) {
        const current = readJson(frag.file, {}) ?? {}
        if (!current?.mcpServers?.[asset.meta?.serverName ?? asset.id]) problems.push(`mcp ${asset.id}: not present in ${frag.file}`)
      } else {
        const doc = parsePatchFile(frag.file)
        const present = doc.ok && patchRows(doc.value).some((r) => r.name === MCP_CLIENT && r.config?.serverName === (asset.meta?.serverName ?? asset.id))
        if (!present) problems.push(`mcp ${asset.id}: mcp-client row missing from ${frag.file}`)
      }
      targets.push(frag.file)
    } else if (asset.kind === 'memory') {
      return { ok: false, checked: 0, problems: ['DSH has no native memory file; memory assets cannot be verified'], targets }
    } else {
      return { ok: true, checked: 0, problems: [], targets }
    }
    return { ok: problems.length === 0, checked, problems, targets }
  } catch (err) {
    return { ok: false, checked, problems: [...problems, `${err?.message ?? err}`], targets }
  }
}

// ------------------------------------------------------------------- detect

function detect(ctxRaw) {
  const { ctx } = normCtx(ctxRaw)
  const st = profileState(ctx)
  const paths = {
    dshHome: st.dshHome || '(unresolved)',
    profile: st.profileDir || '(unresolved)',
    skills: st.skillsDir || '(unresolved)',
    packages: st.nodeModules || '(unresolved)',
  }
  if (!st.dshHome || !isDir(st.dshHome)) return { host: HOST, available: false, reason: `no DSH home at ${st.dshHome || '(unresolved)'}`, paths }
  if (!st.ok) return { host: HOST, available: false, reason: `DSH home found but profile "${st.profileName}" has no package.json`, paths }

  const warnings = []
  const patchDoc = parsePatchFile(st.patchFile)
  if (!patchDoc.ok) warnings.push(`could not parse ${PATCH_FILE}: ${patchDoc.error}`)
  const userMcp = patchDoc.ok ? patchRows(patchDoc.value).filter((r) => r.name === MCP_CLIENT && r.config?.serverName) : []
  const bundled = bundledMcp(ctx, st, () => {})
  const skills = st.skillsDir ? listDirs(st.skillsDir).filter((d) => exists(path.join(d, SKILL_FILE))) : []
  return {
    host: HOST,
    available: true,
    profile: st.profileName,
    version: st.pkg?.version ? String(st.pkg.version) : undefined,
    paths,
    counts: {
      plugins: Object.keys(st.deps).length,
      bundles: st.bundles.length,
      skills: skills.length,
      mcp: userMcp.length + bundled.length,
      mcpUserLevel: userMcp.length,
      mcpBundled: bundled.length,
      tool: 0,
      memory: 0,
    },
    notes: [
      `${bundled.length} MCP server(s) are provided by enabled bundles: ${bundled.map((b) => b.serverName).join(', ') || 'none'}`,
      'DSH has no native memory file',
    ],
    warnings: warnings.length ? warnings : undefined,
  }
}

export default { name: HOST, detect, scan, plan, apply, verify }
