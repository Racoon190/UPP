/**
 * uppenv — MCP stdio probe (zero dependencies).
 *
 * `uppenv export` wants to record what an MCP server actually serves (the
 * `meta.tools` convention in CONTRACT.md), but the exporting machine may not be
 * running that server's host. This module keeps the minimum of MCP needed:
 * newline-delimited JSON-RPC 2.0 over a child process' stdio.
 *
 *   spawn → initialize → notifications/initialized → tools/list (cursor pages)
 *
 * MCP servers are third-party code and are allowed to be broken, noisy or slow.
 * `probeServer()` therefore never throws and never rejects: every failure becomes
 * `{ ok: false, error: { code, message } }` so `scan --json` output stays
 * machine-readable. It also closes stdin and kills the child on every path so a
 * probe can never leak a process or hang the caller.
 */
import { spawn } from 'node:child_process'

export const PROTOCOL_VERSION = '2024-11-05'
export const CLIENT_INFO = Object.freeze({ name: 'uppenv', version: '1.0.0' })

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TOOL_PAGES = 100
const MAX_STDERR_CHARS = 4_000
const MAX_DESCRIPTION_CHARS = 60

/**
 * Build a structured, non-throwing error. `toString()`/`toJSON()` make it safe
 * to interpolate into a message (`${result.error}`) or serialize as JSON.
 */
function probeError(code, message, detail) {
  return {
    code,
    message: String(message),
    ...(detail ? { detail: String(detail).slice(-MAX_STDERR_CHARS) } : {}),
    toString() {
      return this.message
    },
    toJSON() {
      return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) }
    },
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Coerce one server-provided tool into the surface shape uppenv stores. */
function normalizeTool(tool) {
  const t = isPlainObject(tool) ? tool : {}
  return {
    name: typeof t.name === 'string' ? t.name : '',
    description: typeof t.description === 'string' ? t.description : '',
    inputSchema: isPlainObject(t.inputSchema) ? t.inputSchema : {},
  }
}

/** Accept a probe result, a tool array, or a name array and return tool objects. */
function asToolList(value) {
  const raw = Array.isArray(value) ? value : Array.isArray(value?.tools) ? value.tools : []
  return raw
    .map((entry) => (typeof entry === 'string' ? normalizeTool({ name: entry }) : normalizeTool(entry)))
    .filter((tool) => tool.name.length > 0)
}

/** Key-order-independent JSON so tool schemas compare structurally. */
function canonicalJson(value) {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 3))}...`
}

/**
 * Probe one MCP stdio server read-only: it never calls a tool, only
 * `initialize` + `tools/list`.
 *
 * @param {{command: string, args?: string[], env?: Record<string,string>, cwd?: string}} server
 * @param {{timeoutMs?: number}} [options] hard deadline for the whole handshake
 * @returns {Promise<{ok: boolean, server: {name: string|null, version: string|null}|null,
 *                    tools: {name: string, description: string, inputSchema: object}[],
 *                    error: null | {code: string, message: string, detail?: string}}>}
 */
export function probeServer(server = {}, options = {}) {
  const cfg = isPlainObject(server) ? server : {}
  const opts = isPlainObject(options) ? options : {}
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
  const command = typeof cfg.command === 'string' ? cfg.command.trim() : ''
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : []
  const extraEnv = isPlainObject(cfg.env) ? cfg.env : {}
  const cwd = typeof cfg.cwd === 'string' && cfg.cwd ? cfg.cwd : undefined

  return new Promise((resolve) => {
    const result = {
      ok: false,
      server: null,
      tools: [],
      error: null,
    }

    if (!command) {
      result.error = probeError('spawn-failed', 'server.command is required')
      resolve(result)
      return
    }

    let child = null
    let settled = false
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let nextId = 1
    let phase = 'startup' // startup | initialize | tools/list
    let expectedId = 0
    let pages = 0
    const seenCursors = new Set()

    const timer = setTimeout(() => {
      finish(probeError('timeout', `MCP probe timed out after ${timeoutMs}ms during ${phase}`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    function terminate() {
      if (!child) return
      try {
        child.stdin.end()
      } catch {
        /* already closed */
      }
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      // Never let a stubborn child keep the caller's event loop alive.
      const hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 250)
      if (typeof hardKill.unref === 'function') hardKill.unref()
    }

    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        result.ok = false
        result.error = error
      } else {
        result.ok = true
        result.error = null
      }
      terminate()
      resolve(result)
    }

    function send(message) {
      if (settled || !child) return false
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
        return true
      } catch {
        return false
      }
    }

    function request(method, params) {
      expectedId = nextId++
      phase = method
      return send({ jsonrpc: '2.0', id: expectedId, method, params })
    }

    function jsonRpcMessage(error) {
      if (isPlainObject(error) && typeof error.message === 'string') return error.message
      return 'server returned a JSON-RPC error'
    }

    function handleMessage(message) {
      if (!isPlainObject(message)) return
      // Responses only. Notifications/requests from the server need no reply here.
      if (message.id === undefined || message.id === null) return
      if (message.id !== expectedId) return

      if (phase === 'initialize') {
        if (message.error) {
          finish(probeError('initialize-error', `initialize failed: ${jsonRpcMessage(message.error)}`))
          return
        }
        const info = isPlainObject(message.result) ? message.result.serverInfo ?? message.result.server : null
        result.server = {
          name: typeof info?.name === 'string' ? info.name : null,
          version: typeof info?.version === 'string' ? info.version : null,
        }
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        if (!request('tools/list', {})) {
          finish(probeError('server-exit', 'server stdin closed before tools/list could be sent'))
        }
        return
      }

      if (phase === 'tools/list') {
        if (message.error) {
          finish(probeError('tools-list-error', `tools/list failed: ${jsonRpcMessage(message.error)}`))
          return
        }
        const page = isPlainObject(message.result) ? message.result : null
        if (!page) {
          finish(probeError('bad-tools-result', 'tools/list returned a non-object result'))
          return
        }
        for (const tool of Array.isArray(page.tools) ? page.tools : []) {
          const normalized = normalizeTool(tool)
          if (normalized.name) result.tools.push(normalized)
        }
        const cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
        if (!cursor) {
          finish(null)
          return
        }
        pages += 1
        if (pages > MAX_TOOL_PAGES) {
          finish(probeError('pagination-loop', `tools/list exceeded ${MAX_TOOL_PAGES} pages`))
          return
        }
        if (seenCursors.has(cursor)) {
          finish(probeError('pagination-loop', `tools/list repeated cursor ${JSON.stringify(cursor)}`))
          return
        }
        seenCursors.add(cursor)
        if (!request('tools/list', { cursor })) {
          finish(probeError('server-exit', 'server stdin closed during tools/list pagination'))
        }
      }
    }

    try {
      const spawnOptions = {
        cwd,
        env: { ...process.env, ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
      // npm-style servers are .cmd shims on Windows; they need a shell to spawn.
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) spawnOptions.shell = true
      child = spawn(command, args, spawnOptions)
    } catch (error) {
      finish(probeError('spawn-failed', `${command}: ${error?.message ?? error}`))
      return
    }

    child.on('error', (error) => {
      finish(probeError('spawn-failed', `${command}: ${error?.message ?? error}`))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      const tail = stderrBuffer.trim()
      const how = signal ? `was terminated by signal ${signal}` : `exited with code ${code}`
      finish(probeError('server-exit', `server ${how} before the probe completed`, tail))
    })
    child.stdin.on('error', () => {
      /* EPIPE when the server dies mid-write; `close` reports it */
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n')
        if (newline < 0) break
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          // Servers (and their dependencies) love to print logs on stdout.
          // MCP is newline-delimited JSON, so anything else is just noise.
          continue
        }
        handleMessage(message)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderrBuffer.length < MAX_STDERR_CHARS) stderrBuffer += chunk
    })

    if (!request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { ...CLIENT_INFO } })) {
      finish(probeError('spawn-failed', 'could not write initialize to the server process'))
    }
  })
}

/**
 * Diff two tool surfaces (as produced by `probeServer(...).tools`, or plain name
 * arrays). Order-insensitive; `inputSchema` is compared structurally.
 *
 * @returns {{same: boolean,
 *            added: string[],
 *            removed: string[],
 *            changed: {name: string, fields: ('description'|'inputSchema')[]}[]}}
 */
export function compareToolSurface(before, after) {
  const beforeMap = new Map(asToolList(before).map((tool) => [tool.name, tool]))
  const afterMap = new Map(asToolList(after).map((tool) => [tool.name, tool]))

  const added = [...afterMap.keys()].filter((name) => !beforeMap.has(name)).sort()
  const removed = [...beforeMap.keys()].filter((name) => !afterMap.has(name)).sort()
  const changed = []
  for (const [name, oldTool] of beforeMap) {
    const newTool = afterMap.get(name)
    if (!newTool) continue
    const fields = []
    if (oldTool.description !== newTool.description) fields.push('description')
    if (canonicalJson(oldTool.inputSchema) !== canonicalJson(newTool.inputSchema)) fields.push('inputSchema')
    if (fields.length) changed.push({ name, fields })
  }
  changed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { same: added.length === 0 && removed.length === 0 && changed.length === 0, added, removed, changed }
}

/**
 * Render a tool surface as a plain text table for CLI output.
 *
 * @param {Array<{name?: string, description?: string, inputSchema?: object}>} tools
 * @returns {string}
 */
export function formatToolTable(tools) {
  const list = asToolList(tools)
  if (list.length === 0) return '(no tools)'
  const rows = list.map((tool) => ({
    name: tool.name || '(unnamed)',
    params: Object.keys(isPlainObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {}).length,
    description: String(tool.description ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
  }))
  const nameWidth = Math.min(40, Math.max(4, ...rows.map((row) => row.name.length)))
  const lines = [`${'NAME'.padEnd(nameWidth)}  ${'PARAMS'.padStart(6)}  DESCRIPTION`]
  for (const row of rows) {
    lines.push(
      `${clip(row.name, nameWidth).padEnd(nameWidth)}  ${String(row.params).padStart(6)}  ${clip(
        row.description,
        MAX_DESCRIPTION_CHARS,
      )}`.trimEnd(),
    )
  }
  return lines.join('\n')
}
