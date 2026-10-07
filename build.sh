#!/usr/bin/env bash
# Builds page.js (the page editor's shell, from src/page/) as a classic script
# that page.html loads, frame.js (the editor itself, which runs on each
# document's own origin), settings.js (document settings) and pages-tree.js (a
# document's pages), both loaded on demand, factory-agent.js (the agent
# panel on /admin/factory), admin-share.js (Share with an agent, on every
# admin page), admin-nav.js (the admin pages as one page) and live.js (on
# every page of the site's own: it follows a redeploy). Usage: ./build.sh
#
# Each bundle ends with its build id (`stamp`): the first 16 hex digits of the
# SHA-256 of what comes before it. site.sh lists them in .site/build.json, so
# a page knows which build of each bundle it runs, and sees when the server
# has another (README, Redeploys and open pages).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-16; }
# bundle ENTRY NAME BANNER: built beside its place, stamped, and renamed into it, so a server never serves half of one.
bundle() {
  bun build "$1" --format iife --minify --outfile ".$2.$$" --banner "/* Built by build.sh from src/page/. $3 */"
  printf '\n;(self.ergaBuilt=self.ergaBuilt||{})["%s"]="%s";\n' "$2" "$(sha ".$2.$$")" >> ".$2.$$"
  mv -f ".$2.$$" "$2"
}
bundle src/page/main.ts page.js "Erga page editor."
# The page editor's frame, on each document's own origin (src/page/bridge.ts).
bundle src/page/frame.ts frame.js "Erga page editor, the frame."
# Document settings (src/page/settings.ts): loaded by page.js only when the gear is reached for.
bundle src/page/settings.ts settings.js "Erga page editor, document settings."
echo "built settings.js ($(wc -c < settings.js | tr -d " ") bytes)"
# The pages tree (src/page/tree.ts): loaded only when someone opens it, in the editor or on Documents, so viewing never pays for it.
bundle src/page/tree.ts pages-tree.js "Erga page editor, the pages tree."
# The factory's agent panel on /admin/factory (src/page/factory-agent.ts): the editor's agent panel, for factory tasks.
bundle src/page/factory-agent.ts factory-agent.js "Erga, the factory's agent panel."
# Share with an agent, in the header of every admin page (src/page/admin-share.ts, admin-layout.ts).
bundle src/page/admin-share.ts admin-share.js "Erga, Share with an agent on the admin pages."
# The admin area as one page (src/page/admin-nav.ts, admin-layout.ts): a link to another admin page changes only the page, so the agent panel stays.
bundle src/page/admin-nav.ts admin-nav.js "Erga, the admin pages as one page."
# A redeploy under an open page (src/page/live.ts): the Worker adds it to every page of the site's own (worker/live.ts).
bundle src/page/live.ts live.js "Erga, open pages across a redeploy."
echo "built page.js ($(wc -c < page.js | tr -d " ") bytes), frame.js ($(wc -c < frame.js | tr -d " ") bytes), pages-tree.js ($(wc -c < pages-tree.js | tr -d " ") bytes)"
