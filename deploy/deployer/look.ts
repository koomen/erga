// The deployer's look, each minute: what GitHub has of the branch that the instance's spec names, written on the
// instance for its ops page (control.ts), and with auto-deploy on, the deploy of the branch's head. The deployer on
// Cloudflare (worker.ts) and the one on AWS run this same function: each gives its own ports.
//
// One look:
//   1. The instance's spec, and what the last look wrote.
//   2. The branch's head at GitHub. Its last commits, only when the head changed. The release of each commit, as
//      GitHub's registry has it: the head's at each look until it is there, each other one's one time.
//   3. That is written on the instance: the look's time, the head, the commits. Or the look's error.
//   4. An ask of the app (an admin's: deploy this commit, or roll back), when no job runs on the instance. The look
//      takes the instance's lock with a new job, and then takes the ask off the row: an ask waits while another job
//      runs, and runs one time. A commit that is asked for must be a commit of the spec's branch.
//   5. Else, with auto-deploy on: no job runs on the instance, no job of the instance has the head, and the head has
//      its release. Then the look takes the lock with a new job, fetches and checks the release, and deploys it
//      (deploy.ts). The job's row has its log and its end.
//
// Auto-deploy tries a commit one time: a head whose job failed waits for a new commit, or for a person's ask. A
// release that is not there yet is no try: the look waits. The branch may be written again (`bun erga try` does that
// to verify): its new head deploys.
//
// The look keeps no state of its own between two runs: the instance's database has it all (rule 6: `due` is the pure
// part, the jobs and the control row are the state).

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { DeployError, type Fetch } from "./cloudflare-api";
import { type Ask, type Commit, readControl, startOf, takeAsk, writeLook } from "./control";
import { deploy, type Ports } from "./deploy";
import { commitsAtGitHub, headAtGitHub, onBranchAtGitHub } from "./github";
import { holds, type Job, type JobLog, type NoTable, openJob, readJobs, readSpec, type Sql, type Start } from "./instance";
import { fetchRelease, releaseState } from "./registry";
import { rollback } from "./rollback";
import type { Spec } from "./spec";

/** What a look acts through. The time is Effect's Clock. */
export interface LookPorts {
  /** The instance's database: its spec, its jobs and its control row. */
  sql: Sql;
  /** The way to GitHub and to its registry. */
  fetch: Fetch;
  /** The API of the deployer's cloud, as deploy() takes it. */
  cloud: Pick<Ports, "cloudflare" | "aws">;
  /** Whether the spec's target is the instance that this deployer is installed for: it deploys to no other. */
  mine: (target: Spec["target"]) => boolean;
}

/** How many commits of the branch a look keeps. */
const COMMITS = 10;
/** How many of the instance's last jobs say that a commit was tried. */
const JOBS = 30;

const short = (sha: string) => sha.slice(0, 12);
const wrong = (message: string) => new DeployError({ message });

/**
 * Why auto-deploy does not deploy `head` now, or null: it is due. A job that holds the lock: wait. A job of the
 * instance that has the commit, however it ended: a commit is tried one time.
 */
export function due(jobs: readonly Pick<Job, "state" | "alive" | "sha" | "command">[], head: string, now: number): string | null {
  const runs = jobs.find((j) => holds(j, now));
  if (runs) return `A job runs on the instance (${runs.command}): the look waits.`;
  const tried = jobs.find((j) => j.sha != null && j.sha.length >= 12 && head.startsWith(j.sha));
  if (!tried) return null;
  return tried.state.at == "done"
    ? `The instance has ${short(head)}: nothing to deploy.`
    : `A job of the instance has ${short(head)} and did not end well: a commit is tried one time.`;
}

/**
 * One look. The result is one line that says what it did. It never fails: an error is in the line, and on the
 * instance for its ops page when the instance can take it.
 */
export const look = (ports: LookPorts): Effect.Effect<string> =>
  Effect.suspend(() => {
    const { sql, fetch } = ports;
    /** The head and the commits as the look knows them now (first: as the last look wrote them): an error keeps them on the instance. */
    const known = { read: false, head: null as string | null, commits: [] as readonly Commit[] };
    const body: Effect.Effect<string, DeployError | NoTable> = Effect.gen(function* () {
      const spec = yield* readSpec(sql);
      if (!spec) return "The instance has no spec: nothing to look at.";
      const control = yield* readControl(sql);
      Object.assign(known, { read: true, head: control?.head ?? null, commits: control?.commits ?? [] });
      if (!ports.mine(spec.target))
        return yield* wrong("The instance's spec names another instance than the one that this deployer is for.");

      const head = yield* headAtGitHub(fetch, spec);
      known.head = head;
      // The commits: only when the head is not the first of those that the last look wrote. A feed that is behind the
      // head (GitHub makes it a moment later) changes nothing: the next look reads it again.
      const before = known.commits;
      let list: readonly Pick<Commit, "sha" | "title" | "at">[] = before;
      if (before[0]?.sha != head) {
        const feed = yield* commitsAtGitHub(fetch, spec);
        if (feed[0]?.sha == head) list = feed.slice(0, COMMITS);
      }
      // Each commit's release: as the last look found it, but for the head with none yet, and for a new commit.
      const found = new Map(before.map((c) => [c.sha, c.release]));
      const stateOf = (sha: string) => {
        const was = found.get(sha);
        return was == null || (was == "none" && sha == head) ? releaseState(fetch, spec, sha) : Effect.succeed(was);
      };
      const commits: Commit[] = [];
      for (const c of list) commits.push({ sha: c.sha, title: c.title, at: c.at, release: yield* stateOf(c.sha) });
      const release = commits.find((c) => c.sha == head)?.release ?? (yield* stateOf(head));
      known.commits = commits;
      yield* writeLook(sql, { head, commits, error: null });

      const at = `${spec.branch} on ${spec.repo} is at ${short(head)}`;
      const jobs = yield* readJobs(sql, JOBS);
      const now = yield* Clock.currentTimeMillis;

      /**
       * One job on the instance: the lock, `work` with the job's log, and the job's end, whatever stopped the work
       * (also a fault of this code). The result: the look's line.
       */
      const inJob = (start: Start, what: string, work: (job: JobLog) => Effect.Effect<void, DeployError | NoTable>) =>
        Effect.gen(function* () {
          // Another job that took the lock a moment before is no error: the next look sees its end.
          const opened = yield* Effect.result(openJob(sql, start));
          if (opened._tag == "Failure") return `${at}. ${opened.failure.message}`;
          const job = opened.success;
          const failed = yield* work(job).pipe(
            Effect.catchCause((cause) => {
              const e = Cause.squash(cause);
              return Effect.fail(
                e instanceof DeployError ? e : wrong(`The deployer stopped: ${e instanceof Error ? e.message : String(e)}`)
              );
            }),
            Effect.match({ onSuccess: () => null, onFailure: (e) => e.message })
          );
          if (failed) job.line(failed);
          const gap = yield* Effect.promise(() => job.end(failed ? { at: "failed", why: failed } : { at: "done" }));
          const record = gap ? ` The job's row does not have all of it: ${gap}.` : "";
          return failed ? `${at}. ${what} failed: ${failed}${record}` : `${at}. ${what} is done.${record}`;
        });
      /** The release of `sha`, fetched, checked and deployed. `onBranch`: deploy()'s port. */
      const deployOf = (job: JobLog, sha: string, onBranch: Ports["onBranch"]) =>
        fetchRelease(fetch, spec, sha).pipe(
          Effect.flatMap((got) => (got ? Effect.succeed(got) : Effect.fail(wrong(`GitHub's registry has no release of ${short(sha)}.`)))),
          Effect.flatMap((got) => deploy(spec, got, { ...ports.cloud, onBranch, log: job.line }))
        );

      const ask = control?.ask;
      if (ask) {
        const runs = jobs.find((j) => holds(j, now));
        if (runs) return `${at}. A job runs on the instance (${runs.command}): the ask of ${ask.by} waits.`;
        return yield* inJob(startOf(ask), `The ${ask.kind} that ${ask.by} asked for`, (job) =>
          Effect.gen(function* () {
            if (!(yield* takeAsk(sql, ask))) return yield* wrong("The ask changed before its job started: nothing is done.");
            // The admin said yes in the app.
            if (ask.kind == "rollback") return void (yield* rollback(spec, { ...ports.cloud, log: job.line, ok: Effect.succeed(true) }));
            job.commit(ask.sha);
            // A commit that the look saw on the branch is on it. For an older one, GitHub's API says (github.ts).
            const seen = commits.some((c) => c.sha == ask.sha);
            const onBranch = seen
              ? (version: string) => Effect.succeed(version.length >= 12 && ask.sha.startsWith(version))
              : onBranchAtGitHub(fetch, spec, ask.sha);
            yield* deployOf(job, ask.sha, onBranch);
          })
        );
      }

      if (!control?.auto) return `${at}. Auto-deploy is off.`;
      const wait = due(jobs, head, now);
      if (wait) return `${at}. ${wait}`;
      if (release == "none") return `${at}. GitHub has no release of it yet: the look waits.`;
      if (release == "refused") return `${at}. What GitHub's registry has for it is not a release: it is not deployed.`;
      return yield* inJob({ kind: "deploy", command: `deploy ${head}`, source: "auto-deploy" }, "Its deploy", (job) => {
        job.commit(head);
        job.line(`${at}: auto-deploy deploys its release.`);
        // The commit is the head that GitHub gave a moment before: the release must say that it is that commit.
        return deployOf(job, head, (version) => Effect.succeed(version.length >= 12 && head.startsWith(version)));
      });
    });
    return body.pipe(
      Effect.catchTag("NoTable", () =>
        Effect.succeed("The instance's database has no tables for its deploys yet: a deploy from a machine brings them.")
      ),
      Effect.catch((e) =>
        known.read
          ? writeLook(sql, { head: known.head, commits: [...known.commits], error: e.message }).pipe(Effect.ignore, Effect.as(e.message))
          : Effect.succeed(e.message)
      )
    );
  });
