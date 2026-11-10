// The time log of each loop: one task, from its start to production. `bun erga start`, each test run (e2e/run.ts) and
// `bun erga push` add one line each to .erga/loops.jsonl in the main clone. The merges and the deploys are in the job
// records already (.erga/jobs/, deploy.ts startJob). `bun erga loops` prints one row for each branch: the minutes of
// work, the failed test runs, the minutes of wait for the merge, and the minutes to staging and to production. The ops
// page shows the week's medians. It saves no time by itself: it shows the slowest part. loopRows decides, with no IO.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A line of .erga/loops.jsonl. */
export type LoopLine =
  | { event: "start"; at: string; branch: string }
  | { event: "test"; at: string; branch: string; ok: boolean; seconds: number; failed?: string }
  | { event: "push"; at: string; branch: string; sha: string };

/** A branch that a merge put on staging (a merge record's "Merged" line): the merge's start and its end, after the deploy to staging. */
export interface MergeRecord {
  branch: string;
  sha: string;
  at: number;
  ended: number;
}

/** A deploy that ended well (a deploy record): its instance and its end. */
export interface DeployRecord {
  host: string;
  ended: number;
}

export const loopsPath = (dir: string) => join(dir, "loops.jsonl");

/** Adds a line to the log. It never stops the command that calls it. */
export function logLoop(dir: string, line: LoopLine) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(loopsPath(dir), `${JSON.stringify(line)}\n`);
  } catch {}
}

const jsonLines = (text: string) =>
  text.split("\n").flatMap((l) => {
    try {
      return l ? [JSON.parse(l) as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });

export const readLoopLines = (dir: string): LoopLine[] =>
  existsSync(loopsPath(dir))
    ? (jsonLines(readFileSync(loopsPath(dir), "utf8")).filter((l) => typeof l.branch == "string") as LoopLine[])
    : [];

/** The merges and the good deploys of the job records (.erga/jobs/*.jsonl). */
export function readRecords(dir: string): { merges: MergeRecord[]; deploys: DeployRecord[] } {
  const jobs = join(dir, "jobs");
  const merges: MergeRecord[] = [];
  const deploys: DeployRecord[] = [];
  if (!existsSync(jobs)) return { merges, deploys };
  for (const f of readdirSync(jobs).filter((x) => x.endsWith(".jsonl"))) {
    const lines = jsonLines(readFileSync(join(jobs, f), "utf8"));
    const head = lines[0];
    const end = lines.find((l) => l.result == "ok");
    const [at, ended] = [Date.parse(String(head?.started)), Date.parse(String(end?.ended))];
    if (!head || !at) continue;
    const command = String(head.command);
    // merge.ts writes this line for each branch, after the deploy; a merge's own deploy has a record of its own.
    for (const l of lines) {
      const m = typeof l.out == "string" ? /^PASS {2}Merged (\S+) as ([0-9a-f]{12}):/.exec(l.out) : null;
      if (m) merges.push({ branch: m[1], sha: m[2], at, ended: ended || at });
    }
    if (ended && typeof head.host == "string" && /^bun erga deploy\b/.test(command) && lines.some((l) => typeof l.commit == "string"))
      deploys.push({ host: head.host, ended });
  }
  return { merges, deploys };
}

/** One loop: a branch from its start to production. Times in ms; a part with no record is undefined. */
export interface LoopRow {
  branch: string;
  /** Its first event. */
  from: number;
  /** Start to the first push, in minutes. */
  work?: number;
  tests: number;
  failed: number;
  /** The last push to the merge's start, in minutes. */
  wait?: number;
  /** The merge: its tests and its deploy to staging, in minutes. */
  toStaging?: number;
  /** The merge's end to the next deploy of production, in minutes. */
  toProduction?: number;
  merged?: number;
}

const minutes = (ms: number) => Math.round(ms / 6000) / 10;

/** The loops, oldest first. A merge ends a branch's loop: the same name after it is a new loop. */
export function loopRows(o: { lines: LoopLine[]; merges: MergeRecord[]; deploys: DeployRecord[]; production: string[] }): LoopRow[] {
  type Open = LoopRow & { start?: number; firstPush?: number; lastPush?: number };
  const events = [
    ...o.lines.map((l) => ({ t: Date.parse(l.at), branch: l.branch, line: l as LoopLine | null, merge: null as MergeRecord | null })),
    ...o.merges.map((m) => ({ t: m.at, branch: m.branch, line: null, merge: m })),
  ]
    .filter((e) => e.t)
    .sort((a, b) => a.t - b.t);
  const production = o.deploys
    .filter((d) => o.production.includes(d.host))
    .map((d) => d.ended)
    .sort((a, b) => a - b);
  const open = new Map<string, Open>();
  const rows: Open[] = [];
  for (const e of events) {
    let row = open.get(e.branch);
    if (!row) {
      row = { branch: e.branch, from: e.t, tests: 0, failed: 0 };
      open.set(e.branch, row);
      rows.push(row);
    }
    if (e.line?.event == "start") row.start = e.t;
    else if (e.line?.event == "test") {
      row.tests++;
      if (!e.line.ok) row.failed++;
    } else if (e.line?.event == "push") {
      row.firstPush ??= e.t;
      row.lastPush = e.t;
      if (row.start != undefined && row.work == undefined) row.work = minutes(e.t - row.start);
    } else if (e.merge) {
      row.merged = e.merge.at;
      if (row.lastPush != undefined) row.wait = minutes(e.merge.at - row.lastPush);
      row.toStaging = minutes(e.merge.ended - e.merge.at);
      const live = production.find((t) => t >= e.merge!.ended);
      if (live != undefined) row.toProduction = minutes(live - e.merge.ended);
      open.delete(e.branch);
    }
  }
  return rows.map(({ start: _s, firstPush: _f, lastPush: _l, ...row }) => row);
}

export const median = (xs: number[]): number | undefined => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]
      : Math.round(((s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 10) / 10
    : undefined;
};

/** The medians of the loops merged since `since`. */
export interface LoopStats {
  merged: number;
  work?: number;
  failed?: number;
  wait?: number;
  toStaging?: number;
  toProduction?: number;
}

export function loopStats(rows: LoopRow[], since: number): LoopStats {
  const done = rows.filter((r) => r.merged != undefined && r.merged >= since);
  const of = (key: "work" | "failed" | "wait" | "toStaging" | "toProduction") =>
    median(done.flatMap((r) => (r[key] == undefined ? [] : [r[key]!])));
  return {
    merged: done.length,
    work: of("work"),
    // A loop with no test line has no count.
    failed: median(done.filter((r) => r.tests).map((r) => r.failed)),
    wait: of("wait"),
    toStaging: of("toStaging"),
    toProduction: of("toProduction"),
  };
}

const min = (n: number | undefined) => (n == undefined ? "?" : `${n} min`);

/** The medians in words, for the ops page and the command. */
export const statsText = (s: LoopStats) =>
  `work ${min(s.work)} · failed test runs ${s.failed ?? "?"} · wait for the merge ${min(s.wait)} · merge to staging ${min(s.toStaging)} · staging to production ${min(s.toProduction)}`;

/** `bun erga loops` as text: one row for each loop with an event since `since`, then the medians of the merged ones. */
export function loopsText(rows: LoopRow[], since: number, days: number): string {
  const recent = rows.filter((r) => r.from >= since || (r.merged ?? 0) >= since);
  if (!recent.length) return `No loop in the last ${days} days. bun erga start, bun run test and bun erga push write the log.`;
  const cells = (r: LoopRow) => [
    r.branch,
    min(r.work),
    r.tests ? `${r.failed} of ${r.tests}` : "?",
    r.merged == undefined ? "waits" : min(r.wait),
    min(r.toStaging),
    r.merged == undefined ? "" : min(r.toProduction),
  ];
  const table = [["branch", "work", "failed runs", "wait", "to staging", "to production"], ...recent.map(cells)];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  const s = loopStats(rows, since);
  return [
    ...table.map((row) =>
      row
        .map((c, i) => c.padEnd(widths[i]))
        .join("  ")
        .trimEnd()
    ),
    "",
    s.merged ? `Medians of the ${s.merged} merged in the last ${days} days: ${statsText(s)}` : `No loop merged in the last ${days} days.`,
    '"?": the log has no line for that part (a branch from before the log, or one not made with bun erga start).',
  ].join("\n");
}

/** The loops of this clone, from its log and its job records. `production`: the primaries' hosts. */
export function readLoops(dir: string, production: string[]): LoopRow[] {
  return loopRows({ lines: readLoopLines(dir), ...readRecords(dir), production });
}
