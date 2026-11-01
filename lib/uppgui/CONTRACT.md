# uppgui contract (frozen)

Local GUI + agent bridge for the UPP toolchain (`upp`, `uppenv`, `upptool`, `uppmem`).
Zero runtime dependencies: Node built-ins only, no network calls, no CDN assets.

## 0. Files

| path | owner | meaning |
| --- | --- | --- |
| `lib/uppgui/actions.mjs` | Lead | action catalog = single source of truth (CLI, HTTP, MCP all use it) |
| `lib/uppgui/server.mjs` | Lead | HTTP server + static files + action dispatch |
| `lib/uppgui/mcp.mjs` | Lead | MCP stdio server exposing `upp_action` / `upp_catalog` |
| `lib/uppgui/ui/{index.html,app.js,style.css}` | T1 | the browser UI (vanilla JS, no build step) |
| `tools/uppgui.mjs` | Lead | CLI entry: serve/open/status/action/mcp/selftest |
| `tools/build-gui.mjs` | T2 | payload + SEA exe + zip builder |
| `tools/test-uppgui.mjs` | T3 | headless test suite |

## 1. Action catalog

`actions.mjs` exports:

```js
export const GROUPS = [{ id: 'overview', title: '概览' }, ...]
export const ACTIONS = {
  'mem.search': {
    group: 'memory',             // GROUPS[].id
    title: '搜索记忆',
    summary: '按关键词检索共享记忆池',
    danger: false,               // true => UI needs confirm, MCP marks non-idempotent
    args: {
      query: { type: 'string', required: true, desc: '关键词' },
      limit: { type: 'number', default: 20, desc: '返回条数' },
    },
    run: async (ctx, params) => ({ ... }),   // returns DATA (not the envelope)
  },
}
export async function runAction(id, params, ctx)  // -> { ok, action, data, note?, next?, tookMs }
export function catalog()                          // -> grouped, terse structure for UI/MCP
```

Rules:

- `run()` returns **data**; never throws for expected failures — throw `new ToolError(msg, { hint })` so the envelope becomes `{ ok: false, action, error, hint }`. Unexpected throws are caught the same way.
- `ctx` = `{ roots, run(tool, args, opts), log(level, msg), version }`.
  - `ctx.run('uppmem', ['list','--json'])` spawns `node <repoOrPayload>/tools/<tool>.mjs ...` (in the SEA build the payload root is used), returns `{ code, stdout, stderr, json }`.
- Every action must work when the workspace/hosts are absent (return empty lists, not crashes).
- Params are validated against `args` (unknown keys rejected). Booleans/numbers are coerced.
- Default response is **brief**: arrays capped at 10 items and strings at 200 chars unless `params.full === true`. The envelope says `"truncated": true` when a cap hit.
- **Id scheme**: namespaced `group.thing` matching `/^[a-z][a-z0-9]*\.[a-z][a-z0-9.-]*$/`. The only bare ids allowed are the overview singletons `status` and `doctor` (overall rule `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9.-]*)?$/` + that two-id allowlist; any other bare id is a contract violation and fails `tools/test-uppgui.mjs`).
- **Danger rule**: any id whose last segment is `rm`, `rollback`, `import`, `pack`, `install` or `uninstall` MUST set `danger: true` (UI requires confirmation; agents should dry-run first).

## 2. HTTP API (localhost only)

Server binds `127.0.0.1` and a token is required unless `--no-auth`.

- `GET /api/ping` -> `{ ok, app:'uppgui', version, actionCount, uptimeMs, pid, noAuth, tokenRequired }`
- `GET /api/catalog` -> `{ ok, groups:[{ id, title, actions:[{ id, title, summary, danger, args:[{name,type,required,desc,default}] }] }] }`
- `GET /api/status` -> shorthand for action `status` (same envelope as POST)
- `POST /api/action` body `{"action":"mem.search","params":{"query":"upp"},"full":false}` -> action envelope
- `GET /api/log?since=<seq>` -> `{ ok, next, events:[{ seq, ts, level, msg }] }` (ring buffer, 500)
- `GET /` , `/app.js` , `/style.css` -> static files from `lib/uppgui/ui/`
- Auth: `?token=...` query param or `X-UPP-Token` header; wrong/missing token -> HTTP 401 `{ ok:false, error:'unauthorized' }` for every `/api/*` route **except** `/api/ping`.
- Public (never gated; they carry no data, only code that then calls `/api/*` with the URL token): `/`, `/index.html`, `/app.js`, `/style.css`, `/favicon.ico`, `/api/ping`. Browsers request sub-resources without the query token, so gating them would render a blank page.
- `/api/ping` always answers 200 and includes `noAuth` / `tokenRequired`; clients must read those fields instead of inferring auth from a 401 probe.
- All responses are `application/json; charset=utf-8` except statics. CORS: no wildcard (loopback UI is same-origin).

## 3. MCP bridge (agent surface)

`uppgui --mcp` (or `node tools/uppgui.mjs mcp`) speaks newline-delimited JSON-RPC 2.0 on stdio,
protocolVersion `2024-11-05`, server name `uppgui`.

Only **two** tools — deliberately small so an agent pays little context:

1. `upp_action` — `{ action: string, params?: object, full?: boolean }` -> the action envelope as JSON text.
2. `upp_catalog` — `{}` -> `{ groups:[{id,title,actions:[{id,args:[names],danger}]}] }` (terse; no descriptions).

The `upp_action` description embeds a one-line list of action ids (comma separated) so a model can
choose without calling `upp_catalog`. Errors are structured: `{ ok:false, error, hint }`.

## 4. CLI

```
uppgui                      # start server, open browser  (installed app default)
uppgui --no-open --port N    # headless serve
uppgui open                 # open the running instance in a browser
uppgui status [--json]      # ping a running instance
uppgui action <id> [--param k=v ...] [--json] [--full]
uppgui mcp                  # stdio MCP server
uppgui selftest             # start ephemeral server, hit the API, exit 0/1
uppgui --install [--dir P] [--silent]
uppgui --uninstall [--dir P]
```

Aliases in `tools/upp.mjs`: `upp gui ...` forwards to the same entry.

## 5. Packaging (single exe)

`node tools/build-gui.mjs` produces:

- `dist/uppgui.exe` — Node SEA (`node --build-sea`), embeds `payload.zip` as asset `payload.zip`,
  `assets` key must be exactly `payload.zip`, bootstrap is CJS (`dist/build/boot.cjs`).
- `dist/UPP-GUI-Setup-<version>.exe` — same exe copied/renamed for the installer story (one binary,
  it decides: run from outside the install dir + no args => install flow).
- `dist/upp-gui-<version>.zip` — portable zip: `uppgui.exe`, `README.txt`, `install.cmd`, `uninstall.cmd`.
- `dist/payload.zip` — the extracted tree (kept for debugging).

Bootstrap (T2, CJS, inside SEA):

1. `const sea = require('node:sea')`; read asset `payload.zip` (Buffer) — if not SEA, read `dist/payload.zip`.
2. Install root: `--dir` > `UPPGUI_HOME` > `%LOCALAPPDATA%\UPPGUI` (POSIX: `~/.local/share/uppgui`).
3. Payload dir `<root>/app`; extract when `<root>/app/.payload.json` version differs from embedded.
   Zip read must be self-contained (use `lib/uppenv/core/archive.mjs`'s logic copied into the payload builder,
   or a tiny inline reader — no npm deps).
4. Modes: install / uninstall / mcp / cli / selftest / serve (default when payload is already installed or
   the process runs from inside `<root>`).
5. `serve`: dynamic `import(pathToFileURL(<root>/app/lib/uppgui/server.mjs))` then
   `await mod.start({ open: true, payloadDir: <root>/app })`.
6. `--cli <tool> ...`: dynamic import `<root>/app/tools/<tool>.mjs` with `process.argv` rewritten
   (`argv[1]` = script path, rest = user args) so the script's own main runs.
7. Install writes: exe copy, `<root>/app` payload, Desktop `.lnk`, Start Menu `.lnk`,
   HKCU `Software\Microsoft\Windows\CurrentVersion\Uninstall\uppgui` (DisplayName/Version/InstallLocation/
   UninstallString/DisplayIcon), and prints what it did. `--silent` = no prompts, JSON summary on stdout.
8. Uninstall removes shortcuts, registry key, payload, and the install dir itself (schedule self-delete
   via `%TEMP%` batch if the exe is the running file).

Constraints: no network, no admin rights, no npm dependencies, deterministic output paths, and the build
must run offline. `node --check` every generated `.cjs`/`.mjs` before shipping.

## 6. Token economy (hard requirement)

- MCP surface = 2 tools; `tools/list` payload must stay < 4 KB.
- Terse catalog: ids + arg names only.
- Brief responses by default (10 items / 200 chars), `full:true` to expand.
- Every envelope carries `next` hints only when useful (`["upp_gui mem.sync --host workbuddy"]`).
- UI never requires the agent: any UI action prints its equivalent CLI/MCP call in the log panel.

`tools/test-uppgui.mjs` asserts the size budgets and the truncation behaviour.
