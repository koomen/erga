#!/usr/bin/env bash
# Gathers the editor's own files into .site/, the Worker's static assets:
# page.html (as editor.html: the Worker serves it under each document's
# address), page.js, factory-agent.js (/admin/source's agent panel), style.css and the fonts. Each file is copied beside its
# place and renamed into it, so the dev server never serves a half-written
# one, even with two builds at once.
set -euo pipefail
cd "$(dirname "$0")"
# The server settings the deploy fixes (server.config.ts, ERGA_SERVER_CONFIG): a bad one stops the deploy here.
bun server.config.ts >/dev/null
./build.sh
mkdir -p .site/fonts
put() { local tmp; tmp="$(dirname ".site/$2")/.$(basename "$2").$$"; cp "$1" "$tmp" && mv -f "$tmp" ".site/$2"; }
put page.html editor.html
for f in page.js frame.js settings.js pages-tree.js factory-agent.js style.css fonts/*; do put "$f" "$f"; done
