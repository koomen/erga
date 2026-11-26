#!/bin/sh
# Antigravity's hooks: erga-agent's answer, or, when erga-agent can't run, an answer that changes nothing.
DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
IN="$(cat)"
printf '%s' "$IN" | sh "$DIR/bin/erga-agent" hook --agent antigravity && exit 0
case "$IN" in
  *'"PreToolUse"'*) echo '{"decision":"allow"}' ;;
  *) echo '{}' ;;
esac
