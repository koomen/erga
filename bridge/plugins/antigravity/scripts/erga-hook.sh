#!/bin/sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -x "$DIR/bin/erga-agent" ]; then
  exec "$DIR/bin/erga-agent" hook --agent antigravity
fi
if command -v erga-agent >/dev/null 2>&1; then
  exec erga-agent hook --agent antigravity
fi
if [ -x "$HOME/.local/bin/erga-agent" ]; then
  exec "$HOME/.local/bin/erga-agent" hook --agent antigravity
fi
if [ -f "$DIR/../../core/cli.ts" ] && command -v bun >/dev/null 2>&1; then
  exec bun "$DIR/../../core/cli.ts" hook --agent antigravity
fi
if grep -q '"PreToolUse"'; then
  echo '{"decision":"allow"}'
else
  echo "{}"
fi
