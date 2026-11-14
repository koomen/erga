// The ops page's job machine (deploy/cli/job-state.ts): a job's state from its record's lines, and the page's own run.
// Pure: no process, no file.

import { expect, test } from "bun:test";
import { activeJobs, deploysTo, jobStart, jobState, type Run, stepRun } from "../deploy/cli/job-state";

const head = { command: "bun erga deploy example.net --no-tests", host: "example.net", pid: 7, pidStart: "Fri Nov  6 09:00:00 2026" };
const C = "c".repeat(40);

test("a record: running, then its commit, then its result; with no result, a process that ended has stopped", () => {
  const lives = () => true;
  expect(jobState([head], lives)).toEqual({ kind: "deploy", host: "example.net", commit: null, branch: null, phase: "running" });
  expect(jobState([head, { out: "x" }, { commit: C }], lives)).toMatchObject({ commit: C, phase: "running" });
  expect(jobState([head, { commit: C }, { result: "failed", error: "e" }], lives)).toMatchObject({ commit: C, phase: "failed" });
  // After its result, nothing changes it.
  expect(jobState([head, { result: "ok" }, { commit: C }], lives)).toMatchObject({ commit: null, phase: "ok" });
  expect(jobState([head, { commit: C }], () => false)).toMatchObject({ phase: "stopped" });
  // The process is the pid with its start time: the record's own.
  const seen: unknown[] = [];
  jobState([head], (pid, start) => (seen.push(pid, start), true));
  expect(seen).toEqual([7, head.pidStart]);
  expect(jobState([{ ...head, pid: undefined }], lives)?.phase).toBe("stopped");
});

test("the kind comes from the command's verb; a merge's branch follows it; anything else is no job", () => {
  expect(jobStart({ command: "bun erga merge sm-ops-jobs", host: "staging.example.net" })).toMatchObject({
    kind: "merge",
    branch: "sm-ops-jobs",
  });
  expect(jobStart({ command: "bun erga rollback example.net", host: "example.net" })).toMatchObject({ kind: "rollback", branch: null });
  expect(jobStart({ command: "rm -rf /", host: "example.net" })).toBeNull();
  expect(jobStart({ command: "bun erga deploy example.net" })).toBeNull();
  expect(jobStart(undefined)).toBeNull();
});

test("a job deploys a commit to its host; a merge, to each staging instance", () => {
  const deploy = { kind: "deploy" as const, host: "s.dev", commit: C, branch: null, phase: "running" as const };
  expect(deploysTo(deploy, C, "s.dev", true)).toBe(true);
  expect(deploysTo(deploy, `${C.slice(0, 12)}${"0".repeat(28)}`, "s.dev", true)).toBe(true);
  expect(deploysTo(deploy, C, "t.dev", true)).toBe(false);
  expect(deploysTo({ ...deploy, commit: null }, C, "s.dev", true)).toBe(false);
  const merge = { ...deploy, kind: "merge" as const };
  expect(deploysTo(merge, C, "t.dev", true)).toBe(true);
  expect(deploysTo(merge, C, "example.net", false)).toBe(false);
});

test("the page's run: it starts, then it ends; it stops before its record, with its last words", () => {
  const job = { kind: "deploy" as const, host: "s.dev", commit: C, branch: null, phase: "running" as const };
  const started = stepRun({ at: "idle" }, { type: "start", command: "bun erga deploy c s.dev", job });
  expect(started).toEqual({ at: "starting", command: "bun erga deploy c s.dev", job: { ...job, phase: "starting" } });
  expect(stepRun(started, { type: "exit", code: 0, out: "", recorded: true })).toEqual({ at: "idle" });
  // A failed job with a record: the record says why.
  expect(stepRun(started, { type: "exit", code: 1, out: "boom", recorded: true })).toEqual({ at: "idle" });
  expect(stepRun(started, { type: "exit", code: 1, out: "a\nb\nFAIL  locked\n", recorded: false })).toEqual({
    at: "failed",
    why: "bun erga deploy c s.dev stopped: a b FAIL  locked",
  });
  expect(stepRun(started, { type: "exit", code: 2, out: " ", recorded: false })).toMatchObject({
    why: "bun erga deploy c s.dev stopped: exit 2",
  });
  // An exit with nothing that starts changes nothing; a new start clears the old failure.
  const failed: Run = { at: "failed", why: "w" };
  expect(stepRun(failed, { type: "exit", code: 1, out: "", recorded: false })).toBe(failed);
  expect(stepRun(failed, { type: "start", command: "x", job }).at).toBe("starting");
  // What keeps the buttons busy: the records that run, then the page's own command.
  const rec = { ...job, command: "bun erga merge b" };
  expect(activeJobs([rec, { ...rec, phase: "ok" as const }], started).map((j) => j.command)).toEqual([
    "bun erga merge b",
    "bun erga deploy c s.dev",
  ]);
  expect(activeJobs([], { at: "idle" })).toEqual([]);
});
