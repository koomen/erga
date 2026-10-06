#!/usr/bin/env bash
# Runs the tests, as fast as they'll go: test files run several at a time (a
# pool, one per two usable cores by default, tests/cores.ts; TEST_JOBS=n
# picks it, TEST_CORES_PER_JOB=c tunes it), the longest
# first, and each prints its own block, with its time, when it finishes. More
# at once only slows each one down, and their timing checks with it.
#
#   ./test.sh         unit tests, tests/page.ts, a page trying to reach its
#                     viewer (tests/isolation.ts), the front door's routes
#                     (tests/worker.ts), documents with many pages (tests/pages.ts), the front page the server makes (tests/landing.ts),
#                     the homepage served directly and its deploys (tests/home.ts),
#                     the deploy page against a pretend Cloudflare (tests/deploy.ts),
#                     Erga's own source: the Git endpoint, merges, the mirror and the Source page (tests/source.ts),
#                     branches deploying themselves, in the Worker (tests/deploys.ts),
#                     who you are in every page's corner (tests/account.ts),
#                     the + button and its picker of templates (tests/new-doc.ts),
#                     admin SSH keys and unlocking admin access with them (tests/admin-keys.ts),
#                     admin power for a signed-in admin while keys aren't required (tests/admin-open.ts),
#                     the admin pages' layout, and who may reach them (tests/admin-layout.ts),
#                     the viewer's controls fading while you read (tests/fade.ts),
#                     a presentation's steps, viewing and editing (tests/steps.ts),
#                     the Slides template, stepped through viewing and editing (tests/slides.ts),
#                     the Canvas presentation template, zooming between frames (tests/canvas-template.ts),
#                     the Solar system tour template, viewing and editing (tests/solar-system.ts),
#                     a document's pages tree (tests/tree.ts),
#                     the first switch into editing on a slow network (tests/switch.ts),
#                     the band the top controls sit on (tests/band.ts),
#                     versions and publishing (tests/versions.ts),
#                     document settings (tests/settings.ts),
#                     what the agent's view_page sees: fonts, size, light or dark (tests/view-page.ts),
#                     the factory, with simulated VMs (tests/factory.ts),
#                     the factory board's compact cards (tests/factory-cards.ts),
#                     instructions for a working task (tests/factory-instruct.ts),
#                     live reload (tests/reload.ts, in a copy of the checkout)
#                     and the multiplayer suite, each
#                     against dev servers of its own (tests/host.ts)
#
# Not here, run by hand: tests/agent.ts (the real model, costs a little)
# and tests/suite/run.ts --long (bigger, slower, real idle-eviction waits).
set -euo pipefail
cd "$(dirname "$0")"
start=$(date +%s)
if [[ $# -gt 0 ]]; then echo "usage: ./test.sh   (TEST_JOBS=n: how many slots at once; TEST_CORES_PER_JOB=c: one per c cores, default 2; tests/cores.ts)" >&2; exit 2; fi
# The editor's files, once, for every dev server the tests start.
./site.sh >/dev/null
export ERGA_BUILT=1

# How many at once: tests/cores.ts (the cgroup's CPU quota in a container, memory; TEST_JOBS, TEST_CORES_PER_JOB).
read -r jobs cpus why <<<"$(bun tests/cores.ts)"
tmp=$(mktemp -d)
names=(); weights=(); used=0; failed=()
# Stopped half-way (Ctrl-C, a timeout): the tests still running go too; each one's hosts go with it (tests/host.ts).
trap 'for j in $(jobs -p); do pkill -TERM -P "$j" 2>/dev/null || true; done; wait 2>/dev/null || true; rm -rf "$tmp"' EXIT

report() { # report NAME: its block, all of it when it failed
  local name=$1 rc
  rc=$(cat "$tmp/$name.rc")
  echo "=== $name $([[ $rc == 0 ]] && echo ok || echo FAILED) ($(cat "$tmp/$name.time")s)"
  # Passing lines are noise once it's green; show everything when it isn't.
  if [[ $rc == 0 ]]; then grep -vE "^(ok |MATCH|PASS|\s*$)" "$tmp/$name.log" | tail -5 || true; else cat "$tmp/$name.log"; failed+=("$name"); fi
}
reap() { # reports the tests that have finished, and frees their slots
  local i keep_n=() keep_w=()
  for i in "${!names[@]}"; do
    if [[ -e "$tmp/${names[$i]}.time" ]]; then report "${names[$i]}"; used=$(( used - weights[i] ))
    else keep_n+=("${names[$i]}"); keep_w+=("${weights[$i]}"); fi
  done
  names=(${keep_n[@]+"${keep_n[@]}"}); weights=(${keep_w[@]+"${keep_w[@]}"})
}
run() { # run WEIGHT NAME CMD...: in the background once WEIGHT slots are free (or nothing else runs), output to a file
  local weight=$1 name=$2; shift 2
  while (( used > 0 && used + weight > jobs )); do sleep 0.2; reap; done
  ( t0=$(date +%s); rc=0; "$@" >"$tmp/$name.log" 2>&1 || rc=$?; echo $rc >"$tmp/$name.rc"; echo $(( $(date +%s) - t0 )) >"$tmp/$name.time" ) &
  names+=("$name"); weights+=("$weight"); used=$(( used + weight ))
}
collect() { # waits for everything running
  while (( ${#names[@]} > 0 )); do sleep 0.2; reap; done
}

echo "$jobs slots: $why"
# Longest first (seconds each takes alone on a Mac, in brackets), so the pool ends together. A weight over 1: a file
# that runs many servers at once itself (tests/page.ts's scenarios; the multiplayer suite runs a test per CPU).
# The factory (experimental), with simulated VMs; `bun tests/factory.ts --docker` runs real containers, by hand.
run 2 factory bun tests/factory.ts                       # [57]
run 1 tree bun tests/tree.ts                             # [36]
run 1 source bun tests/source.ts                         # [29]
run 1 home bun tests/home.ts                             # [29]
run 3 page bun tests/page.ts                             # [27]
run 1 account bun tests/account.ts                       # [26]
run 1 settings bun tests/settings.ts                     # [25]
run 3 suite bun tests/suite/run.ts --skip latency        # [22]
run 1 fade bun tests/fade.ts                             # [20]
run 1 front bun tests/worker.ts --local                  # [19]
run 1 band bun tests/band.ts                             # [18]
run 1 new-doc bun tests/new-doc.ts                       # [15]
run 1 steps bun tests/steps.ts                           # [15]
run 1 slides bun tests/slides.ts                         # [15]
run 1 canvas bun tests/canvas-template.ts                # [12]
run 1 solar-system bun tests/solar-system.ts             # [15]
run 1 pages bun tests/pages.ts                           # [17]
run 1 switch bun tests/switch.ts                         # [17]
run 1 deploy bun tests/deploy.ts                         # [16]
run 1 admin-keys bun tests/admin-keys.ts                 # [16]
run 1 landing bun tests/landing.ts                       # [14]
run 1 factory-cards bun tests/factory-cards.ts           # [14]
run 1 factory-instruct bun tests/factory-instruct.ts     # [70]
run 1 versions bun tests/versions.ts                     # [13]
run 2 unit bun test ./tests/                             # [11]
run 1 deployed bun tests/server-config.ts                # [7]
run 1 deploys bun tests/deploys.ts                       # [5]
run 1 isolation bun tests/isolation.ts                   # [4]
run 1 admin-open bun tests/admin-open.ts                 # [3]
run 1 admin-layout bun tests/admin-layout.ts             # [8]
run 1 view-page bun tests/view-page.ts                   # [9]
collect
# Latency is measured alone: other tests running would skew it.
run 1 latency bun tests/suite/run.ts --suite latency     # [6]
collect
# Live reload alone too: it edits files and waits on rebuilds, which a busy machine slows.
run 1 reload bun tests/reload.ts                         # [14]
collect

echo
if [[ ${#failed[@]} == 0 ]]; then echo "all passing ($(( $(date +%s) - start ))s)"; else echo "FAILED: ${failed[*]} ($(( $(date +%s) - start ))s)"; exit 1; fi
