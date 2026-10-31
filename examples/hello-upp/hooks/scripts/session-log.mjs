#!/usr/bin/env node
// UPP observe hook (session-log on SessionStart). Always exit 0, never writes stdout.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const dir = process.env.CODEBUDDY_PLUGIN_DATA || process.env.TMPDIR || '.';
    const file = join(dir, 'upp-hooks.log');
    mkdirSync(dirname(file), { recursive: true });
    const line = { hook: "session-log", event: "SessionStart", at: new Date().toISOString(), bytes: input.length };
    appendFileSync(file, JSON.stringify(line) + "\n");
  } catch {
    // observe-only hooks must never break the host
  }
  process.exit(0);
});
setTimeout(() => process.exit(0), 2000).unref();
