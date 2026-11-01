# uppenv adapter contract (v1)

`uppenv` = Docker-like environment image for agent hosts. This document is the
frozen interface between the **core engine** (`upp/lib/uppenv/core/*`,
`upp/lib/uppenv/image.mjs`, `upp/tools/uppenv.mjs`) and **host adapters**
(`upp/lib/uppenv/hosts/*.mjs`).

An adapter is one plain ES module with a default export. No dependencies, no
top-level side effects, no writes outside the `Tx` object.

```js
export default {
  name: 'dsh',                       // must equal one of HOSTS in core/model.mjs
  detect(ctx) -> HostInfo,
  scan(ctx, { kinds, ids, includeBuiltin }) -> ScanAsset[],
  plan(asset, ctx) -> PlanEntry,     // optional; core falls back to a generic plan
  apply(asset, ctx, tx) -> ApplyResult,
  verify(asset, ctx) -> VerifyResult,// optional
}
```

## ctx (built by the core, read-only for adapters)

```js
{
  host: 'dsh',                    // this adapter's host id
  roots: { home, dshHome, uppStore, workbuddyHome, codebuddyHome, accioHome,
           workspace, platform, node, arch },
  tpl: Templates,                 // createTemplates(roots): pathToTemplate / expandValue / templateValue
  env: process.env,
  options: { dryRun, onConflict: 'skip'|'overwrite'|'rename', verbose, only, vendor },
  log(msg),                       // writes to stderr only
}
```

## ScanAsset (what `scan()` returns)

```js
{
  kind: 'plugin'|'skill'|'mcp'|'tool'|'memory',
  host: 'dsh'|'workbuddy'|'accio',
  id: 'pkg-name' | 'skill-dir-name' | 'mcp-server-name' | 'memory-file-stem',
  label?: string,
  version?: string,
  builtin?: boolean,              // host-shipped; exported only with includeBuiltin
  strategy: 'copy-tree'|'write-file'|'merge-json'|'append-text'|'exec',
  requires?: string[],            // free-form prereqs, e.g. ['pnpm','upp','node>=22']
  meta: { ... },                  // kind/host specific, see below; MUST survive JSON
  files: [{ rel: 'posix/rel/path', src: 'absolute source path' }],
  secrets?: { KEY: 'reason' },    // values masked in exports/reports
  placeholders?: { TOKEN: 'description' }, // extra ${TOKEN}s the payload may use
}
```

`files[].src` may point at directories' contents only through individual files —
never pass a directory. `rel` must be relative, forward-slash, no `..`.

`meta` conventions (all optional unless stated):

| kind | meta keys |
| --- | --- |
| plugin | `packageName` (required), `installedVersion`, `source: 'registry'|'link'|'upp'`, `linkPath`, `bundles`, `config` (patch fragment), `hasUi`, `vendor` (`'full'|'manifest'`), `deps` |
| skill | `skillRoot` (template path), `dirName`, `files` count, `hasScripts` |
| mcp | `serverName` (required), `configFile` (template path), `entry` (the config fragment with `${...}` placeholders), `transport: 'stdio'|'sse'|'http'`, `tools` (name list from probe) |
| tool | `serverName`, `source: 'mcp-snapshot'`, `tools: [{name, description, inputSchema?}]` |
| memory | `file` (template path), `format: 'markdown'|'json'|'text'`, `raw: true` (payload is the memory text itself) |

## PlanEntry (what `plan()` returns)

```js
{
  asset,                          // echo
  action: 'create'|'update'|'noop'|'skip'|'missing-host'|'missing-prereq'|'error',
  targets: [{ path, action, detail? }],
  reason?: string,                // required for skip/error
  needs?: string[],               // prereqs that are missing
}
```

`plan()` must never write. Adapters may omit it; the core then reports
`action: 'create'` with the adapter's `targets` hint when provided.

## ApplyResult (what `apply()` returns)

```js
{
  asset, action: 'create'|'update'|'noop'|'skip'|'error',
  targets: [{ path, action }],
  commands?: [{ command, status, skipped }],  // from tx.exec()
  warnings?: string[],
  error?: string,
}
```

Rules:
1. All filesystem mutation goes through `tx.*` (`writeFile`, `writeText`,
   `replaceTree`, `remove`, `backup`) so `uppenv rollback` can undo it.
2. Host CLIs run through `tx.exec('cmd', args)`; it honours dry-run and records
   the command. Never spawn directly.
3. Union types are additive: adding a new `kind` or host must not break adapters
   that do not know it — return `{ action: 'skip', reason: 'unsupported kind' }`.
4. Depth of support must be honest: if a host cannot express something (e.g.
   DSH has no native memory file), return `missing-host`/`skip` with a clear
   `reason`, never fake success.
5. Honor `ctx.options.onConflict` for updates and `ctx.options.dryRun` for
   everything.

## Image layout (written by `image.mjs`, read by nobody but the core)

```
manifest.json                 image metadata + asset index
payload/<kind>__<host>__<slug>/asset.json
payload/<kind>__<host>__<slug>/files/...      payload files (rel paths preserved)
hosts/<host>.json             optional adapter snapshot (detect info)
```

`asset.json` = ScanAsset minus `files`, plus `{ files: [{rel, sha256, size}], digest }`.

## Import materialization

Before `apply()`, the core rebuilds:

```js
asset = { ...assetJson, dir: '<abs payload dir>', files: [{ rel, sha256, size, path }] }
```

`asset.dir` points at `payload/<...>/files`; use `assetFile(asset, rel)` from
`core/apply.mjs` to resolve a payload file.
