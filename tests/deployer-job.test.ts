// The job of one deploy (deploy/deployer/job.ts): its states, its events and the effects it asks for. Pure: no cloud,
// no clock.

import { expect, test } from "bun:test";
import { type Effect, type Event, type Job, step } from "../deploy/deployer/job";

const STEPS = [
  { id: "files", title: "Upload the files" },
  { id: "live", title: "Wait for its health" },
];

/** The job after these events, with the effects of each. */
function after(events: Event[]): { job: Job; effects: Effect[][] } {
  let job: Job = { at: "new" };
  const effects: Effect[][] = [];
  for (const e of events) {
    const next = step(job, e);
    job = next.job;
    effects.push(next.effects);
  }
  return { job, effects };
}

test("the steps run in order, each said when it starts and when it is done; then the job is done", () => {
  const r = after([
    { type: "start", steps: STEPS },
    { type: "done", detail: "12 files" },
    { type: "done", detail: "" },
  ]);
  expect(r.job).toEqual({ at: "done" });
  expect(r.effects).toEqual([
    [
      { do: "log", line: "Upload the files..." },
      { do: "run", step: "files" },
    ],
    [
      { do: "log", line: "Upload the files: done, 12 files" },
      { do: "log", line: "Wait for its health..." },
      { do: "run", step: "live" },
    ],
    [{ do: "log", line: "Wait for its health: done" }],
  ]);
  // Between two events the job is plain data: an owner can save it.
  const mid = after([{ type: "start", steps: STEPS }]).job;
  expect(JSON.parse(JSON.stringify(mid))).toEqual({ at: "step", step: STEPS[0], todo: [STEPS[1]] });
  expect(after([{ type: "start", steps: [] }]).job).toEqual({ at: "done" });
});

test("a step that fails with nothing to go back to ends the job: no later step runs", () => {
  const r = after([
    { type: "start", steps: STEPS },
    { type: "failed", why: "Cloudflare refused the upload.", restore: null },
  ]);
  expect(r.job).toEqual({ at: "failed", why: "Cloudflare refused the upload.", rolledBack: null });
  expect(r.effects[1]).toEqual([]);
});

test("a release that is up but not healthy goes back to what ran before, and the job fails with that", () => {
  const unhealthy: Event[] = [
    { type: "start", steps: STEPS },
    { type: "done", detail: "" },
    { type: "failed", why: "Release b is not healthy.", restore: "a" },
  ];
  const r = after(unhealthy);
  expect(r.job).toEqual({ at: "rollback", to: "a", why: "Release b is not healthy." });
  expect(r.effects[2]).toEqual([
    { do: "log", line: "Release b is not healthy. It goes back to a, which ran before." },
    { do: "rollback", to: "a" },
  ]);
  expect(after([...unhealthy, { type: "rolled back" }]).job).toEqual({
    at: "failed",
    why: "Release b is not healthy. It is rolled back to a, which ran before.",
    rolledBack: "a",
  });
  expect(after([...unhealthy, { type: "rollback failed", why: "no answer" }]).job).toEqual({
    at: "failed",
    why: "Release b is not healthy. The rollback to a failed too: no answer",
    rolledBack: null,
  });
});

test("an event that the job does not wait for changes nothing, and asks for nothing", () => {
  const jobs: Job[] = [
    { at: "new" },
    { at: "step", step: STEPS[0], todo: [] },
    { at: "rollback", to: "a", why: "w" },
    { at: "done" },
    { at: "failed", why: "w", rolledBack: null },
  ];
  const events: Event[] = [
    { type: "start", steps: STEPS },
    { type: "done", detail: "" },
    { type: "failed", why: "w", restore: "a" },
    { type: "rolled back" },
    { type: "rollback failed", why: "w" },
  ];
  const waits: Record<Job["at"], Event["type"][]> = {
    new: ["start"],
    step: ["done", "failed"],
    rollback: ["rolled back", "rollback failed"],
    done: [],
    failed: [],
  };
  for (const job of jobs)
    for (const event of events) {
      if (waits[job.at].includes(event.type)) continue;
      expect([job.at, event.type, step(job, event)]).toEqual([job.at, event.type, { job, effects: [] }]);
    }
});
