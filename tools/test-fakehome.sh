#!/usr/bin/env bash
# End-to-end import / rollback test against a FAKE home — never touches real hosts.
set -u
cd "$(dirname "$0")/.." || exit 1

T="H:/Administrator/Documents/deepseek-harness/default-workspace/uppenv-test/fakehome"
IMG="../uppenv-test/env-full.uppenv"

rm -rf "$T"
mkdir -p "$T/.workbuddy/skills" "$T/.codebuddy" "$T/.dsh/profiles/desktop" "$T/.accio/accounts/1/skills"

export USERPROFILE="$T"
export HOME="$T"
export DSH_HOME="$T/.dsh"
export UPPENV_HOME="$T/.uppenv"

echo "=== import (fake home) ==="
node tools/uppenv.mjs import "$IMG" --host workbuddy --kind skill,mcp,tool,memory --yes 2>&1 | tail -18
echo "import exit: $?"

echo "=== files created under fake home ==="
find "$T" -type f | sed "s|$T|<FAKE>|" | sort | head -40
echo "file count: $(find "$T" -type f | wc -l)"

echo "=== mcp config content ==="
cat "$T/.codebuddy/mcp.json" 2>/dev/null || echo "(no mcp.json)"

echo
echo "=== rollback ==="
node tools/uppenv.mjs rollback --last 2>&1 | tail -8
echo "rollback exit: $?"
echo "file count after rollback: $(find "$T" -type f | wc -l)"
find "$T" -type f | sed "s|$T|<FAKE>|" | sort | head -20
