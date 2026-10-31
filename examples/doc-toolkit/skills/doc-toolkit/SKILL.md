---
name: doc-toolkit
description: Inspect local documents and spreadsheets cheaply. Use when the user points at a .docx/.xlsx/.csv/.md/.txt/.html file and asks what is inside, to summarize it, or to find data in it.
---

# Doc Toolkit

Two local tools: `digest` (facts + sample, ~1 KB) and `extract` (bounded window).

## Use it in this order

1. **Always `digest` first.** It returns structure (headings / sheets / columns), sizes and a small sample. Report only those facts; do not dump the file.
2. Call **`extract`** with `start`/`maxChars` or `startRow`/`maxRows` only for the part the user actually asked about.
3. If `nextStart` / `nextStartRow` is present, you may continue in the next window. Stop as soon as the question is answered.

## Channels

- DeepSeek Harness: `mcp__doc-toolkit__digest` / `mcp__doc-toolkit__extract`.
- Other hosts: call server `doc-toolkit`, same tool names.
- CLI fallback (any host with shell access):

```bash
node <plugin-root>/runtime/server.mjs --cli digest  --json '{"path":"C:/path/report.xlsx"}'
node <plugin-root>/runtime/server.mjs --cli extract --json '{"path":"C:/path/report.xlsx","startRow":1,"maxRows":20}'
```

## Rules

- Everything runs locally; the plugin has no network permission. Never upload the file.
- Do not paste whole extracted windows into the answer; quote the needed rows/lines only.
- Report `digestBytes` when the user asks how much context this cost.
