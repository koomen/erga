#!/usr/bin/env bash
# Builds page.js (the page editor's shell, from src/page/) as a classic script
# that page.html loads, frame.js (the editor itself, which runs on each
# document's own origin) and pages-tree.js (a document's pages, loaded on demand). Usage: ./build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
# Each written beside its place and renamed into it, so a server never serves half of one.
bun build src/page/main.ts --format iife --minify --outfile ".page.js.$$" \
  --banner "/* Built by build.sh from src/page/. Erga page editor. */"
mv -f ".page.js.$$" page.js
# The page editor's frame, on each document's own origin (src/page/bridge.ts).
bun build src/page/frame.ts --format iife --minify --outfile ".frame.js.$$" \
  --banner "/* Built by build.sh from src/page/. Erga page editor, the frame. */"
mv -f ".frame.js.$$" frame.js
# The pages tree (src/page/tree.ts): loaded only when someone opens it, in the editor or on Documents, so viewing never pays for it.
bun build src/page/tree.ts --format iife --minify --outfile ".pages-tree.js.$$" \
  --banner "/* Built by build.sh from src/page/. Erga page editor, the pages tree. */"
mv -f ".pages-tree.js.$$" pages-tree.js
echo "built page.js ($(wc -c < page.js | tr -d " ") bytes), frame.js ($(wc -c < frame.js | tr -d " ") bytes), pages-tree.js ($(wc -c < pages-tree.js | tr -d " ") bytes)"
