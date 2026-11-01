/**
 * uppgui — localhost HTTP server for the GUI + the machine-readable API that
 * agents can drive. Binds 127.0.0.1 only, token-gated by default, no outbound
 * network access of any kind.
 *
 * Contract: lib/uppgui/CONTRACT.md §2
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { ACTIONS, GROUPS, TOOL, catalog, createContext, runAction } from './actions.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const UI_DIR = path.join(HERE, 'ui')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

const LOG_LIMIT = 500

function makeLogger() {
  const events = []
  let seq = 0
  const push = (level, msg) => {
    const event = { seq: ++seq, ts: new Date().toISOString(), level, msg: String(msg) }
    events.push(event)
    if (events.length > LOG_LIMIT) events.splice(0, events.length - LOG_LIMIT)
    return event
  }
  return { push, events, tail: (since = 0) => events.filter((e) => e.seq > Number(since || 0)) }
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  })
  res.end(buf)
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function safeTokenEqual(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

/**
 * Start the server.
 * @returns {Promise<{server: import('node:http').Server, port: number, token: string, url: string, close: Function}>}
 */
/** A SEA host runs payload tools through `exe --cli <tool>`; a checkout runs `node tools/<tool>.mjs`. */
function detectSeaMode(payloadDir) {
  try {
    // `node:sea` exists since Node 20.12; createRequire keeps this valid in ESM and
    // makes an older runtime throw (caught below) instead of breaking the import.
    const { isSea } = createRequire(import.meta.url)('node:sea')
    if (isSea()) return true
  } catch {
    /* not a SEA runtime, or node:sea is unavailable */
  }
  // A packaged host extracts the payload next to itself and REPO_ROOT resolves inside it,
  // so a path comparison alone cannot tell SEA from a checkout: fall back to it only when
  // the payload obviously lives outside this source tree.
  return payloadDir !== REPO_ROOT && !fs.existsSync(path.join(REPO_ROOT, '.git'))
}

export async function start(options = {}) {
  const payloadDir = options.payloadDir ? path.resolve(options.payloadDir) : REPO_ROOT
  const mode = options.mode ?? (detectSeaMode(payloadDir) ? 'sea' : 'dev')
  const noAuth = Boolean(options.noAuth)
  const token = options.token || crypto.randomBytes(16).toString('hex')
  const logger = makeLogger()
  const ctx = createContext({ payloadDir, mode, env: process.env, log: (level, msg) => logger.push(level, msg), version: TOOL.version })
  logger.push('info', `uppgui ${TOOL.version} starting (payload ${payloadDir})`)

  const state = {
    startedAt: Date.now(),
    readyAt: null,
    lastAction: null,
    actionCount: 0,
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname)

    // --- auth -----------------------------------------------------------------
    // The shell and its assets are not secrets: they contain no data, only code
    // that then calls /api/* with the token from the URL. Serving them un-gated
    // keeps sub-resource requests (app.js/style.css) from 401-ing into a blank page.
    const publicPath =
      pathname === '/' ||
      pathname === '/index.html' ||
      pathname === '/app.js' ||
      pathname === '/style.css' ||
      pathname === '/favicon.ico' ||
      pathname === '/api/ping'
    if (!noAuth && !publicPath) {
      const provided = req.headers['x-upp-token'] ?? url.searchParams.get('token') ?? ''
      if (!safeTokenEqual(provided, token)) {
        logger.push('warn', `401 ${pathname}`)
        return json(res, 401, { ok: false, error: 'unauthorized', hint: 'open the URL printed by the server (it carries the token)' })
      }
    }

    try {
      // --- API ---------------------------------------------------------------
      if (pathname === '/api/ping') {
        return json(res, 200, {
          ok: true,
          app: TOOL.name,
          version: TOOL.version,
          actionCount: Object.keys(ACTIONS).length,
          uptimeMs: Date.now() - state.startedAt,
          pid: process.pid,
          noAuth,
          tokenRequired: !noAuth,
        })
      }

      if (pathname === '/api/catalog') {
        return json(res, 200, { ok: true, version: TOOL.version, groups: catalog({ verbose: true }) })
      }

      if (pathname === '/api/status') {
        const envelope = await runAction('status', {}, ctx)
        return json(res, 200, envelope)
      }

      if (pathname === '/api/log') {
        const since = url.searchParams.get('since') ?? 0
        const events = logger.tail(since)
        const next = events.length ? events[events.length - 1].seq : Number(since || 0)
        return json(res, 200, { ok: true, next, events })
      }

      if (pathname === '/api/action') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'use POST' })
        let payload
        try {
          payload = JSON.parse((await readBody(req)) || '{}')
        } catch (err) {
          return json(res, 400, { ok: false, error: `invalid JSON body: ${err.message}` })
        }
        const actionId = payload.action ?? payload.id
        if (!actionId) return json(res, 400, { ok: false, error: 'body needs { action: "<id>" }' })
        const params = { ...(payload.params ?? {}) }
        if (payload.full != null) params.full = Boolean(payload.full)
        const envelope = await runAction(String(actionId), params, ctx)
        state.actionCount += 1
        state.lastAction = { action: actionId, params, ok: envelope.ok, at: new Date().toISOString() }
        logger.push(envelope.ok ? 'info' : 'error', `${actionId} -> ${envelope.ok ? 'ok' : envelope.error}`)
        return json(res, 200, envelope)
      }

      // --- static ------------------------------------------------------------
      if (pathname === '/' || pathname === '/index.html') {
        return sendStatic(res, path.join(UI_DIR, 'index.html'))
      }
      const rel = pathname.replace(/^\/+/, '')
      if (rel && !rel.includes('..')) {
        const target = path.join(UI_DIR, rel)
        if (target.startsWith(UI_DIR) && fs.existsSync(target) && fs.statSync(target).isFile()) return sendStatic(res, target)
      }
      return json(res, 404, { ok: false, error: `not found: ${pathname}` })
    } catch (err) {
      logger.push('error', `${pathname} -> ${err.message}`)
      return json(res, 500, { ok: false, error: err.message })
    }
  })

  function sendStatic(res, file) {
    const ext = path.extname(file).toLowerCase()
    const body = fs.readFileSync(file)
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(options.port ?? 0), '127.0.0.1', resolve)
  })

  const port = server.address().port
  state.readyAt = Date.now()
  const url = `http://127.0.0.1:${port}/${noAuth ? '' : `?token=${token}`}`
  logger.push('info', `listening on http://127.0.0.1:${port}`)

  const close = () =>
    new Promise((resolve) => {
      try {
        server.close(() => resolve())
        server.closeAllConnections?.()
      } catch {
        resolve()
      }
    })

  const handle = { server, port, token, url, noAuth, payloadDir, ctx, log: logger, state, close }
  if (options.open) {
    if (!openBrowser(url)) logger.push('warn', `could not launch a browser; open ${url} manually`)
  }
  return handle
}

export { TOOL, GROUPS, ACTIONS, catalog }
