---
description: "Compose a one-paragraph status report for the current UPP plugin."
argument-hint: "[plugin id]"
---

Write a short status report for the UPP plugin `$ARGUMENTS`.

Use the `hello` tool once (MCP `mcp__upp-hello__hello`, or the CLI fallback) so the
report can state which channel and host answered. Then reply with:

1. One sentence on what the plugin does.
2. The channel/host that answered the probe.
3. One sentence on what a caller must do to install it elsewhere.

Keep it under 120 words. Do not invent tool output.
