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
#                     staging for admins only, and what stays open (tests/staging-admins.ts),
#                     who you are in every page's corner (tests/account.ts),
#                     the + button and its picker of templates (tests/new-doc.ts),
#                     scoped tokens: /tokens, each scope, expiry, the device flow and git push (tests/scoped-tokens.ts),
#                     the admin pages' layout, and who may reach them (tests/admin-layout.ts),
#                     the admin pages as one page, the agent panel staying across them (tests/admin-nav.ts),
#                     the viewer's controls fading while you read (tests/fade.ts),
#                     a presentation's steps, viewing and editing (tests/steps.ts),
#                     the Slides template, stepped through viewing and editing (tests/slides.ts),
#                     the Canvas presentation template, zooming between frames (tests/canvas-template.ts),
#                     the Solar system tour template, viewing and editing (tests/solar-system.ts),
#                     a document's pages tree (tests/tree.ts),
#                     opening and closing a document's pages on Documents (tests/docs-pages.ts),
#                     the editor's pages card opening at once the first time (tests/pages-open.ts),
#                     the first switch into editing on a slow network (tests/switch.ts),
#                     the band the top controls sit on (tests/band.ts),
#                     versions and publishing (tests/versions.ts),
#                     document settings (tests/settings.ts),
#                     what the agent's view_page sees: fonts, size, light or dark (tests/view-page.ts),
#                     the factory, with simulated VMs (tests/factory.ts),
#                     the factory board's compact cards (tests/factory-cards.ts),
#                     the chime when a task or the agent needs the admin (tests/factory-chime.ts),
#                     files attached in the agent panel (tests/attach.ts),
#                     instructions for a working task (tests/factory-instruct.ts),
#                     who the factory's commits are by (tests/factory-authors.ts),
#                     the factory across a reset of its Durable Object, and at Claude Code's limits (tests/factory-reset.ts),
#                     the admin agent reading Erga's own source, in the Worker (tests/admin-agent-source.ts),
#                     the agents doing what their person does on the page, in the Worker (tests/admin-agent-actions.ts),
#                     live reload (tests/reload.ts, in a copy of the checkout),
#                     two checkouts' dev servers at once, sharing nothing (tests/checkouts.ts, in two copies)
#                     and the multiplayer suite, each
#                     against dev servers of its own (tests/host.ts)
#
# Not here, run by hand: tests/agent.ts (the real model, costs a little)
# and tests/suite/run.ts --long (bigger, slower, real idle-eviction waits).
#
#   ./test.sh --changed       only the tests that cover what changed since this branch left staging
#                             (tests/changed.ts: each test's "// covers:" line, a unit test's imports);
#                             the way to test while you work
#   ./test.sh tests/x.ts ...  only these test files (a unit test too), in the same pool
set -euo pipefail
cd "$(dirname "$0")"
start=$(date +%s)
usage() { echo "usage: ./test.sh [--changed | tests/x.ts ...]   (TEST_JOBS=n: how many slots at once; TEST_CORES_PER_JOB=c: one per c cores, default 2; tests/cores.ts; TEST_BASE: what --changed compares with)" >&2; exit 2; }
# Which tests: all (no arguments), those that cover the change (--changed), or those named. `picked` has one a line.
picked=""; some=0
if [[ $# == 1 && $1 == --changed ]]; then
  picked=$(bun tests/changed.ts); some=1
  if [[ -z $picked ]]; then echo "No test covers what changed."; exit 0; fi
elif [[ $# -gt 0 ]]; then
  for f in "$@"; do [[ $f == tests/*.ts && -f $f ]] || usage; picked+="$f"$'\n'; done; some=1
fi
chosen() { [[ $some == 0 ]] || grep -qxF "$1" <<<"$picked"; }
ran=""
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
  # Only the tests picked (--changed, or named): a file's run, if it's picked; the unit tests, those picked.
  if [[ $some == 1 ]]; then
    if [[ "$*" == "bun test ./tests/" ]]; then
      local units; units=$(grep -E '^tests/[^/]+\.test\.ts$' <<<"$picked" | sed 's|^|./|' || true)
      [[ -n $units ]] || return 0
      set -- bun test $units
    else
      local a file=""; for a in "$@"; do [[ $a == tests/*.ts ]] && { file=$a; break; }; done
      chosen "$file" || return 0
      ran+="$file"$'\n'
    fi
  fi
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
run 1 scoped-tokens bun tests/scoped-tokens.ts           # [10]
run 1 landing bun tests/landing.ts                       # [14]
run 1 factory-cards bun tests/factory-cards.ts           # [14]
run 1 factory-chime bun tests/factory-chime.ts           # [20]
run 1 factory-instruct bun tests/factory-instruct.ts     # [70]
run 1 factory-authors bun tests/factory-authors.ts       # [20]
run 1 factory-reset bun tests/factory-reset.ts           # [150]
run 1 versions bun tests/versions.ts                     # [13]
run 1 attach bun tests/attach.ts                         # [10]
run 1 docs-pages bun tests/docs-pages.ts                 # [6]
run 1 pages-open bun tests/pages-open.ts                 # [12]
run 2 unit bun test ./tests/                             # [11]
run 1 deployed bun tests/server-config.ts                # [7]
run 1 deploys bun tests/deploys.ts                       # [5]
run 1 staging-admins bun tests/staging-admins.ts         # [15]
run 1 isolation bun tests/isolation.ts                   # [4]

run 1 admin-layout bun tests/admin-layout.ts             # [8]
run 1 admin-nav bun tests/admin-nav.ts                   # [6]
run 1 admin-agent-chat bun tests/admin-agent-chat.ts     # [30]
run 1 admin-agent-source bun tests/admin-agent-source.ts # [15]
run 1 admin-agent-actions bun tests/admin-agent-actions.ts # [20]
run 1 view-page bun tests/view-page.ts                   # [9]
collect
# Latency is measured alone: other tests running would skew it.
run 1 latency bun tests/suite/run.ts --suite latency     # [6]
collect
# Live reload alone too: it edits files and waits on rebuilds, which a busy machine slows.
run 1 reload bun tests/reload.ts                         # [14]
collect
# Two checkouts' servers at once, with their default ports: alone, so no other test takes one of those ports meanwhile.
run 1 checkouts bun tests/checkouts.ts                   # [40]
collect
# A named test file test.sh doesn't run itself (tests/agent.ts, say): it runs now, on its own.
if [[ $some == 1 ]]; then
  while read -r f; do
    if [[ -n $f && $f != *.test.ts ]] && ! grep -qxF "$f" <<<"$ran"; then run 1 "$(basename "$f" .ts)" bun "$f"; fi
  done <<<"$picked"
  collect
fi

echo
if [[ ${#failed[@]} == 0 ]]; then echo "all passing ($(( $(date +%s) - start ))s)"; else echo "FAILED: ${failed[*]} ($(( $(date +%s) - start ))s)"; exit 1; fi
