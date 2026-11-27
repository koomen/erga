#!/bin/sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -x "$HOME/.erga/bin/erga-agent" ]; then
  exec "$HOME/.erga/bin/erga-agent" mcp "$@"
fi
if [ -x "$DIR/bin/erga-agent" ]; then
  exec "$DIR/bin/erga-agent" mcp "$@"
fi
if command -v erga-agent >/dev/null 2>&1; then
  exec erga-agent mcp "$@"
fi
if [ -f "$DIR/../../core/cli.ts" ] && command -v bun >/dev/null 2>&1; then
  exec bun "$DIR/../../core/cli.ts" mcp "$@"
fi
echo "erga-agent not found. Install from <erga-origin>/plugin/install.sh or build with: bun bridge/build.ts" >&2
exit 1
