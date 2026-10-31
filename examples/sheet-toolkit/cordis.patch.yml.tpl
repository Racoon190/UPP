# UPP host adapter template: DeepSeek Harness (config-only MCP bundle).
# `upp build` substitutes the placeholders below and writes this file to
# cordis.patch.yml; install it through the profile manager, never by hand.
# Placeholders (do not inline real paths here):
#   __UPP_SERVER_NAME__  -> hosts.dsh.serverName (also the public tool prefix)
#   __UPP_RUNTIME_ENTRY__-> absolute path of runtime/server.mjs
- insert:
    - id: __UPP_SERVER_NAME__-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: __UPP_SERVER_NAME__
        transport: stdio
        command: node
        args: ['__UPP_RUNTIME_ENTRY__']
        env:
          UPP_HOST: dsh
        failOnStartupError: false
        toolCallTimeoutMs: 60000
