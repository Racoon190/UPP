#!/bin/sh
# UPP one-click bootstrap for macOS / Linux: sh install.sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[X] Node.js not found. Install Node.js 20 LTS or newer first: https://nodejs.org/"
  exit 1
fi
node -e "const m=+process.versions.node.split('.')[0]; if (m<20) { console.error('Node '+process.versions.node+' is too old, need >= 20'); process.exit(1) }"

echo "[1/3] Installing the global command \`upp\` ..."
node tools/upp.mjs setup-cli || {
  echo "[X] setup-cli failed. See the JSON above."
  exit 1
}

echo
echo "[2/3] Self-check ..."
node tools/upp.mjs doctor || true

echo
echo "[3/3] Done. Open a NEW terminal and try:"
echo "  upp --version"
echo '  upp mem add "我的偏好：用中文回答" --kind preference --key user.language'
echo "  upp mem sync --host dsh,workbuddy,accio --both"
echo "  upp init my-plugin"
echo
echo "Docs: docs/19-quickstart.md"
