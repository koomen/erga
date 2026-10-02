#!/usr/bin/env bash
# Runs the tests, as fast as they'll go: test files run at the same time, and
# each prints its own block when it finishes.
#
#   ./test.sh         unit tests, tests/page.ts, the front door's routes
#                     (tests/worker.ts, on the local host) and the multiplayer suite
#
# Not here, run by hand: tests/agent.ts (the real model, costs a little) and
# tests/suite/run.ts --long (bigger, slower, real idle-eviction waits).
set -euo pipefail
cd "$(dirname "$0")"
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
  run front bun tests/worker.ts --local
  # Latency is measured afterwards, alone: other tests running would skew it.
  run suite bun tests/suite/run.ts --skip latency
  collect
  run latency bun tests/suite/run.ts --suite latency
  collect
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
if [[ $# -gt 0 ]]; then echo "usage: ./test.sh" >&2; exit 2; fi
page_group
echo
if [[ ${#failed[@]} == 0 ]]; then echo "all passing ($(( $(date +%s) - start ))s)"; else echo "FAILED: ${failed[*]} ($(( $(date +%s) - start ))s)"; exit 1; fi
