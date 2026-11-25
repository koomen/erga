#!/bin/sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -x "$DIR/bin/erga-agent" ]; then
  exec "$DIR/bin/erga-agent" mcp --agent antigravity "$@"
fi
if command -v erga-agent >/dev/null 2>&1; then
  exec erga-agent mcp --agent antigravity "$@"
fi
if [ -x "$HOME/.local/bin/erga-agent" ]; then
  exec "$HOME/.local/bin/erga-agent" mcp --agent antigravity "$@"
fi
if [ -f "$DIR/../../core/cli.ts" ] && command -v bun >/dev/null 2>&1; then
  exec bun "$DIR/../../core/cli.ts" mcp --agent antigravity "$@"
fi
echo "erga-agent binary not found. Build with: bun bridge/build.ts" >&2
exit 1
