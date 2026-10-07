#!/usr/bin/env bash
# Gathers the editor's own files into .site/, the Worker's static assets:
# page.html (as editor.html: the Worker serves it under each document's
# address), page.js, factory-agent.js (/admin/factory's agent panel), admin-share.js (the admin pages' Share with agent), admin-nav.js (the admin pages as one page), live.js (every page, across a redeploy), style.css and the fonts. Each file is copied beside its
# place and renamed into it, so the dev server never serves a half-written
# one, even with two builds at once.
#
# And build.json: the build id of each of those files (a bundle's own stamp,
# build.sh; for the others, the first 16 hex digits of their SHA-256), which
# the Worker answers GET /api/release with (worker/live.ts).
set -euo pipefail
cd "$(dirname "$0")"
# The server settings the deploy fixes (server.config.ts, ERGA_SERVER_CONFIG): a bad one stops the deploy here.
bun server.config.ts >/dev/null
./build.sh
mkdir -p .site/fonts
put() { local tmp; tmp="$(dirname ".site/$2")/.$(basename "$2").$$"; cp "$1" "$tmp" && mv -f "$tmp" ".site/$2"; }
put page.html editor.html
bundles="page.js frame.js settings.js pages-tree.js factory-agent.js admin-share.js admin-nav.js live.js"
for f in $bundles style.css fonts/*; do put "$f" "$f"; done
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-16; }
manifest="{"
for f in $bundles; do manifest+="\"$f\":\"$(sed -n 's/^;(self.ergaBuilt=self.ergaBuilt||{})\["[^"]*"\]="\([0-9a-f]*\)";$/\1/p' "$f" | tail -1)\","; done
manifest+="\"style.css\":\"$(sha style.css)\",\"editor.html\":\"$(sha page.html)\"}"
tmp=".site/.build.json.$$"; printf '%s\n' "$manifest" > "$tmp" && mv -f "$tmp" .site/build.json
