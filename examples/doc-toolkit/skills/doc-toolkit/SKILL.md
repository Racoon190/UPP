---
name: doc-toolkit
description: Inspect local documents and spreadsheets cheaply. Use when the user points at a .docx/.xlsx/.pptx/.pdf/.csv/.md/.txt/.html file and asks what is inside, to summarize it, or to find data in it.
---

# Doc Toolkit

Two local tools: `digest` (facts + sample, ~1 KB) and `extract` (bounded window).

Supported: `.docx .xlsx .pptx .pdf .csv .md .txt .html` (+ `.log/.json/.yaml` as text).
PDF support is a text-layer parser: scanned PDFs return `hasTextLayer:false` and no text (OCR is out of scope).
PPTX is slide text: `digest` lists slide titles, `extract` takes `startRow` = first slide (0-based) and `maxRows` = slide count.

## Use it in this order

1. **Always `digest` first.** It returns structure (headings / sheets / slides / pages / columns), sizes and a small sample. Report only those facts; do not dump the file.
2. Call **`extract`** with `start`/`maxChars` (text-like: docx, pdf, md, txt, html) or `startRow`/`maxRows` (csv/xlsx rows, pptx slides) only for the part the user actually asked about.
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
