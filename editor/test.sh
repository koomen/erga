#!/usr/bin/env bash
# Runs every test: unit tests (parser and change sets vs. CodeMirror's), then
# the browser suites (headless Chrome): behavior parity, visual parity, input
# paths, and side-by-side screenshots. Usage: ./test.sh
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
bun test tests/
bun tests/parity.ts
bun tests/styles.ts
bun tests/input.ts
bun tests/screenshots.ts
