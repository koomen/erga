#!/usr/bin/env bash
# Runs the tests, as fast as they'll go: test files run at the same time, and
# each prints its own block when it finishes.
#
#   ./test.sh         the page editor and multiplayer: unit tests, tests/page.ts,
#                     the multiplayer suite (what changes day to day)
#   ./test.sh md      the Markdown editor: parity with CodeMirror, styles, input
#   ./test.sh all     both
#   ./test.sh shots   regenerate screenshots/ (pictures, not a test)
#
# Not here, run by hand: tests/agent.ts (the real model, costs a little) and
# tests/suite/run.ts --long (bigger, slower, real idle-eviction waits).
set -euo pipefail
cd "$(dirname "$0")"
which="${1:-page}"
start=$(date +%s)
./build.sh >/dev/null

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
names=(); pids=()
run() { # run NAME CMD...: in the background, output to a file
  local name=$1; shift
  ( "$@" >"$tmp/$name.log" 2>&1; echo $? >"$tmp/$name.rc" ) &
  names+=("$name"); pids+=($!)
}

page_group() {
  run unit bun test tests/
  run page bun tests/page.ts
  # Latency is measured afterwards, alone: other tests running would skew it.
  run suite bun tests/suite/run.ts --skip latency
  collect
  run latency bun tests/suite/run.ts --suite latency
  collect
}
md_group() {
  # Each of these already spreads across several browsers; together they'd
  # swamp the machine (and CodeMirror's reference garbles input under load).
  run styles bun tests/styles.ts; collect
  run input bun tests/input.ts; collect
  run parity bun tests/parity.ts; collect
}
failed=()
collect() {
for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || true
  name=${names[$i]}
  rc=$(cat "$tmp/$name.rc" 2>/dev/null || echo 1)
  echo "=== $name $([[ $rc == 0 ]] && echo ok || echo FAILED)"
  # Passing lines are noise once it's green; show everything when it isn't.
  if [[ $rc == 0 ]]; then grep -vE "^(ok |MATCH|PASS|\s*$)" "$tmp/$name.log" | tail -5 || true; else cat "$tmp/$name.log"; failed+=("$name"); fi
done
names=(); pids=()
}
# Each group fills the machine on its own, so "all" runs them one after the other.
case "$which" in
  page) page_group ;;
  md) md_group ;;
  all) page_group; md_group ;;
  shots) run screenshots bun tests/screenshots.ts; collect ;;
  *) echo "usage: ./test.sh [page|md|all|shots]" >&2; exit 2 ;;
esac
echo
if [[ ${#failed[@]} == 0 ]]; then echo "all passing ($(( $(date +%s) - start ))s)"; else echo "FAILED: ${failed[*]} ($(( $(date +%s) - start ))s)"; exit 1; fi
