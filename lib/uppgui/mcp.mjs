/**
 * uppgui — MCP bridge.
 *
 * Deliberately tiny: TWO tools. A model that wants to drive the GUI pays for a
 * ~1 KB tools/list instead of a 30-tool schema, and gets every capability
 * through `upp_action` (the same catalog the browser uses).
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout; diagnostics on stderr.
 * Contract: lib/uppgui/CONTRACT.md §3
 */
import { createInterface } from 'node:readline'

import { ACTIONS, TOOL, actionIds, catalog, createContext, runAction } from './actions.mjs'

export const PROTOCOL_VERSION = '2024-11-05'
export const SERVER_INFO = { name: 'uppgui', version: TOOL.version }

const IDS = actionIds()

export function toolDefinitions() {
  return [
    {
      name: 'upp_action',
      description:
        `Run one UPP GUI action on this machine (plugins/skills/MCP/tools/memory for DSH, WorkBuddy and Accio). ` +
        `action ids: ${IDS.join(', ')}. ` +
        `Pass params per id (call upp_catalog for arg names). Output is brief by default (10 rows / 200 chars); set full=true for everything. ` +
        `danger ids modify host files/config and are reversible via the matching rollback/remove id.`,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'action id, e.g. "mem.search"' },
          params: { type: 'object', description: 'action parameters', additionalProperties: true },
          full: { type: 'boolean', description: 'disable brief truncation' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    {
      name: 'upp_catalog',
      description: 'List every upp_action id with its arg names and danger flag (terse; no prose).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
}

export function createMcpServer({ payloadDir, mode = 'dev', env = process.env, log = () => {} } = {}) {
  const ctx = createContext({ payloadDir, mode, env, log })

  const callTool = async (name, args) => {
    if (name === 'upp_catalog') {
      const groups = catalog({ verbose: false })
      return textResult({
        count: IDS.length,
        groups: groups.map((g) => ({
          id: g.id,
          actions: g.actions.map((a) => ({ id: a.id, args: a.args, danger: a.danger })),
        })),
      })
    }
    if (name !== 'upp_action') throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 })
    if (!args?.action || !ACTIONS[args.action]) {
      return textResult({
        ok: false,
        error: `unknown action: ${args?.action}`,
        hint: `known ids: ${IDS.join(', ')}`,
      })
    }
    const params = { ...(args.params ?? {}) }
    if (args.full != null) params.full = Boolean(args.full)
    return textResult(await runAction(String(args.action), params, ctx))
  }

  return {
    async handle(request) {
      const { id, method, params } = request ?? {}
      const reply = (result) => ({ jsonrpc: '2.0', id, result })
      const errorReply = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

      if (method === 'initialize') {
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            'UPP control surface. Prefer read-only ids first (status, mem.search, tool.suggest, env.scan). ' +
            'Mutating ids are reversible: env.import -> env.rollback, mem.install -> mem.install{remove:true}. ' +
            'Always use JSON params; brief output is already token-trimmed.',
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
          return reply(await callTool(name, args))
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

export function startMcp({ payloadDir, mode = 'dev', input = process.stdin, output = process.stdout, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const server = createMcpServer({ payloadDir, mode, log })
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
    Promise.resolve(server.handle(request))
      .then((reply) => send(reply))
      .catch((err) => send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32603, message: String(err?.message ?? err) } }))
  })
  return new Promise((resolve) => {
    rl.on('close', resolve)
    input.on?.('end', resolve)
  })
}
