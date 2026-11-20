// The server's own deploys (the Deploy page, /admin/deploy): what it runs, the last commits of the branch that it tracks,
// and its deploys and rollbacks (read); and an ask to its deployer: deploy a commit, roll back, or turn auto-deploy on
// or off. The server deploys nothing itself. A deployer in the instance's own cloud account does (deploy/deployer/),
// and it has no address: an ask goes into the instance's database (server/directory/deploys.ts), and the deployer
// starts it at its next look, within a minute. An instance with no deployer deploys from a machine (`bun erga
// deploy`): then nobody has the ask, and the read says so.

import * as Schema from "effect/Schema";
import { machineAuto, noDeployer } from "../admin/index.ts";
import type { DeployJob, DeployState } from "../directory/index.ts";
import { type Caller, iso, type Operation, OperationError, said } from "./operation.ts";

/** The server's host, as its messages name it. */
const hostOf = (caller: Caller) => (caller.origin ? new URL(caller.origin).host : "this server");

const jobOf = (j: DeployJob) => ({
  id: j.id,
  kind: j.kind,
  command: j.command,
  from: j.from,
  commit: j.commit,
  state: j.phase == "ok" ? "done" : j.phase,
  started: iso(j.started),
  ...(j.phase == "running" ? {} : { ended: iso(j.ended) }),
  ...(j.error ? { error: j.error } : {}),
});

/** The job that runs now, if one does. */
const running = (s: DeployState) => s.jobs.find((j) => j.phase == "running");

export const DEPLOY_OPERATIONS: Operation[] = [
  {
    name: "deploys",
    ui: "Deploy (/admin/deploy): Deploys, Logs and History",
    label: "Read the server's deploys",
    activity: "reading the server's deploys",
    admin: true,
    description:
      "This server's deploys: the commit it runs, its branch's last commits, auto-deploy, its deploys and rollbacks; or one job's log.",
    parameters: Schema.Struct({
      job: Schema.optionalKey(Schema.Int.annotate({ description: "A job's id: that job with its log, instead of the list" })),
    }),
    run: async (args, caller) => {
      const { dir, who } = caller;
      const state = await dir.deploys.state(who);
      if (args.job != null) {
        const job = state.jobs.find((j) => j.id == args.job);
        const log = job ? await dir.deploys.log(who, job.id) : null;
        if (!job || log == null)
          throw new OperationError({ message: `There's no job ${said(args.job)}: deploys lists them.`, status: 404 });
        return { job: jobOf(job), log };
      }
      const runs = caller.platform?.deploy.version ?? null;
      return {
        runs,
        tracks: state.tracks,
        deployer: state.look
          ? { looked: iso(state.look.at), head: state.look.head, ...(state.look.error ? { error: state.look.error } : {}) }
          : noDeployer(hostOf(caller)),
        // With no deployer the switch is nobody's: auto-deploy is a machine's, and the read says what the server knows of it.
        autoDeploy: state.look ? state.auto : machineAuto(state.jobs, Date.now()),
        ...(state.ask
          ? {
              asked: {
                action: state.ask.kind,
                ...(state.ask.sha ? { commit: state.ask.sha } : {}),
                by: state.ask.by,
                at: iso(state.ask.at),
              },
            }
          : {}),
        commits: state.commits.map((c) => ({
          commit: c.sha,
          title: c.title,
          at: iso(c.at),
          release: c.release,
          ...(runs && c.sha.startsWith(runs) ? { live: true } : {}),
        })),
        jobs: state.jobs.map(jobOf),
        note: "commits: the last ones of the branch, newest first, as the deployer saw them at its last look. release: released (deploy takes it), none (GitHub has no release of it yet) or refused. An ask starts within a minute, as a job.",
      };
    },
  },
  {
    name: "deploy",
    ui: "Deploy (/admin/deploy): Deploy on a commit's row, Roll back on the live row, and the Auto-deploy switch",
    label: "Deploy the server",
    activity: "asking the deployer",
    admin: true,
    off: async (caller) => ((await caller.dir.deploys.hasDeployer()) ? null : noDeployer(hostOf(caller))),
    description: "Asks this server's deployer to deploy a commit or to roll back, or turns auto-deploy on or off.",
    asks: (args) =>
      args.action == "auto"
        ? `Turn auto-deploy ${args.on === false ? "off" : "on"} for this server`
        : args.action == "rollback"
          ? "Roll this server back to the version from before its last deploy"
          : `Deploy ${args.commit ? `the commit ${said(args.commit)}` : "the head of its branch"} to this server`,
    parameters: Schema.Struct({
      action: Schema.Literals(["deploy", "rollback", "auto"]).annotate({
        description:
          "deploy (commit), rollback (to the version from before the last deploy), auto (on: each new release of the branch deploys by itself)",
      }),
      commit: Schema.optionalKey(
        Schema.String.annotate({
          description: "deploy: one of deploys' commits (its name, or its first 7 characters or more); default: the head",
        })
      ),
      on: Schema.optionalKey(Schema.Boolean.annotate({ description: "auto: true or false" })),
    }),
    run: async (args, caller) => {
      const { dir, who } = caller;
      if (args.action == "auto") {
        if (typeof args.on != "boolean") throw new OperationError({ message: "auto needs on: true or false.", status: 400 });
        await dir.deploys.setAuto(who, args.on);
        return { autoDeploy: args.on };
      }
      const state = await dir.deploys.state(who);
      const no = (message: string, status = 409) => new OperationError({ message, status });
      const job = running(state);
      if (job) throw no(`Another job runs: ${job.command} (from ${job.from}). Wait for it to end.`);
      const soon = "The deployer starts it at its next look, within a minute, as a job: deploys shows it.";
      if (args.action == "rollback") {
        await dir.deploys.ask(who, { kind: "rollback" });
        return { asked: "rollback", message: soon };
      }
      const branch = state.tracks?.branch ?? "its branch";
      const wanted = typeof args.commit == "string" ? args.commit.trim().toLowerCase() : "";
      if (wanted && !/^[0-9a-f]{7,40}$/.test(wanted))
        throw no(`"${said(args.commit)}" is not a commit's name: deploys lists the commits.`, 400);
      const found = wanted ? state.commits.filter((c) => c.sha.startsWith(wanted)) : state.commits.slice(0, 1);
      if (found.length != 1)
        throw no(
          state.commits.length
            ? `${wanted} is not one of the last ${state.commits.length} commits of ${branch}: deploys lists them. An older one deploys from a machine.`
            : `The deployer has not seen the commits of ${branch} yet${state.look?.error ? `: ${state.look.error}` : "."}`,
          404
        );
      const [commit] = found;
      const short = commit.sha.slice(0, 12);
      const runs = caller.platform?.deploy.version;
      if (runs && commit.sha.startsWith(runs)) throw no(`${hostOf(caller)} runs ${short} already.`);
      if (commit.release == "none") throw no(`GitHub has no release of ${short} yet: its tests and its build run, or they failed.`);
      if (commit.release == "refused") throw no(`GitHub's release of ${short} is not one release of Erga's: the deployer refuses it.`);
      await dir.deploys.ask(who, { kind: "deploy", sha: commit.sha });
      return { asked: `deploy ${short}`, commit: commit.sha, title: commit.title, message: soon };
    },
  },
];
