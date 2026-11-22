// The instance's own record of its deploys, as the server reads it (server/migrations/0470_deploys.sql,
// 0480_deploy_control.sql): the repository and branch that it tracks (its spec), its deploys and rollbacks (by a
// machine, or by the deployer in the cloud), and the row that the server and the deployer share. The server never
// deploys, and never writes a job. For an admin it writes two things into that row: the auto-deploy switch, and an
// ask (deploy this commit, roll back). The deployer has no address: it reads the row at its next look, within a
// minute. An instance that deploys from a machine has no deployer, and no look.
//
// The other side of these tables is deploy/deployer/ (instance.ts, control.ts), which the server can't import
// (tests/imports.test.ts). tests/server-deploys.test.ts runs both sides on one database.
//
// Trap: an ask has the form that control.ts reads, and no other: `deploy <40 hex>` or `rollback`, and who asked in one
// line of 100 characters at most. The deployer refuses a row that it can't read, and then deploys nothing.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Sql } from "./model.ts";
import { type Actor, ConfigError, type Users } from "./index.ts";

/** How long after its last write a job that did not end still holds the instance's lock (deploy/deployer/instance.ts, LEASE_MS). */
const LEASE_MS = 30 * 60_000;
/** A deployer looks each minute: one whose last look is older than this is not there. */
export const DEPLOYER_MS = 5 * 60_000;
/** How many of the instance's last jobs the server reads. */
const JOBS = 30;
/** The most of a job's log that the server reads: its end. */
const LOG_CHARS = 200_000;

/** A deploy or a rollback of the instance. `phase`: stopped is a job that ended with no result. `from`: where its command came from. */
export interface DeployJob {
  id: number;
  kind: "deploy" | "rollback";
  command: string;
  from: string;
  commit: string | null;
  started: number;
  /** Its last write: its end, when it does not run. */
  ended: number;
  phase: "running" | "ok" | "failed" | "stopped";
  error: string | null;
}

/** A commit of the instance's branch, as the deployer's last look saw it, with GitHub's release of it. */
const Seen = Schema.Struct({
  sha: Schema.String,
  title: Schema.String,
  at: Schema.Number,
  release: Schema.Literals(["released", "none", "refused"]),
});
export type SeenCommit = typeof Seen.Type;

/** What an admin asked the deployer for, and it has not started yet. */
export interface DeployAsk {
  kind: "deploy" | "rollback";
  /** A deploy's commit. */
  sha: string | null;
  by: string;
  at: number;
}

export interface DeployState {
  /** The repository (github.com/<owner>/<name>) and the branch whose commits the instance runs; null: it has no spec yet. */
  tracks: { repo: string; branch: string } | null;
  auto: boolean;
  ask: DeployAsk | null;
  /** The deployer's last look at GitHub; null: no deployer looked in the last DEPLOYER_MS. */
  look: { at: number; head: string | null; error: string | null } | null;
  /** The branch's last commits, newest first, as that look saw them. */
  commits: readonly SeenCommit[];
  /** Newest first. */
  jobs: DeployJob[];
}

const SHA = /^[0-9a-f]{40}$/;

/** A JSON text as `schema` reads it, or null. */
const read = <A>(schema: Schema.Codec<A>, json: string | null | undefined): A | null =>
  json == null ? null : Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(json));

export class Deploys {
  constructor(
    private sql: Sql,
    private users: Users
  ) {}

  /** Whether a deployer in the cloud looks at this instance now. For anyone: it says no more than that. */
  async hasDeployer(now = Date.now()): Promise<boolean> {
    const [row] = await this.sql.all<{ looked: number | null }>("SELECT looked FROM deploy_control WHERE id = 1");
    return row?.looked != null && Number(row.looked) > now - DEPLOYER_MS;
  }

  /** What the instance tracks, its jobs, and what it and its deployer told each other (admins only). */
  async state(by: Actor, now = Date.now()): Promise<DeployState> {
    await this.users.mustAdmin(by);
    const [[spec], [control], jobs] = await Promise.all([
      this.sql.all<{ spec: string }>("SELECT spec FROM deploy_spec WHERE id = 1"),
      this.sql.all<{
        auto: number;
        ask: string | null;
        ask_by: string | null;
        ask_at: number | null;
        looked: number | null;
        head: string | null;
        error: string | null;
        commits: string;
      }>("SELECT auto, ask, ask_by, ask_at, looked, head, error, commits FROM deploy_control WHERE id = 1"),
      this.sql.all<{
        id: number;
        kind: "deploy" | "rollback";
        command: string;
        source: string;
        sha: string | null;
        started: number;
        alive: number;
        state: string;
      }>("SELECT id, kind, command, source, sha, started, alive, state FROM deploy_jobs ORDER BY id DESC LIMIT ?1", JOBS),
    ]);
    const tracks = read(Schema.Struct({ repo: Schema.String, branch: Schema.String }), spec?.spec);
    const there = control?.looked != null && Number(control.looked) > now - DEPLOYER_MS;
    const deploy = control?.ask?.startsWith("deploy ") ? control.ask.slice("deploy ".length) : null;
    return {
      tracks: tracks && { repo: tracks.repo, branch: tracks.branch },
      auto: control?.auto == 1,
      ask:
        control?.ask && (deploy || control.ask == "rollback")
          ? { kind: deploy ? "deploy" : "rollback", sha: deploy, by: control.ask_by ?? "", at: Number(control.ask_at ?? 0) }
          : null,
      look: control && there ? { at: Number(control.looked), head: control.head, error: control.error } : null,
      commits: (there && read(Schema.Array(Seen), control?.commits)) || [],
      jobs: jobs.map((j) => {
        const alive = Number(j.alive);
        // (As deploy/deployer/instance.ts, holds: a job that runs holds the lock until LEASE_MS after its last write.)
        const phase = j.state == "running" ? (alive > now - LEASE_MS ? "running" : "stopped") : j.state == "done" ? "ok" : "failed";
        return {
          id: Number(j.id),
          kind: j.kind,
          command: j.command,
          from: j.source,
          commit: j.sha,
          started: Number(j.started),
          ended: alive,
          phase,
          error: phase == "failed" ? j.state.replace(/^failed: ?/, "") : null,
        };
      }),
    };
  }

  /** The end of a job's log (admins only); null: no such job. */
  async log(by: Actor, id: number): Promise<string | null> {
    await this.users.mustAdmin(by);
    const [row] = await this.sql.all<{ log: string }>("SELECT substr(log, ?2) AS log FROM deploy_jobs WHERE id = ?1", id, -LOG_CHARS);
    return row ? row.log : null;
  }

  /**
   * The deployer's step of the setup page, as the row has it (server/identity/setup-link.ts reads it); null: no row.
   * For the setup page only, which its own pass guards (server/identity/setup.ts): a server with an admin has no such page.
   */
  async setupStep(): Promise<string | null> {
    const [row] = await this.sql.all<{ deployer: string }>("SELECT deployer FROM setup WHERE id = 1");
    return row?.deployer ?? null;
  }

  /** Writes the step, while the row is still `from` (the setup command writes it too): whether the row is `to` now. */
  async setSetupStep(from: string | null, to: string): Promise<boolean> {
    await this.sql.run(
      "INSERT INTO setup (id, deployer) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET deployer = excluded.deployer WHERE setup.deployer IS ?2",
      to,
      from
    );
    return (await this.setupStep()) == to;
  }

  /** Turns auto-deploy on or off: the deployer reads it at its next look (admins only). */
  async setAuto(by: Actor, on: boolean): Promise<void> {
    await this.users.mustAdmin(by);
    await this.sql.run(
      "INSERT INTO deploy_control (id, auto) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET auto = excluded.auto",
      on ? 1 : 0
    );
  }

  /**
   * Asks the deployer for a deploy of the commit `sha`, or for a rollback (admins only). It takes the place of an ask
   * that waits. The deployer starts it at its next look, as a job.
   */
  async ask(by: Actor, ask: { kind: "deploy"; sha: string } | { kind: "rollback" }, now = Date.now()): Promise<void> {
    await this.users.mustAdmin(by);
    if (ask.kind == "deploy" && !SHA.test(ask.sha))
      throw new ConfigError({ message: `"${ask.sha}" is not a commit's full name (40 hex characters).` });
    // One line, 100 characters at most: it goes into the job's row as where the job came from.
    const who = `${by.login.toLowerCase()}${by.via ? `, via ${by.via}` : ""}`.replace(/\s+/g, " ").slice(0, 100);
    await this.sql.run(
      "INSERT INTO deploy_control (id, ask, ask_by, ask_at) VALUES (1, ?1, ?2, ?3) ON CONFLICT (id) DO UPDATE SET ask = excluded.ask, ask_by = excluded.ask_by, ask_at = excluded.ask_at",
      ask.kind == "deploy" ? `deploy ${ask.sha}` : "rollback",
      who,
      now
    );
  }
}
