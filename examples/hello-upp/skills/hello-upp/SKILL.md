---
name: hello-upp
description: Verify that the cross-host UPP plugin works. Use when the user asks to test UPP, check plugin installation, or send a hello through this example plugin.
---

# Hello UPP

Probe whether this plugin's runtime is reachable on the current host.

## Steps

1. **DeepSeek Harness**: if a tool named `mcp__upp-hello__hello` exists, call it.
2. **WorkBuddy / Accio**: if an MCP tool named `hello` on server `upp-hello` exists, call it.
3. **Fallback (any host with a shell)**, run:
   `node <plugin-root>/runtime/server.mjs --cli hello --json '{"name":"<user name>"}'`

Report only the returned `ok`, `message` and `host` fields. Do not paste the whole JSON unless the user asks.

## If every step fails

Say: `UPP runtime missing, skill loaded — installation is partial.` and name the failed step.
