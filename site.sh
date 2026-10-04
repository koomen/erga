#!/usr/bin/env bash
# Gathers the editor's own files into .site/, the Worker's static assets:
# page.html (as editor.html: the Worker serves it under each document's
# address), page.js, style.css and the fonts. Each file is copied beside its
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
for f in page.js frame.js settings.js style.css fonts/*; do put "$f" "$f"; done
# Workers Builds runs this, then `bunx cf deploy`: bring erga.dev's directory
# database (D1) up to date with migrations/ first, making it if it's new.
# Only there (WORKERS_CI is set on Workers Builds); `bun run deploy` does it itself.
if [[ -n "${WORKERS_CI:-}" ]]; then bun migrate.ts; fi
# The release the deploy page (/deploy) deploys to other people's accounts: this build, into .site/release/
# (deploy/release.ts). Only for a deploy; one that fails leaves /deploy saying there's none, and the deploy goes on.
if [[ -n "${WORKERS_CI:-}" ]]; then bun deploy/release.ts || echo "site.sh: no release for /deploy (deploy/release.ts failed)" >&2; fi
