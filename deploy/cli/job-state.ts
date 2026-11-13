// A job's state, from its record's own fields (.erga/jobs/<id>.jsonl, jobs.ts startJob), and the ops page's own run:
// the command it started, until that command ends. Pure: the page's server (ops-page.ts) does the IO, and its view
// (ops-view.ts) draws the buttons from these states, never from a command's text.

/** What a job does: the verb of its command (`bun erga <verb> ...`), which the CLI always writes first. */
export type Kind = "deploy" | "merge" | "rollback";

/** starting: the page started it, and it has no record yet. stopped: its process ended with no result. */
export type Phase = "starting" | "running" | "ok" | "failed" | "stopped";

export interface JobState {
  kind: Kind;
  /** The instance whose lock it holds. A merge's record names the first staging instance. */
  host: string;
  /** The commit it deploys, from its record's `{commit}` line: null before the job knows it. */
  commit: string | null;
  /** A merge's branch. */
  branch: string | null;
  phase: Phase;
}

/** A line of a job record: its start, a fact, a line of output, or its result. */
export type Line = Record<string, unknown>;

/** The process of a job: its pid and its start time (pid.ts), so that a reused pid is not the job. */
export type Alive = (pid: number, start: unknown) => boolean;

/** The state of a record's first line, or null: it is not a job's start. */
export function jobStart(head: Line | undefined): JobState | null {
  const m = typeof head?.command == "string" ? /^bun erga (deploy|merge|rollback)\b(?: (\S+))?/.exec(head.command) : null;
  if (!m || typeof head?.host != "string") return null;
  const kind = m[1] as Kind;
  return { kind, host: head.host, commit: null, branch: kind == "merge" ? (m[2] ?? null) : null, phase: "running" };
}

/** The next line of the record: its commit, then its result. After the result, nothing changes. */
export function stepJob(s: JobState, line: Line): JobState {
  if (s.phase != "running") return s;
  if (line.result == "ok" || line.result == "failed") return { ...s, phase: line.result as "ok" | "failed" };
  if (typeof line.commit == "string") return { ...s, commit: line.commit };
  return s;
}

/** A job's state from all its record's lines: a job with no result whose process ended has stopped. */
export function jobState(lines: Line[], alive: Alive): JobState | null {
  const start = jobStart(lines[0]);
  if (!start) return null;
  const s = lines.slice(1).reduce(stepJob, start);
  const head = lines[0];
  return s.phase == "running" && !(typeof head.pid == "number" && alive(head.pid, head.pidStart)) ? { ...s, phase: "stopped" } : s;
}

/** Whether a job (running, or starting) deploys `sha` to the instance `host`: a merge deploys to each staging instance. */
export const deploysTo = (j: JobState, sha: string, host: string, staging: boolean) =>
  !!j.commit && j.commit.slice(0, 12) == sha.slice(0, 12) && (j.host == host || (j.kind == "merge" && staging));

/** The ops page's own command: none, one that starts (until it ends), or why the last one stopped before its record. */
export type Run = { at: "idle" } | { at: "starting"; command: string; job: JobState } | { at: "failed"; why: string };

export type RunEvent =
  | { type: "start"; command: string; job: JobState }
  /** The command ended. `recorded`: it wrote its job record, which says the rest. */
  | { type: "exit"; code: number; out: string; recorded: boolean };

export function stepRun(run: Run, e: RunEvent): Run {
  if (e.type == "start") return { at: "starting", command: e.command, job: { ...e.job, phase: "starting" } };
  if (run.at != "starting") return run;
  if (e.code == 0 || e.recorded) return { at: "idle" };
  return { at: "failed", why: `${run.command} stopped: ${e.out.trim().split("\n").slice(-4).join(" ") || `exit ${e.code}`}` };
}

/** The jobs that keep the buttons busy: each record that runs, and the page's own command until it ends. */
export function activeJobs<J extends JobState>(jobs: J[], run: Run): (J | (JobState & { command: string }))[] {
  const running: (J | (JobState & { command: string }))[] = jobs.filter((j) => j.phase == "running");
  return run.at == "starting" ? [...running, { ...run.job, command: run.command }] : running;
}
