#!/bin/sh
# erga-agent: Erga's agent bridge (erga-agent.js, in the plugin's folder), run with Bun: the one on PATH, Bun's own
# install, or Bun through npx. Its Erga server is the instance that served this plugin, unless ERGA_SERVER names another.
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export ERGA_SERVER="${ERGA_SERVER:-__ERGA_SERVER__}"
if command -v bun >/dev/null 2>&1; then exec bun "$ROOT/erga-agent.js" "$@"; fi
if [ -x "$HOME/.bun/bin/bun" ]; then exec "$HOME/.bun/bin/bun" "$ROOT/erga-agent.js" "$@"; fi
if command -v npx >/dev/null 2>&1; then exec npx --yes bun "$ROOT/erga-agent.js" "$@"; fi
echo "erga-agent needs Bun (https://bun.sh) or Node.js (npx). Install one, then start your agent again." >&2
exit 1
