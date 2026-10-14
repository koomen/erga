#!/usr/bin/env bash
# Builds the client: everything the Worker serves as static assets, into
# .build/ at the repo's root (gitignored). Usage: client/build.sh (or bun run build)
#
#   page.js          the page editor's shell (main.ts), a classic script editor.html loads
#   frame.js         the editor itself (frame.ts), which runs on each document's own origin
#   settings.js      document settings (settings.ts), loaded when the gear is reached for
#   pages-tree.js    a document's pages (pages-tree.ts), loaded when someone opens the tree
#   admin-agent.js   the admin's agent panel (admin-agent.ts), on every admin page
#   admin-share.js   Share with an agent (admin-share.ts), on every admin page
#   admin-nav.js     the admin pages as one page (admin-nav.ts)
#   live.js          open pages across a redeploy (live.ts), on every page of the site's own
#   editor.html      the editor's page, served under each document's address
#   style.css, fonts/
#   logo.png         Erga's logo (assets/logo/logo.png), public at /logo.png: a square 512 px PNG for
#                    places that want one (an OAuth client's logo)
#   build.json       the build id of each file: a bundle's own stamp, else the first 16 hex
#                    digits of its SHA-256. The Worker answers GET /api/release with it.
#
# Each bundle ends with its build id (`stamp`): the first 16 hex digits of the
# SHA-256 of what comes before it, so a page knows which build of each bundle
# it runs, and sees when the server has another (live.ts).
#
# Each file is built or copied beside its place and renamed into it, so a
# server never serves half of one, even with two builds at once.
set -euo pipefail
cd "$(dirname "$0")/.."
# The server settings the deploy locks (deploy/locked-settings.ts): a bad one stops the build here.
bun deploy/locked-settings.ts >/dev/null
out=.build
mkdir -p "$out/fonts"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-16; }
# bundle ENTRY NAME BANNER
bundle() {
  local tmp="$out/.$2.$$"
  bun build "client/$1" --format iife --minify --outfile "$tmp" --banner "/* Built by client/build.sh from client/$1. $3 */"
  printf '\n;(self.ergaBuilt=self.ergaBuilt||{})["%s"]="%s";\n' "$2" "$(sha "$tmp")" >> "$tmp"
  mv -f "$tmp" "$out/$2"
}
bundle main.ts page.js "Erga page editor."
bundle frame.ts frame.js "Erga page editor, the frame."
bundle settings.ts settings.js "Erga page editor, document settings."
bundle pages-tree.ts pages-tree.js "Erga page editor, the pages tree."
bundle admin-agent.ts admin-agent.js "Erga, the admin's agent panel."
bundle admin-share.ts admin-share.js "Erga, Share with an agent on the admin pages."
bundle admin-nav.ts admin-nav.js "Erga, the admin pages as one page."
bundle live.ts live.js "Erga, open pages across a redeploy."
# put SOURCE NAME: copied beside its place in .build/ and renamed into it.
put() { local tmp; tmp="$(dirname "$out/$2")/.$(basename "$2").$$"; cp "$1" "$tmp" && mv -f "$tmp" "$out/$2"; }
put client/editor.html editor.html
put client/style.css style.css
put assets/logo/logo.png logo.png
for f in client/fonts/*; do put "$f" "fonts/$(basename "$f")"; done
bundles="page.js frame.js settings.js pages-tree.js admin-agent.js admin-share.js admin-nav.js live.js"
manifest="{"
for f in $bundles; do manifest+="\"$f\":\"$(sed -n 's/^;(self.ergaBuilt=self.ergaBuilt||{})\["[^"]*"\]="\([0-9a-f]*\)";$/\1/p' "$out/$f" | tail -1)\","; done
manifest+="\"style.css\":\"$(sha client/style.css)\",\"editor.html\":\"$(sha client/editor.html)\"}"
tmp="$out/.build.json.$$"; printf '%s\n' "$manifest" > "$tmp" && mv -f "$tmp" "$out/build.json"
echo "built page.js ($(wc -c < $out/page.js | tr -d " ") bytes), frame.js ($(wc -c < $out/frame.js | tr -d " ") bytes), pages-tree.js ($(wc -c < $out/pages-tree.js | tr -d " ") bytes), settings.js ($(wc -c < $out/settings.js | tr -d " ") bytes)"
