---
name: sheet-toolkit
description: Profile, clean and summarize xlsx/csv.
---

# Sheet Toolkit

Three local tools: `sheet_profile` (structure + bounded sample), `sheet_clean`
(trim / drop empty and duplicate rows, with counters), `sheet_summary` (group +
aggregate). Everything runs on this machine; nothing is uploaded.

## Use it in this order

1. **Always `sheet_profile` first**, with `path` (and `sheet` only when the
   file has several sheets). It returns sheet names, `rows`/`cols`, per-column
   `type` / `nonEmpty` / `duplicates`, and a small `sampleRows`. Report that
   summary, not the whole table.
2. If the data is dirty (padded cells, blank rows, repeated rows), call
   **`sheet_clean`** with the same `path`/`sheet`. It applies `trim`,
   `dropEmptyRows`, `dropDuplicates` (all true by default), returns a bounded
   preview plus `before` / `after` / `removedEmpty` / `removedDuplicate` /
   `trimmedCells`.
3. If the user wants totals, call **`sheet_summary`** with `groupBy` (a column
   name from step 1), `values` (1-5 numeric column names), optional `aggs`
   (`sum`/`avg`/`min`/`max`/`count`, default all) and `topN` (default 10).
   `labels` names every aggregate; `totals` covers the whole sheet; `groups` is
   the real group count even when `rows` was cut by `topN`.

Stop as soon as the question is answered. `truncated: true` means the output hit
a hard cap (rows, columns or ~12 KB) — narrow `sampleRows`/`maxRows`/`topN` or
select a sheet instead of asking for everything.

## Channels

- DeepSeek Harness: `mcp__sheet-toolkit__sheet_profile`,
  `mcp__sheet-toolkit__sheet_clean`, `mcp__sheet-toolkit__sheet_summary`.
- Other hosts: same server name and tool names.
- CLI fallback (any host with shell access):

```bash
node <plugin-root>/runtime/server.mjs --cli sheet_profile --json '{"path":"C:/data/report.xlsx"}'
node <plugin-root>/runtime/server.mjs --cli sheet_clean   --json '{"path":"C:/data/report.xlsx","sheet":"Sales"}'
node <plugin-root>/runtime/server.mjs --cli sheet_summary --json '{"path":"C:/data/report.xlsx","groupBy":"Region","values":["Revenue"]}'
```

## Rules

- No network, no uploads: the plugin only reads the `path` you pass it.
- Errors come back as `{"ok":false,"code":"INVALID_ARGS|NOT_FOUND",...}`; fix
  the argument or the path instead of retrying blindly.
- Do not paste whole previews into the answer; quote only the rows needed.
