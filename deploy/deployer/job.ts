// The job of one deploy, as a state machine (AGENTS.md, rule 6): the steps in order, each one's lines in the log, and
// the way back when the release is up but not healthy. Pure: `step` takes the job and an event, and gives the new job
// and the effects to do. Its owner (deploy.ts) keeps the job, does each effect through the ports, and gives the answer
// back as the next event. The job is plain data: an owner can save it between two events.

/** One step of a deploy: its name in the code, and its title in the log. */
export interface Step {
  id: string;
  title: string;
}

export type Job =
  | { at: "new" }
  /** `step` runs; `todo` come after it. */
  | { at: "step"; step: Step; todo: readonly Step[] }
  /** The release is up but not healthy: the instance goes back to `to`, what it ran before. */
  | { at: "rollback"; to: string; why: string }
  | { at: "done" }
  /** `rolledBack`: what the instance runs again; null: no step changed what it runs, or the way back failed. */
  | { at: "failed"; why: string; rolledBack: string | null };

export type Event =
  | { type: "start"; steps: readonly Step[] }
  /** The step that ran is done; `detail` says what it did. */
  | { type: "done"; detail: string }
  /** The step that ran failed. `restore`: what the instance ran before, when the release is up but not healthy. */
  | { type: "failed"; why: string; restore: string | null }
  | { type: "rolled back" }
  | { type: "rollback failed"; why: string };

export type Effect = { do: "log"; line: string } | { do: "run"; step: string } | { do: "rollback"; to: string };

export interface Next {
  job: Job;
  effects: Effect[];
}

/** The first of `steps` starts; with none left, the job is done. */
const start = (steps: readonly Step[], said: Effect[] = []): Next => {
  const [first, ...todo] = steps;
  if (!first) return { job: { at: "done" }, effects: said };
  return {
    job: { at: "step", step: first, todo },
    effects: [...said, { do: "log", line: `${first.title}...` }, { do: "run", step: first.id }],
  };
};

/** The job after `event`, and what to do now. An event that the job's state does not wait for changes nothing. */
export function step(job: Job, event: Event): Next {
  if (job.at == "new" && event.type == "start") return start(event.steps);
  if (job.at == "step" && event.type == "done")
    return start(job.todo, [{ do: "log", line: `${job.step.title}: done${event.detail ? `, ${event.detail}` : ""}` }]);
  if (job.at == "step" && event.type == "failed") {
    if (!event.restore) return { job: { at: "failed", why: event.why, rolledBack: null }, effects: [] };
    return {
      job: { at: "rollback", to: event.restore, why: event.why },
      effects: [
        { do: "log", line: `${event.why} It goes back to ${event.restore}, which ran before.` },
        { do: "rollback", to: event.restore },
      ],
    };
  }
  if (job.at == "rollback" && event.type == "rolled back")
    return { job: { at: "failed", why: `${job.why} It is rolled back to ${job.to}, which ran before.`, rolledBack: job.to }, effects: [] };
  if (job.at == "rollback" && event.type == "rollback failed")
    return {
      job: { at: "failed", why: `${job.why} The rollback to ${job.to} failed too: ${event.why}`, rolledBack: null },
      effects: [],
    };
  return { job, effects: [] };
}
