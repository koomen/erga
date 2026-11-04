# The MCP benchmark

An agent with Erga's MCP tools against the same agent with the same files on disk. The results and the decisions are
on the page /koomen/erga-plans/mcp-speed (erga.dev).

- `corpus/`: 7 documents. `tasks.ts`: 15 tasks, each with a check of the end files (and of the pages, in Chromium).
- `selftest.ts`: each check fails on the corpus and passes on `solutions/<task>/`.
- `run.ts`: for each task, two Claude Code agents at once (Opus 5.5, normal speed), through hc: one with only the
  local Erga's MCP server, one with the files in a folder. Numbers from each transcript, to `results/<label>.json`.
- `trace.ts`: one run's tool calls and their times. `compare.ts`: before and after, per task.
  `recheck.ts`: a run's saved end states checked again, after a check changes.

To run it:

1. Start a dev server: `bun start --no-open --port 4777`.
2. `bun bench/mcp/selftest.ts`
3. From a terminal hc runs, with `BENCH_DIR` in a folder Claude Code trusts:
   `bun bench/mcp/run.ts --label <label> --server http://localhost:4777 --pairs 3` (`--tasks a,b` for some).
4. `bun bench/mcp/compare.ts baseline,base2 <label>`

A run of all 15 tasks takes about 10 minutes with 3 pairs at once. The times change from run to run: compare means
of two runs or more. A run on a server whose code changes meanwhile (the dev server reloads) mixes the two versions.
