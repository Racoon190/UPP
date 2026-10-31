#!/usr/bin/env bash
# Local equivalent of .github/workflows/ci.yml. Zero dependencies beyond Node 18+.
set -euo pipefail
cd "$(dirname "$0")/.."
node --check tools/upp.mjs
node --check tests/run-all.mjs
node --check tests/import.test.mjs
node tests/run-all.mjs
