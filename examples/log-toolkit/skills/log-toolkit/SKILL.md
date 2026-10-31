---
name: log-toolkit
description: Local logs: scan, grep, read windows.
---

# Log Toolkit

Three local tools over one log file. Streaming happens inside the plugin, so you
pay for a summary or a bounded window instead of the whole file.

| Tool | Use it for |
| --- | --- |
| `log_scan` | Level counts, first/last timestamp, top repeated messages. |
| `log_grep` | Locate lines by regex or literal text, with line numbers and context. |
| `log_window` | Read an exact 1-based line window; also reports the total line count. |

## Order of work

1. **`log_scan` first.** Answer with `levelCounts`, `firstTs`/`lastTs` and the top
   `topMessages`; do not dump lines yet. `tail: true` (default) analyzes the newest
   lines, `tail: false` the first lines.
2. **`log_grep`** with a specific `pattern` to find where the problem lines are.
   Metacharacters follow JavaScript regex syntax; this is a regex search by default.
3. **`log_window`** around a match when the surrounding entry matters
   (`startLine`, `maxLines`).

## Channels

- DeepSeek Harness: `mcp__log-toolkit__log_scan`, `...__log_grep`, `...__log_window`.
- Other hosts: server `log-toolkit`, same tool names.
- CLI fallback (any host with shell access):

```bash
node <plugin-root>/runtime/server.mjs --cli log_scan  --json '{"path":"C:/logs/app.log"}'
node <plugin-root>/runtime/server.mjs --cli log_grep  --json '{"path":"C:/logs/app.log","pattern":"timeout","contextLines":2,"maxMatches":20}'
node <plugin-root>/runtime/server.mjs --cli log_window --json '{"path":"C:/logs/app.log","startLine":120,"maxLines":30}'
```

## Rules

- Files are read on this machine only: no network permission.
- Lines are truncated to 2000 characters and one answer stays under ~16 KB, so ask
  for a window instead of the whole file.
- `truncated: true` means matches were cut by `maxMatches` or by the size cap; narrow
  the pattern or page with `maxMatches`/`tail`.
- Quote only the lines that answer the question; never paste an entire window.
