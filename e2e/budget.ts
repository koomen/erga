// The suite's budgets: e2e/COVERAGE.md gives each journey file a budget, in seconds of test time. e2e/run.ts reads
// each file's time from e2e's report and names the files that are over; tests/suite.test.ts holds the map to the files.

/** The suite's whole budget of test time, in seconds: the sum of the journeys' budgets may not pass it. */
export const TOTAL_S = 280;

/** Each journey file's budget, from the map's table rows: "| `e2e/<area>/<file>.e2e.ts` | ... | <seconds> |". */
export function budgets(map: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of map.split("\n")) {
    const file = /^\|.*`(e2e\/[^`]+\.e2e\.ts)`/.exec(line)?.[1];
    const seconds = Number(/\|\s*([\d.]+)\s*\|\s*$/.exec(line)?.[1]);
    if (file && seconds > 0) out.set(file, seconds);
  }
  return out;
}

/** Each file's test time in e2e's report (.e2e/report.json), in seconds: its plain tests, and its journeys (a journey's time is its group's, not its steps'). */
export function fileSeconds(report: unknown): Map<string, number> {
  const out = new Map<string, number>();
  type Timed = { file?: string; attempts?: { durationMs?: number }[] };
  const run = (report as { run?: { results?: Timed[]; serialGroups?: Timed[] } } | null)?.run;
  for (const r of [...(run?.results ?? []), ...(run?.serialGroups ?? [])]) {
    const ms = (r.attempts ?? []).reduce((sum, a) => sum + (a.durationMs ?? 0), 0);
    if (r.file && ms) out.set(r.file, (out.get(r.file) ?? 0) + ms / 1000);
  }
  return out;
}

/** The files whose time in the report is over their budget, the worst first. */
export function overBudget(report: unknown, budget: Map<string, number>): { file: string; seconds: number; budget: number }[] {
  return [...fileSeconds(report)]
    .map(([file, s]) => ({ file, seconds: Math.round(s * 10) / 10, budget: budget.get(file) ?? 0 }))
    .filter((f) => f.budget && f.seconds > f.budget)
    .sort((a, b) => b.seconds / b.budget - a.seconds / a.budget);
}
