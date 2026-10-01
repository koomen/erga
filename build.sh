#!/usr/bin/env bash
# Builds page.js (the page editor, from src/page/) as a classic script that
# page.html loads. Usage: ./build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
bun build src/page/main.ts --format iife --minify --outfile page.js \
  --banner "/* Built by build.sh from src/page/. Erga page editor. */"
echo "built page.js ($(wc -c < page.js | tr -d " ") bytes)"
