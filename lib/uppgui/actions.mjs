/**
 * uppgui — action catalog.
 *
 * ONE table feeds three surfaces: the browser UI (POST /api/action), the CLI
 * (`uppgui action <id>`), and the MCP bridge (`upp_action`). Keeping it single
 * is what makes the agent surface cheap: two MCP tools, terse catalog, brief
 * responses by default.
 *
 * Contract: lib/uppgui/CONTRACT.md
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import * as mem from '../uppmem/core.mjs'
import * as tool from '../upptool/core.mjs'
import { detectRoots, sha256File } from '../uppenv/core/util.mjs'
import { readSignature, resolveSigningKey } from '../uppenv/core/sign.mjs'
import { createContext as memContext, detectMemoryHosts } from '../uppmem/hosts/index.mjs'

export const TOOL = { name: 'uppgui', version: '1.5.3' }

export const GROUPS = [
  { id: 'overview', title: '概览' },
  { id: 'memory', title: '记忆' },
  { id: 'tools', title: '工具' },
  { id: 'env', title: '环境镜像' },
  { id: 'migrate', title: '换机' },
  { id: 'plugin', title: '插件' },
]

export class ToolError extends Error {
  constructor(message, { hint } = {}) {
    super(message)
    this.name = 'ToolError'
    this.hint = hint
  }
}

const BRIEF_MAX_ITEMS = 10
const BRIEF_MAX_STRING = 200
const BRIEF_MAX_DEPTH = 6

/** Context handed to every action: roots, a CLI spawner, and the log fan-out. */
export function createContext({ payloadDir, mode = 'dev', env = process.env, log = () => {}, version = TOOL.version } = {}) {
  const roots = detectRoots(env)
  const ctx = {
    payloadDir,
    mode,
    env,
    version,
    roots,
    log,
    /** Spawn one of the repo CLIs and capture its JSON (when it emits JSON). */
    run(toolName, args = [], opts = {}) {
      const script = path.join(payloadDir, 'tools', `${toolName}.mjs`)
      const useCli = mode === 'sea'
      const argv = useCli ? ['--cli', toolName, ...args] : [script, ...args]
      const started = Date.now()
      const res = spawnSync(process.execPath, argv, {
        cwd: opts.cwd ?? payloadDir,
        env: { ...env, ...(opts.env ?? {}) },
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 180000,
        windowsHide: true,
        input: opts.input ?? undefined,
        maxBuffer: 16 * 1024 * 1024,
      })
      const stdout = res.stdout ?? ''
      const stderr = res.stderr ?? ''
      let json = null
      const text = stdout.trim()
      if (text.startsWith('{') || text.startsWith('[')) {
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
      }
      return { code: res.status ?? (res.error ? 1 : 0), stdout, stderr, json, tookMs: Date.now() - started, error: res.error ? String(res.error.message) : null }
    },
  }
  return ctx
}

// ------------------------------------------------------------------ helpers

function hasCode(ctx, toolName) {
  return fs.existsSync(path.join(ctx.payloadDir, 'tools', `${toolName}.mjs`))
}

/** Parse the JSON `upp`/`uppver` CLIs print, or summarize plain text. */
function cliData(res, { keep = 2000 } = {}) {
  if (res.json) return { code: res.code, data: res.json }
  const text = `${res.stdout ?? ''}${res.stderr ? `\n${res.stderr}` : ''}`.trim()
  return { code: res.code, data: text.slice(0, keep), truncated: text.length > keep }
}

function entrySlim(e) {
  return {
    id: e.id,
    kind: e.kind,
    key: e.key ?? null,
    tags: e.tags ?? [],
    text: e.text,
    updatedAt: e.updatedAt,
    scope: e.scope ?? 'global',
  }
}

function toolSlim(t) {
  return {
    id: t.id,
    name: t.name,
    runtime: t.runtime,
    kind: t.kind,
    runs: t.runs ?? 0,
    savedTokens: t.savedTokens ?? t.savedTotal ?? 0,
    description: t.desc ?? t.description ?? null,
    tags: t.tags ?? [],
    lastRunAt: t.lastRunAt ?? null,
  }
}

function res(cli) {
  return { ok: cli.code === 0, code: cli.code, stdout: cli.stdout ?? '', stderr: cli.stderr ?? '', json: cli.json ?? null, tookMs: cli.tookMs }
}

// ------------------------------------------------------------------ catalog

export const ACTIONS = {
  // ---------------------------------------------------------------- overview
  status: {
    group: 'overview',
    title: '系统状态',
    summary: '工具链版本、三端可用性、记忆池与工具库规模（不发网络请求）',
    danger: false,
    args: {},
    async run(ctx) {
      const memHome = mem.root(ctx.env)
      const toolHome = tool.root(ctx.env)
      const mstat = mem.stats(memHome)
      const tstat = tool.stats(toolHome)
      const versions = {}
      for (const name of ['upp', 'uppenv', 'upptool', 'uppmem']) {
        if (!hasCode(ctx, name)) continue
        const out = ctx.run(name, ['version'], { timeoutMs: 20000 })
        if (out.json) versions[name] = out.json.toolchain ?? out.json.version ?? out.json.name ?? null
        else versions[name] = String(out.stdout ?? '').split('\n')[0].trim() || null
      }
      const hosts = await detectMemoryHosts(memContext({ roots: ctx.roots, env: ctx.env }))
      return {
        app: 'uppgui',
        version: ctx.version,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        toolchain: versions,
        memory: { home: memHome, entries: mstat.entries ?? mstat.count ?? 0, kinds: mstat.byKind ?? mstat.kinds ?? null },
        tools: { home: toolHome, count: tstat.tools ?? 0, runs: tstat.runs ?? 0, savedTokens: tstat.savedTokens ?? 0 },
        hosts: hosts.map((h) => ({
          host: h.host,
          available: Boolean(h.available ?? h.installed),
          installed: Boolean(h.installed),
          mcpRegistered: Boolean(h.paths?.mcpRegistered),
          detail: h.detail ?? h.reason ?? h.memoryFile ?? h.file ?? null,
        })),
      }
    },
  },

  doctor: {
    group: 'overview',
    title: '自检',
    summary: '运行 upp doctor（含宿主 MCP 连通性探测，较慢）',
    danger: false,
    brief: false, // a health gate must show every row, never a truncated slice
    args: { timeoutMs: { type: 'number', default: 120000, desc: '超时毫秒' } },
    async run(ctx, p) {
      const out = ctx.run('upp', ['doctor'], { timeoutMs: p.timeoutMs })
      const checks = Array.isArray(out.json?.checks) ? out.json.checks : []
      return {
        code: out.code,
        failed: checks.filter((c) => !c.ok).length,
        passed: checks.filter((c) => c.ok).length,
        checks: checks.map((c) => ({ check: c.check, ok: Boolean(c.ok), detail: String(c.detail ?? '') })),
        stdout: checks.length ? undefined : (out.stdout ?? '').slice(0, 4000),
      }
    },
  },

  // ------------------------------------------------------------------ memory
  'mem.list': {
    group: 'memory',
    title: '记忆列表',
    summary: '列出共享记忆池条目（按更新时间倒序）',
    danger: false,
    args: {
      kind: { type: 'string', desc: `筛选类型 ${mem.KINDS.join('|')}` },
      tag: { type: 'string', desc: '按 tag 过滤' },
      limit: { type: 'number', default: 50, desc: '最多返回条数' },
    },
    async run(ctx, p) {
      const home = mem.root(ctx.env)
      const rows = mem.listEntries(home, { kind: p.kind, tag: p.tag, limit: p.limit })
      return { home, total: mem.loadEntries(home).length, count: rows.length, entries: rows.map(entrySlim) }
    },
  },

  'mem.search': {
    group: 'memory',
    title: '搜索记忆',
    summary: '按关键词检索记忆池（文本/key/tag 加权）',
    danger: false,
    args: {
      query: { type: 'string', required: true, desc: '关键词' },
      kind: { type: 'string', desc: '限定类型' },
      limit: { type: 'number', default: 10, desc: '最多返回条数' },
    },
    async run(ctx, p) {
      const home = mem.root(ctx.env)
      const rows = mem.searchEntries(home, p.query, { kind: p.kind, limit: p.limit })
      return { home, query: p.query, count: rows.length, entries: rows.map((e) => ({ ...entrySlim(e), score: e.score })) }
    },
  },

  'mem.get': {
    group: 'memory',
    title: '读取记忆',
    summary: '按 id / key / 前缀读取单条记忆',
    danger: false,
    args: { ref: { type: 'string', required: true, desc: 'id / key / 前缀' } },
    async run(ctx, p) {
      const home = mem.root(ctx.env)
      return { home, entry: entrySlim(mem.resolveEntry(home, p.ref)) }
    },
  },

  'mem.add': {
    group: 'memory',
    title: '新增记忆',
    summary: '写入一条共享记忆（同 key 自动覆盖，LWW）',
    danger: false,
    args: {
      text: { type: 'string', required: true, desc: '记忆正文' },
      kind: { type: 'string', default: 'fact', desc: `类型 ${mem.KINDS.join('|')}` },
      key: { type: 'string', desc: '稳定键名（如 user.language）' },
      tags: { type: 'array', desc: '标签数组或逗号分隔' },
      scope: { type: 'string', default: 'global', desc: '作用域' },
    },
    async run(ctx, p) {
      const home = mem.root(ctx.env)
      const out = mem.addEntry(home, { text: p.text, kind: p.kind, key: p.key, tags: p.tags, scope: p.scope, source: 'uppgui' })
      mem.rebuildIndex(home)
      return { home, created: out.created, updated: !out.created, entry: entrySlim(out.entry) }
    },
  },

  'mem.update': {
    group: 'memory',
    title: '更新记忆',
    summary: '修改正文 / 类型 / 标签（保留原 id）',
    danger: false,
    args: {
      ref: { type: 'string', required: true, desc: 'id / key / 前缀' },
      text: { type: 'string', desc: '新正文' },
      kind: { type: 'string', desc: '新类型' },
      tags: { type: 'array', desc: '新标签' },
    },
    async run(ctx, p) {
      const home = mem.root(ctx.env)
      const entry = mem.resolveEntry(home, p.ref)
      const next = { ...entry, updatedAt: mem.now() }
      if (p.text != null && p.text !== '') {
        next.text = mem.canonicalText(p.text)
        next.hash = mem.hashText(next.text)
      }
      if (p.kind) {
        if (!mem.KINDS.includes(p.kind)) throw new ToolError(`unknown kind: ${p.kind}`, { hint: mem.KINDS.join('|') })
        next.kind = p.kind
      }
      if (p.tags) next.tags = Array.isArray(p.tags) ? p.tags : String(p.tags).split(',')
      mem.writeEntry(home, next)
      mem.rebuildIndex(home)
      return { home, entry: entrySlim(next) }
    },
  },

  'mem.rm': {
    group: 'memory',
    title: '删除记忆',
    summary: '按 id / key / 前缀删除一条记忆',
    danger: true,
    args: { ref: { type: 'string', required: true, desc: 'id / key / 前缀' } },
    async run(ctx, p) {
      const home = mem.root(ctx.env)
      const out = mem.removeEntry(home, p.ref)
      mem.rebuildIndex(home)
      return { home, removed: out.removed, entry: entrySlim(out.entry) }
    },
  },

  'mem.stats': {
    group: 'memory',
    title: '记忆统计',
    summary: '条目数、类型分布、池健康检查',
    danger: false,
    args: {},
    async run(ctx) {
      const home = mem.root(ctx.env)
      return { home, stats: mem.stats(home), doctor: mem.doctor(home) }
    },
  },

  'mem.sync': {
    group: 'memory',
    title: '同步三端',
    summary: '把池同步到 DSH / WorkBuddy / Accio 的原生记忆文件（双向）',
    danger: true,
    args: {
      hosts: { type: 'array', default: ['dsh', 'workbuddy', 'accio'], desc: '目标宿主' },
      direction: { type: 'string', default: 'both', desc: 'both|push|pull' },
      dryRun: { type: 'boolean', default: false, desc: '只算不写' },
    },
    async run(ctx, p) {
      const dirFlag = p.direction === 'pull' ? '--pull' : p.direction === 'push' ? '--push' : '--both'
      const args = ['sync', '--host', p.hosts.join(','), dirFlag, '--json']
      if (p.dryRun) args.push('--dry-run')
      const out = ctx.run('uppmem', args)
      return res(out)
    },
  },

  'mem.install': {
    group: 'memory',
    title: '注册到宿主',
    summary: '写宿主配置：DSH 技能快照 / WorkBuddy 与 Accio 的 MCP server',
    danger: true,
    args: {
      hosts: { type: 'array', default: ['dsh', 'workbuddy', 'accio'], desc: '目标宿主' },
      remove: { type: 'boolean', default: false, desc: '反注册' },
      dryRun: { type: 'boolean', default: false, desc: '只算不写' },
    },
    async run(ctx, p) {
      const args = ['install', '--host', p.hosts.join(','), '--json']
      if (p.remove) args.push('--remove')
      if (p.dryRun) args.push('--dry-run')
      const out = ctx.run('uppmem', args)
      return res(out)
    },
  },

  'mem.hosts': {
    group: 'memory',
    title: '宿主状态',
    summary: '三个宿主是否可写、是否已注册 MCP、原生记忆文件位置',
    danger: false,
    args: {},
    async run(ctx) {
      const rows = []
      for (const h of await detectMemoryHosts(memContext({ roots: ctx.roots, env: ctx.env }))) {
        rows.push({
          host: h.host,
          available: Boolean(h.available ?? h.installed),
          installed: Boolean(h.installed),
          entries: h.entries ?? h.count ?? null,
          mcpRegistered: Boolean(h.paths?.mcpRegistered),
          memoryFile: h.memoryFile ?? h.file ?? h.paths?.memoryFile ?? null,
          warnings: h.warnings ?? [],
        })
      }
      return { hosts: rows }
    },
  },

  // ------------------------------------------------------------------- tools
  'tool.list': {
    group: 'tools',
    title: '工具列表',
    summary: '已登记的可复用工具',
    danger: false,
    args: {
      tag: { type: 'string', desc: '按 tag 过滤' },
      kind: { type: 'string', desc: '按 kind 过滤' },
      q: { type: 'string', desc: '名称/描述子串' },
    },
    async run(ctx, p) {
      const home = tool.root(ctx.env)
      const rows = tool.listTools(home, { tag: p.tag, kind: p.kind, q: p.q })
      return { home, count: rows.length, tools: rows.map(toolSlim) }
    },
  },

  'tool.show': {
    group: 'tools',
    title: '工具详情',
    summary: '单个工具的元数据、文件与运行记录摘要',
    danger: false,
    args: { id: { type: 'string', required: true, desc: 'id 或名称/前缀' } },
    async run(ctx, p) {
      const home = tool.root(ctx.env)
      const rec = tool.resolveTool(home, p.id)
      return { home, tool: { ...toolSlim(rec), files: (rec.files ?? []).map((f) => ({ rel: f.rel ?? f.path, size: f.size })) } }
    },
  },

  'tool.suggest': {
    group: 'tools',
    title: '推荐工具',
    summary: '给一句话任务，找出已有的可复用工具（避免重新生成）',
    danger: false,
    args: {
      text: { type: 'string', required: true, desc: '任务描述' },
      limit: { type: 'number', default: 5, desc: '最多返回条数' },
    },
    async run(ctx, p) {
      const home = tool.root(ctx.env)
      const rows = tool.suggestTools(home, p.text, { limit: p.limit })
      return { home, query: p.text, count: rows.length, tools: rows.map((r) => ({ ...toolSlim(r.tool ?? r), score: r.score ?? null })) }
    },
  },

  'tool.run': {
    group: 'tools',
    title: '运行工具',
    summary: '本地直接执行已登记工具（不消耗模型 token）',
    danger: false,
    args: {
      id: { type: 'string', required: true, desc: 'id 或名称/前缀' },
      args: { type: 'array', desc: '传给工具的参数' },
      timeoutMs: { type: 'number', default: 120000, desc: '超时毫秒' },
      input: { type: 'string', desc: 'stdin 内容' },
      cwd: { type: 'string', desc: '工作目录' },
    },
    async run(ctx, p) {
      const home = tool.root(ctx.env)
      const started = Date.now()
      const out = tool.runTool(home, p.id, p.args ?? [], { timeoutMs: p.timeoutMs, input: p.input, cwd: p.cwd })
      return {
        id: out.tool?.id ?? p.id,
        ok: Boolean(out.ok),
        exitCode: out.code ?? null,
        tookMs: out.tookMs ?? Date.now() - started,
        stdout: String(out.stdout ?? '').slice(0, 8000),
        stderr: String(out.stderr ?? '').slice(0, 4000),
        savedTokens: out.savedTokens ?? null,
      }
    },
  },

  'tool.add': {
    group: 'tools',
    title: '登记工具',
    summary: '把一个脚本/命令登记成可复用工具（同内容自动判重）',
    danger: false,
    args: {
      path: { type: 'string', desc: '脚本或目录路径' },
      name: { type: 'string', desc: '工具名（默认取文件名）' },
      runtime: { type: 'string', desc: 'node|bash|python|exec|cmd' },
      kind: { type: 'string', desc: 'script|command|batch|pipeline' },
      command: { type: 'string', desc: 'runtime=exec/cmd 时直接给的命令' },
      tags: { type: 'array', desc: '标签' },
      description: { type: 'string', desc: '说明' },
    },
    async run(ctx, p) {
      const home = tool.root(ctx.env)
      const out = tool.addTool(home, {
        from: p.path,
        name: p.name,
        runtime: p.runtime,
        kind: p.kind,
        entry: p.entry,
        command: p.command,
        tags: p.tags,
        desc: p.description,
      })
      return { home, created: Boolean(out.created), duplicateOf: out.duplicateOf ?? null, tool: out.tool ? toolSlim(out.tool) : null }
    },
  },

  'tool.stats': {
    group: 'tools',
    title: '工具统计',
    summary: '工具数、运行次数、估算省下的 token',
    danger: false,
    args: {},
    async run(ctx) {
      const home = tool.root(ctx.env)
      return { home, stats: tool.stats(home), doctor: tool.doctor(home) }
    },
  },

  // --------------------------------------------------------------------- env
  'env.scan': {
    group: 'env',
    title: '扫描资产',
    summary: '列出三端可导出的插件 / 技能 / MCP / 工具 / 记忆',
    danger: false,
    brief: false, // the asset list IS the payload: a 10-row brief slice silently drops whole hosts from the table
    args: {
      hosts: { type: 'array', desc: '限定宿主' },
      kinds: { type: 'array', desc: '限定资产类型' },
    },
    async run(ctx, p) {
      const args = ['scan', '--json']
      if (p.hosts?.length) args.push('--host', p.hosts.join(','))
      if (p.kinds?.length) args.push('--kind', p.kinds.join(','))
      const out = ctx.run('uppenv', args)
      const all = Array.isArray(out.json) ? out.json : []
      const counts = {}
      for (const a of all) counts[`${a.host}/${a.kind}`] = (counts[`${a.host}/${a.kind}`] ?? 0) + 1
      return {
        code: out.code,
        total: all.length,
        counts,
        assets: all.map((a) => ({ kind: a.kind, host: a.host, id: a.id, strategy: a.strategy, files: (a.files ?? []).length })),
        stderr: out.code === 0 ? undefined : out.stderr.slice(0, 2000),
      }
    },
  },

  'env.export': {
    group: 'env',
    title: '导出镜像',
    summary: '把选中资产打包成 .uppenv 镜像（可签名）',
    danger: false,
    args: {
      out: { type: 'string', desc: '输出文件（默认 当前目录/uppenv-<ts>.uppenv）' },
      hosts: { type: 'array', desc: '限定宿主' },
      kinds: { type: 'array', desc: '限定类型' },
      sign: { type: 'boolean', default: false, desc: 'ed25519 签名' },
      force: { type: 'boolean', default: false, desc: '覆盖已存在文件' },
      probeTools: { type: 'boolean', default: true, desc: '探测 MCP 工具面' },
    },
    async run(ctx, p) {
      const out = p.out && p.out.trim() ? p.out : `uppenv-${new Date().toISOString().replace(/[:.]/g, '-')}.uppenv`
      const args = ['export', '-o', out, '--json']
      if (p.hosts?.length) args.push('--host', p.hosts.join(','))
      if (p.kinds?.length) args.push('--kind', p.kinds.join(','))
      if (p.sign) args.push('--sign')
      if (p.force) args.push('--force')
      if (p.probeTools === false) args.push('--no-probe-tools')
      const r = ctx.run('uppenv', args, { timeoutMs: 240000 })
      return { code: r.code, file: r.json?.file ?? out, stats: r.json?.stats ?? null, signature: r.json?.signature ?? null, stderr: r.code === 0 ? undefined : r.stderr.slice(0, 2000) }
    },
  },

  'env.import': {
    group: 'env',
    title: '导入镜像',
    summary: '把 .uppenv 装进本机三端（事务 + 可回滚）',
    danger: true,
    args: {
      file: { type: 'string', required: true, desc: '镜像文件路径' },
      dryRun: { type: 'boolean', default: false, desc: '只出计划，零写入' },
      requireSignature: { type: 'boolean', default: false, desc: '拒绝未签名/签名不符' },
      onConflict: { type: 'string', default: 'overwrite', desc: 'skip|overwrite|rename' },
      hosts: { type: 'array', desc: '限定宿主' },
      kinds: { type: 'array', desc: '限定类型' },
      yes: { type: 'boolean', default: true, desc: '跳过交互确认' },
    },
    async run(ctx, p) {
      const args = ['import', p.file, '--json', '--on-conflict', p.onConflict]
      if (p.dryRun) args.push('--dry-run')
      if (p.requireSignature) args.push('--require-signature')
      if (p.hosts?.length) args.push('--host', p.hosts.join(','))
      if (p.kinds?.length) args.push('--kind', p.kinds.join(','))
      if (p.yes) args.push('--yes')
      const r = ctx.run('uppenv', args, { timeoutMs: 240000 })
      return { code: r.code, dryRun: Boolean(p.dryRun), tx: r.json?.tx ?? null, actions: r.json?.actions ?? null, results: r.json?.results ?? null, stderr: r.code === 0 ? undefined : r.stderr.slice(0, 2000) }
    },
  },

  'env.verify': {
    group: 'env',
    title: '校验镜像',
    summary: '逐文件哈希 + 可选签名校验',
    danger: false,
    args: {
      file: { type: 'string', required: true, desc: '镜像文件路径' },
      requireSignature: { type: 'boolean', default: false, desc: '要求已签名' },
    },
    async run(ctx, p) {
      const args = ['verify', p.file, '--json']
      if (p.requireSignature) args.push('--require-signature')
      return res(ctx.run('uppenv', args))
    },
  },

  'env.inspect': {
    group: 'env',
    title: '查看镜像',
    summary: '镜像 manifest：资产清单、统计、签名',
    danger: false,
    args: { file: { type: 'string', required: true, desc: '镜像文件路径' } },
    async run(ctx, p) {
      const r = ctx.run('uppenv', ['inspect', p.file, '--json'])
      const info = r.json ?? {}
      return {
        code: r.code,
        file: info.file ?? p.file,
        size: info.size ?? null,
        stats: info.stats ?? null,
        signature: info.signature ?? null,
        assets: (info.manifest?.assets ?? []).map((a) => ({ kind: a.kind, host: a.host, id: a.id, files: (a.files ?? []).length })),
        stderr: r.code === 0 ? undefined : r.stderr.slice(0, 2000),
      }
    },
  },

  'env.rollback': {
    group: 'env',
    title: '回滚导入',
    summary: '撤销最近一次（或指定）导入事务',
    danger: true,
    args: { tx: { type: 'string', desc: '事务 id，默认最近一次' } },
    async run(ctx, p) {
      const args = p.tx ? ['rollback', p.tx, '--json'] : ['rollback', '--last', '--json']
      const r = ctx.run('uppenv', args)
      return { code: r.code, tx: p.tx ?? 'last', result: r.json ?? null, stderr: r.code === 0 ? undefined : r.stderr.slice(0, 2000) }
    },
  },

  'env.tools': {
    group: 'env',
    title: '工具面快照',
    summary: '列出导出的 MCP 工具快照，--live 时与宿主实际工具面比对漂移',
    danger: false,
    args: {
      hosts: { type: 'array', desc: '限定宿主' },
      live: { type: 'boolean', default: false, desc: '连宿主探测并比对' },
    },
    async run(ctx, p) {
      const args = ['tools', '--json']
      if (p.hosts?.length) args.push('--host', p.hosts.join(','))
      if (p.live) args.push('--live')
      const r = ctx.run('uppenv', args, { timeoutMs: 180000 })
      return { code: r.code, servers: r.json ?? null, stderr: r.code === 0 ? undefined : r.stderr.slice(0, 2000) }
    },
  },

  // ------------------------------------------------------------------ plugin
  'plugin.detect': {
    group: 'plugin',
    title: '探测宿主',
    summary: '检测 DSH / WorkBuddy / Accio 的安装位置',
    danger: false,
    args: {},
    async run(ctx) {
      const r = ctx.run('upp', ['detect'])
      return { code: r.code, output: (r.stdout ?? '').slice(0, 4000), json: r.json ?? null }
    },
  },

  'plugin.init': {
    group: 'plugin',
    title: '新建插件',
    summary: '从 hello-upp 模板生成一个新插件目录',
    danger: false,
    args: {
      id: { type: 'string', required: true, desc: '插件 id（小写连字符）' },
      dir: { type: 'string', desc: '目标目录（默认 ./<id>）' },
    },
    async run(ctx, p) {
      const args = ['init', p.id]
      if (p.dir) args.push(p.dir)
      const r = ctx.run('upp', args)
      return { code: r.code, dir: p.dir ?? p.id, output: (r.stdout ?? '').slice(0, 3000), json: r.json ?? null, stderr: (r.stderr ?? '').slice(0, 2000) }
    },
  },

  'plugin.validate': {
    group: 'plugin',
    title: '校验插件',
    summary: 'UPP 规范校验（42 项门槛）',
    danger: false,
    args: { pkg: { type: 'string', required: true, desc: '插件目录' } },
    async run(ctx, p) {
      const r = ctx.run('upp', ['validate', '--pkg', p.pkg])
      const checks = Array.isArray(r.json?.checks) ? r.json.checks : []
      return {
        code: r.code,
        failed: r.json?.failed ?? checks.filter((c) => !c.ok).length,
        passed: checks.filter((c) => c.ok).length,
        checks: checks.map((c) => ({ check: c.check, ok: Boolean(c.ok), detail: String(c.detail ?? '') })),
        output: checks.length ? undefined : (r.stdout ?? '').slice(0, 4000),
      }
    },
  },

  'plugin.verify': {
    group: 'plugin',
    title: '验证安装',
    summary: '宿主侧验证（offline 规范 + 实机冒烟）',
    danger: false,
    args: {
      pkg: { type: 'string', required: true, desc: '插件目录' },
      hosts: { type: 'array', desc: '限定宿主' },
    },
    async run(ctx, p) {
      const args = ['verify', '--pkg', p.pkg]
      if (p.hosts?.length) args.push('--hosts', p.hosts.join(','))
      const r = ctx.run('upp', args, { timeoutMs: 180000 })
      return { code: r.code, json: r.json ?? null, output: (r.stdout ?? '').slice(0, 4000) }
    },
  },

  'plugin.pack': {
    group: 'plugin',
    title: '打包插件',
    summary: '生成 .upp + .sha256 + .sig.json',
    danger: true,
    args: {
      pkg: { type: 'string', required: true, desc: '插件目录' },
      out: { type: 'string', desc: '输出目录（默认 <pkg>/dist）' },
    },
    async run(ctx, p) {
      const args = ['pack', '--pkg', p.pkg]
      if (p.out) args.push('--out', p.out)
      const r = ctx.run('upp', args, { timeoutMs: 120000 })
      return { code: r.code, json: r.json ?? null, output: (r.stdout ?? '').slice(0, 3000) }
    },
  },

  'plugin.install': {
    group: 'plugin',
    title: '安装插件',
    summary: '从 .upp 安装到三端（校验哈希/签名后）',
    danger: true,
    args: { from: { type: 'string', required: true, desc: '.upp 文件路径' } },
    async run(ctx, p) {
      const r = ctx.run('upp', ['install', '--from', p.from], { timeoutMs: 240000 })
      return { code: r.code, json: r.json ?? null, output: (r.stdout ?? '').slice(0, 3000), stderr: (r.stderr ?? '').slice(0, 2000) }
    },
  },

  // ---------------------------------------------------------------- migrate
  // One-button machine migration: pack (old machine) -> copy -> check -> dry-run
  // -> apply. Each step is a separate action so the wizard can resume, be driven
  // by an agent one step at a time, and stay terse on the MCP surface.
  'migrate.plan': {
    group: 'migrate',
    title: '换机体检',
    summary: '只读：探测三端、统计可迁移资产、给出推荐参数与 5 步向导',
    danger: false,
    args: {
      hosts: { type: 'array', desc: '限定宿主' },
      kinds: { type: 'array', desc: '限定类型' },
    },
    async run(ctx, p) {
      const det = ctx.run('uppenv', ['detect', '--json'], { timeoutMs: 60000 })
      const scanArgs = ['scan', '--json']
      if (p.hosts?.length) scanArgs.push('--host', p.hosts.join(','))
      if (p.kinds?.length) scanArgs.push('--kind', p.kinds.join(','))
      const scan = ctx.run('uppenv', scanArgs, { timeoutMs: 180000 })
      const hosts = Array.isArray(det.json) ? det.json : []
      const assets = Array.isArray(scan.json) ? scan.json : []
      const byKind = {}
      const byHost = {}
      for (const a of assets) {
        byKind[a.kind] = (byKind[a.kind] ?? 0) + 1
        byHost[a.host] = (byHost[a.host] ?? 0) + 1
      }
      const key = resolveSigningKey(ctx.env)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      return {
        code: scan.code,
        hosts: hosts.map((h) => ({
          host: h.host,
          available: h.available !== false,
          detail: h.profile ?? h.account ?? h.version ?? h.reason ?? '',
        })),
        total: assets.length,
        byKind,
        byHost,
        signingKey: key ? { present: true, source: key.source, path: key.path } : { present: false, hint: 'upp env keygen 生成密钥后可签名' },
        defaults: {
          out: `uppenv-${stamp}.uppenv`,
          hosts: ['dsh', 'workbuddy', 'accio'],
          kinds: ['plugin', 'skill', 'mcp', 'tool', 'memory'],
          sign: Boolean(key),
          probeTools: true,
        },
        steps: [
          { n: 1, id: 'pack', title: '在旧机器打包', action: 'migrate.pack', detail: '选三端与资产类型，导出 .uppenv（建议签名）' },
          { n: 2, id: 'transfer', title: '把文件拷到新机器', action: null, detail: 'U 盘 / 网盘 / scp 都行；顺手记下 sha256' },
          { n: 3, id: 'card', title: '新机器核对镜像', action: 'migrate.card', detail: '核对大小、sha256、签名与资产清单' },
          { n: 4, id: 'preview', title: '预演导入', action: 'migrate.preview', detail: 'dry-run 看每个资产 create/update/skip 到哪' },
          { n: 5, id: 'apply', title: '真正导入', action: 'migrate.apply', detail: '事务执行，出问题一键回滚' },
        ],
        stderr: scan.code === 0 ? undefined : scan.stderr.slice(0, 2000),
      }
    },
  },

  'migrate.pack': {
    group: 'migrate',
    title: '① 打包这台机器',
    summary: '导出环境镜像并生成「交接卡」（文件、大小、sha256、签名指纹、下一步）',
    danger: false,
    args: {
      out: { type: 'string', desc: '输出文件' },
      hosts: { type: 'array', desc: '限定宿主' },
      kinds: { type: 'array', desc: '限定类型' },
      sign: { type: 'boolean', default: false, desc: 'ed25519 签名（推荐）' },
      probeTools: { type: 'boolean', default: true, desc: '探测 MCP 工具面' },
      force: { type: 'boolean', default: false, desc: '覆盖已存在文件' },
    },
    async run(ctx, p) {
      const out = p.out && p.out.trim() ? p.out : `uppenv-${new Date().toISOString().replace(/[:.]/g, '-')}.uppenv`
      const args = ['export', '-o', out, '--json']
      if (p.hosts?.length) args.push('--host', p.hosts.join(','))
      if (p.kinds?.length) args.push('--kind', p.kinds.join(','))
      if (p.sign) args.push('--sign')
      if (p.force) args.push('--force')
      if (p.probeTools === false) args.push('--no-probe-tools')
      const r = ctx.run('uppenv', args, { timeoutMs: 360000 })
      if (r.code !== 0) return { code: r.code, stderr: (r.stderr ?? '').slice(0, 2000) }
      const file = r.json?.file ?? out
      let sizeBytes = null
      let sha256 = null
      try {
        sizeBytes = fs.statSync(file).size
        sha256 = sha256File(file)
      } catch {
        /* the image may live on another drive that is not readable here */
      }
      const abs = path.resolve(file)
      return {
        code: r.code,
        file: abs,
        stats: r.json?.stats ?? null,
        signature: (() => {
          const side = readSignature(file)
          if (side) return { signed: true, fingerprint: side.keyFingerprint, signedAt: side.signedAt, alg: side.alg }
          return r.json?.signature ? { signed: true, fingerprint: r.json.signature.fingerprint ?? null } : { signed: false }
        })(),
        handoff: {
          file: abs,
          name: path.basename(abs),
          sizeBytes,
          human: humanBytes(sizeBytes),
          sha256,
          transfer: `把 ${path.basename(abs)} 拷到新机器（U 盘 / 网盘 / scp），并核对 sha256`,
          next: `upp env import ${path.basename(abs)} --dry-run`,
        },
      }
    },
  },

  'migrate.card': {
    group: 'migrate',
    title: '② 核对镜像（新机器）',
    summary: '只读：校验哈希与签名，列出镜像里的资产清单，给出导入前的风险提示',
    danger: false,
    args: { file: { type: 'string', required: true, desc: '镜像文件路径' } },
    async run(ctx, p) {
      const file = path.resolve(p.file)
      const ins = ctx.run('uppenv', ['inspect', file, '--json'], { timeoutMs: 120000 })
      const ver = ctx.run('uppenv', ['verify', file, '--json'], { timeoutMs: 180000 })
      if (ins.code !== 0) return { code: ins.code, file, error: `not a readable image: ${(ins.stderr ?? '').slice(0, 400)}` }
      const m = ins.json?.manifest ?? {}
      const sig = ver.json?.signature ?? null
      const problems = ver.json?.problems ?? []
      let sizeBytes = ins.json?.size ?? null
      let sha256 = null
      try {
        sha256 = sha256File(file)
      } catch {
        /* ignore */
      }
      return {
        code: ver.code,
        file,
        sizeBytes,
        human: humanBytes(sizeBytes),
        sha256,
        valid: ver.json?.ok !== false && problems.length === 0,
        problems: problems.slice(0, 10),
        signature: sig
          ? { signed: Boolean(sig.signed), fingerprint: sig.fingerprint ?? null, problems: (sig.problems ?? []).slice(0, 5) }
          : { signed: false },
        schema: m.schema ?? null,
        createdAt: m.createdAt ?? null,
        tool: m.tool ?? null,
        total: m.stats?.assets ?? 0,
        byKind: m.stats?.byKind ?? {},
        byHost: m.stats?.byHost ?? {},
        bytes: m.stats?.bytes ?? null,
        skipped: (m.skipped ?? []).length,
        hint:
          problems.length > 0
            ? '镜像校验失败：不要导入，重新导出'
            : sig && !sig.signed
              ? '镜像未签名：确认来源可信，或导入时加 --require-signature 拒绝'
              : null,
      }
    },
  },

  'migrate.preview': {
    group: 'migrate',
    title: '③ 预演导入',
    summary: 'dry-run：零写入，列出每个资产会 create / update / skip 到哪',
    danger: false,
    args: {
      file: { type: 'string', required: true, desc: '镜像文件路径' },
      hosts: { type: 'array', desc: '限定宿主' },
      kinds: { type: 'array', desc: '限定类型' },
      onConflict: { type: 'string', default: 'skip', desc: 'skip|overwrite|rename' },
      requireSignature: { type: 'boolean', default: false, desc: '拒绝未签名镜像' },
    },
    async run(ctx, p) {
      const args = ['import', path.resolve(p.file), '--json', '--dry-run', '--on-conflict', p.onConflict]
      if (p.hosts?.length) args.push('--host', p.hosts.join(','))
      if (p.kinds?.length) args.push('--kind', p.kinds.join(','))
      if (p.requireSignature) args.push('--require-signature')
      args.push('--yes')
      const r = ctx.run('uppenv', args, { timeoutMs: 360000 })
      const rows = Array.isArray(r.json?.results) ? r.json.results : []
      return {
        code: r.code,
        dryRun: true,
        counts: countOutcomes(rows),
        rows: rows.slice(0, 10).map((row) => ({
          kind: row.kind ?? row.asset?.kind ?? null,
          host: row.host ?? row.asset?.host ?? null,
          id: row.id ?? row.asset?.id ?? null,
          action: row.action ?? row.plan?.action ?? row.result?.action ?? null,
          reason: row.reason ?? null,
        })),
        total: rows.length,
        stderr: r.code === 0 ? undefined : (r.stderr ?? '').slice(0, 2000),
      }
    },
  },

  'migrate.apply': {
    group: 'migrate',
    title: '④ 真正导入',
    summary: '事务导入到本机三端；返回事务 id 与回滚命令',
    danger: true,
    args: {
      file: { type: 'string', required: true, desc: '镜像文件路径' },
      hosts: { type: 'array', desc: '限定宿主' },
      kinds: { type: 'array', desc: '限定类型' },
      onConflict: { type: 'string', default: 'skip', desc: 'skip|overwrite|rename' },
      requireSignature: { type: 'boolean', default: false, desc: '拒绝未签名镜像' },
    },
    async run(ctx, p) {
      const args = ['import', path.resolve(p.file), '--json', '--on-conflict', p.onConflict, '--yes']
      if (p.hosts?.length) args.push('--host', p.hosts.join(','))
      if (p.kinds?.length) args.push('--kind', p.kinds.join(','))
      if (p.requireSignature) args.push('--require-signature')
      const r = ctx.run('uppenv', args, { timeoutMs: 600000 })
      const rows = Array.isArray(r.json?.results) ? r.json.results : []
      const tx = r.json?.tx ?? null
      return {
        code: r.code,
        dryRun: false,
        tx,
        counts: countOutcomes(rows),
        rows: rows.slice(0, 10).map((row) => ({
          kind: row.kind ?? row.asset?.kind ?? null,
          host: row.host ?? row.asset?.host ?? null,
          id: row.id ?? row.asset?.id ?? null,
          action: row.action ?? row.result?.action ?? null,
          reason: row.reason ?? null,
        })),
        rollback: tx ? `upp env rollback ${tx}` : 'upp env rollback --last',
        verify: 'upp doctor',
        stderr: r.code === 0 ? undefined : (r.stderr ?? '').slice(0, 2000),
      }
    },
  },
}

// ------------------------------------------------------------------ helpers

/** Human byte size; null-safe because image stats may be unknown. */
function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Count import outcomes. `uppenv import --json` reports one row per asset with
 * the adapter action under `action` (dry-run) or `result.action` (applied); a
 * few failure kinds live under their own key, so normalise first.
 */
function countOutcomes(rows = []) {
  const counts = { create: 0, update: 0, noop: 0, skip: 0, error: 0, 'missing-host': 0, 'missing-prereq': 0 }
  for (const row of rows) {
    const action = row?.action ?? row?.plan?.action ?? row?.result?.action ?? 'error'
    counts[action] = (counts[action] ?? 0) + 1
  }
  return counts
}

// ------------------------------------------------------------------ envelope

const RESERVED = new Set(['full'])

function coerce(name, spec, value) {
  if (value === undefined || value === null || value === '') {
    if (spec.default !== undefined) return spec.default
    if (spec.required) throw new ToolError(`missing required param: ${name}`, { hint: `${name}: ${spec.desc ?? spec.type}` })
    return undefined
  }
  switch (spec.type) {
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n)) throw new ToolError(`param ${name} must be a number`, { hint: `got ${JSON.stringify(value)}` })
      return n
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      const s = String(value).toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(s)) return true
      if (['0', 'false', 'no', 'off'].includes(s)) return false
      throw new ToolError(`param ${name} must be a boolean`, { hint: `got ${JSON.stringify(value)}` })
    }
    case 'array': {
      if (Array.isArray(value)) return value
      return String(value)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    }
    case 'object': {
      if (typeof value === 'object') return value
      try {
        return JSON.parse(String(value))
      } catch {
        throw new ToolError(`param ${name} must be JSON object`, { hint: `got ${JSON.stringify(value)}` })
      }
    }
    default:
      return String(value)
  }
}

export function validateParams(actionId, params = {}) {
  const action = ACTIONS[actionId]
  if (!action) {
    throw new ToolError(`unknown action: ${actionId}`, { hint: `known actions: ${Object.keys(ACTIONS).join(', ')}` })
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ToolError('params must be an object', { hint: '{"action":"mem.list","params":{}}' })
  }
  for (const key of Object.keys(params)) {
    if (RESERVED.has(key)) continue
    if (!(key in action.args)) {
      throw new ToolError(`unknown param for ${actionId}: ${key}`, { hint: `allowed: ${Object.keys(action.args).join(', ') || '(none)'}` })
    }
  }
  const out = {}
  for (const [name, spec] of Object.entries(action.args)) out[name] = coerce(name, spec, params[name])
  return out
}

/** Cap a payload down to a token-cheap shape (unless full). */
export function briefify(value, full = false) {
  let truncated = false
  if (full) return { data: value, truncated: false }
  const walk = (node, depth) => {
    if (node == null) return node
    if (typeof node === 'string') {
      if (node.length > BRIEF_MAX_STRING) {
        truncated = true
        return `${node.slice(0, BRIEF_MAX_STRING)}…(${node.length} chars)`
      }
      return node
    }
    if (Array.isArray(node)) {
      const items = node.slice(0, BRIEF_MAX_ITEMS).map((v) => walk(v, depth + 1))
      if (node.length > BRIEF_MAX_ITEMS) truncated = true
      return items
    }
    if (typeof node === 'object') {
      if (depth >= BRIEF_MAX_DEPTH) return '{…}'
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, depth + 1)
      return out
    }
    return node
  }
  return { data: walk(value, 0), truncated }
}

export async function runAction(id, params = {}, ctx) {
  const started = Date.now()
  const action = ACTIONS[id]
  let clean
  try {
    clean = validateParams(id, params)
  } catch (err) {
    return { ok: false, action: id, error: err.message, hint: err.hint, tookMs: Date.now() - started }
  }
  ctx.log?.('info', `${id} ${JSON.stringify(clean).slice(0, 300)}`)
  try {
    const raw = await action.run(ctx, clean)
    // `brief: false` marks actions whose result IS the payload (doctor's health gate):
    // truncating rows there would let a failure hide behind the array cap.
    const { data, truncated } = action.brief === false
      ? { data: raw, truncated: false }
      : briefify(raw, params.full === true)
    const envelope = { ok: true, action: id, data, tookMs: Date.now() - started }
    if (truncated) envelope.truncated = true
    if (action.danger) envelope.note = 'mutating action'
    return envelope
  } catch (err) {
    const envelope = {
      ok: false,
      action: id,
      error: err?.message ?? String(err),
      tookMs: Date.now() - started,
    }
    if (err?.hint) envelope.hint = err.hint
    else if (err?.code) envelope.hint = `${err.code}`
    return envelope
  }
}

/** Terse catalog for MCP/UI: ids + arg names, no prose. */
export function catalog({ verbose = false } = {}) {
  return GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    actions: Object.entries(ACTIONS)
      .filter(([, a]) => a.group === g.id)
      .map(([id, a]) => {
        const base = { id, title: a.title, summary: a.summary, danger: Boolean(a.danger) }
        base.args = verbose
          ? Object.entries(a.args).map(([name, spec]) => ({
              name,
              type: spec.type,
              required: Boolean(spec.required),
              desc: spec.desc ?? '',
              default: spec.default ?? null,
            }))
          : Object.keys(a.args)
        return base
      }),
  }))
}

export function actionIds() {
  return Object.keys(ACTIONS)
}

export function describeAction(id) {
  const a = ACTIONS[id]
  if (!a) return null
  return { id, group: a.group, title: a.title, summary: a.summary, danger: Boolean(a.danger), args: a.args }
}
