#!/usr/bin/env bash
# Gathers the editor's own files into .site/, the Worker's static assets:
# page.html (as editor.html: the Worker serves it under each document's
# address), page.js, style.css and the fonts.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
rm -rf .site && mkdir -p .site
cp page.html .site/editor.html
cp -r page.js frame.js style.css fonts .site/
# Workers Builds runs this, then `bunx cf deploy`: bring erga.dev's directory
# database (D1) up to date with migrations/ first, making it if it's new.
# Only there (WORKERS_CI is set on Workers Builds); `bun run deploy` does it itself.
if [[ -n "${WORKERS_CI:-}" ]]; then bun migrate.ts; fi
