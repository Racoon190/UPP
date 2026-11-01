/**
 * Minimal MCP stdio server exposing the shared memory pool to any MCP host.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout; all diagnostics go
 * to stderr so the protocol stream stays clean.
 *
 * Tools: memory_search / memory_list / memory_get / memory_add / memory_stats
 */
import { createInterface } from 'node:readline'

import * as mem from './core.mjs'

export const PROTOCOL_VERSION = '2024-11-05'
export const SERVER_INFO = { name: 'uppmem', version: '1.1.0' }

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })

export function toolDefinitions() {
  return [
    {
      name: 'memory_search',
      description: 'Search the shared agent memory pool (all hosts) for facts, preferences and decisions relevant to a query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: str('what to search for'),
          limit: { type: 'integer', description: 'max results (default 20)' },
          kind: str('optional kind filter', { enum: mem.KINDS }),
          tag: str('optional tag filter'),
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_list',
      description: 'List shared memory entries, newest first.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: str('optional kind filter', { enum: mem.KINDS }),
          tag: str('optional tag filter'),
          limit: { type: 'integer', description: 'max results (default 50)' },
        },
      },
    },
    {
      name: 'memory_get',
      description: 'Fetch one shared memory entry by id or key.',
      inputSchema: { type: 'object', properties: { ref: str('entry id or key') }, required: ['ref'] },
    },
    {
      name: 'memory_add',
      description: 'Store a durable fact, preference or decision in the shared memory pool so every agent on this machine can use it later.',
      inputSchema: {
        type: 'object',
        properties: {
          text: str('the memory to store (one self-contained sentence or short paragraph)'),
          kind: str('entry kind', { enum: mem.KINDS }),
          tags: { type: 'array', items: { type: 'string' }, description: 'short tags' },
          key: str('stable semantic key, e.g. "user.language" (updates the same entry)'),
        },
        required: ['text'],
      },
    },
    {
      name: 'memory_stats',
      description: 'Show shared memory pool statistics (entry count, kinds, last sync per host).',
      inputSchema: { type: 'object', properties: {} },
    },
  ]
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}

export function createMcpServer({ home = mem.root(), log = () => {} } = {}) {
  const callTool = (name, args) => {
    switch (name) {
      case 'memory_search': {
        const rows = mem.searchEntries(home, args.query, { kind: args.kind, tag: args.tag, limit: args.limit ?? 20 })
        return textResult({ query: args.query, count: rows.length, entries: rows.map(slim) })
      }
      case 'memory_list': {
        const rows = mem.listEntries(home, { kind: args.kind, tag: args.tag, limit: args.limit ?? 50 })
        return textResult({ count: rows.length, entries: rows.map(slim) })
      }
      case 'memory_get': {
        return textResult(mem.resolveEntry(home, args.ref))
      }
      case 'memory_add': {
        const res = mem.addEntry(home, { text: args.text, kind: args.kind ?? 'fact', tags: args.tags ?? [], key: args.key, source: { host: 'mcp', path: null } })
        mem.rebuildIndex(home)
        return textResult({ ok: true, created: res.created, updated: res.updated, id: res.entry.id, key: res.entry.key })
      }
      case 'memory_stats': {
        const s = mem.stats(home)
        return textResult({ entries: s.entries, byKind: s.byKind, tags: s.tags, hosts: s.hosts, home: s.home })
      }
      default:
        throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 })
    }
  }

  return {
    handle(request) {
      const { id, method, params } = request ?? {}
      const reply = (result) => ({ jsonrpc: '2.0', id, result })
      const errorReply = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })

      if (method === 'initialize') {
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: 'Shared memory across every agent on this machine. Search before asking the user; add durable facts with memory_add.',
        })
      }
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null
      if (method === 'ping') return reply({})
      if (method === 'tools/list') return reply({ tools: toolDefinitions() })
      if (method === 'tools/call') {
        const name = params?.name
        const args = params?.arguments ?? {}
        if (!toolDefinitions().some((t) => t.name === name)) return errorReply(-32602, `unknown tool: ${name}`)
        try {
          return reply(callTool(name, args))
        } catch (err) {
          if (err?.code === -32602) return errorReply(-32602, err.message)
          return reply({ content: [{ type: 'text', text: `error: ${err?.message ?? err}` }], isError: true })
        }
      }
      if (method === 'resources/list') return reply({ resources: [] })
      if (method === 'prompts/list') return reply({ prompts: [] })
      return errorReply(-32601, `method not found: ${method}`)
    },
  }
}

function slim(entry) {
  return {
    id: entry.id,
    key: entry.key,
    kind: entry.kind,
    text: entry.text,
    tags: entry.tags,
    scope: entry.scope,
    updatedAt: entry.updatedAt,
    source: entry.source ?? null,
  }
}

export function runMcpServer({ home = mem.root(), input = process.stdin, output = process.stdout, log = () => {} } = {}) {
  const server = createMcpServer({ home, log })
  const rl = createInterface({ input, crlfDelay: Infinity })
  const send = (msg) => {
    if (msg) output.write(`${JSON.stringify(msg)}\n`)
  }
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let request
    try {
      request = JSON.parse(trimmed)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    try {
      send(server.handle(request))
    } catch (err) {
      send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32603, message: String(err?.message ?? err) } })
    }
  })
  return new Promise((resolve) => {
    rl.on('close', resolve)
    input.on?.('end', resolve)
  })
}

export { mem }
