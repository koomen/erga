#!/usr/bin/env bash
# Builds editor.js (the editor, from src/) as a classic script that index.html
# loads straight from file://. Usage: ./build.sh  (add --vendor to also rebuild
# vendor/vendor.js, which needs network access for npm).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
if [[ "${1:-}" == "--vendor" ]]; then ./vendor/build.sh; fi
bun build src/app.ts --format iife --minify --outfile editor.js \
  --banner "/* Built by build.sh from src/. Scratchwork editor concept. */"
echo "built editor.js ($(wc -c < editor.js | tr -d " ") bytes)"
bun build src/page/main.ts --format iife --minify --outfile page.js \
  --banner "/* Built by build.sh from src/page/. Scratchwork page editor concept. */"
echo "built page.js ($(wc -c < page.js | tr -d " ") bytes)"
