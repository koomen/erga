#!/usr/bin/env bash
# Builds page.js (the page editor's shell, from src/page/) as a classic script
# that page.html loads, and frame.js (the editor itself, which runs on each
# document's own origin). Usage: ./build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
bun build src/page/main.ts --format iife --minify --outfile page.js \
  --banner "/* Built by build.sh from src/page/. Erga page editor. */"
# The page editor's frame, on each document's own origin (src/page/bridge.ts).
bun build src/page/frame.ts --format iife --minify --outfile frame.js \
  --banner "/* Built by build.sh from src/page/. Erga page editor, the frame. */"
echo "built page.js ($(wc -c < page.js | tr -d " ") bytes), frame.js ($(wc -c < frame.js | tr -d " ") bytes)"
