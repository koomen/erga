// What the app and the deployer in the cloud say to each other: one row of the instance's database
// (server/migrations/0480_deploy_control.sql). The deployer has no address, so the app can't call it. An admin's ask
// (deploy this commit, roll back) and the auto-deploy switch go into the row, and the deployer reads them at its next
// look. The deployer writes what its look at GitHub saw: the head of the spec's branch and its last commits, each with
// its release. The app's ops page shows those, and no other list.
//
// This file is the deployer's side. The app's side is server/ (it can't import this folder: tests/imports.test.ts);
// the two agree on the migration's columns. As instance.ts: the database is one call (Sql), every value goes in as a
// parameter, and every row comes back as `erga:` and the hex of a JSON object. Each function is one statement.
//
// Trap: the row is not trusted because it is on the instance. An ask has a strict form, and a row that this code
// can't read is an error, never a guess: an ask's commit goes into the release's address.

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DeployError } from "./cloudflare-api";
import { type NoTable, row, rowsAs, type Sql, type Start } from "./instance";

/** A commit's full name. */
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

/** The most commits that a look writes. */
export const COMMITS = 10;

/**
 * A commit of the spec's branch, as the deployer's look saw it. `title`: its message's first line, as GitHub gave it
 * (whatever shows it escapes it). `release`: GitHub has its release, has none (yet), or has one that the deployer
 * refuses (it is not one release of Erga's).
 */
const Commit = Schema.Struct({
  sha: Sha,
  title: Schema.String.check(Schema.isMaxLength(200)),
  at: Schema.Number,
  release: Schema.Literals(["released", "none", "refused"]),
});
export type Commit = typeof Commit.Type;
const Commits = Schema.Array(Commit).check(Schema.isMaxLength(COMMITS));

/** What an admin asked for in the app: this commit's deploy, or the rollback. `by`: who asked. `at`: when, in ms. */
export type Ask = ({ kind: "deploy"; sha: string } | { kind: "rollback" }) & { by: string; at: number };

/** The row. `looked`: when the deployer last looked (ms), or null: none did. `head`, `commits`: the last look's (newest first). */
export interface Control {
  auto: boolean;
  looked: number | null;
  ask: Ask | null;
  head: string | null;
  commits: readonly Commit[];
}

/** An ask as the column `ask` holds it. */
const askText = (ask: Ask) => (ask.kind == "deploy" ? `deploy ${ask.sha}` : "rollback");

const Row = Schema.Struct({
  auto: Schema.Literals([0, 1]),
  ask: Schema.NullOr(Schema.String.check(Schema.isPattern(/^(deploy [0-9a-f]{40}|rollback)$/))),
  // One line, since it goes into the job's row as where the job came from.
  by: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100).abort(), Schema.isPattern(/^[^\n\r]+$/))),
  at: Schema.NullOr(Schema.Number),
  looked: Schema.NullOr(Schema.Number),
  head: Schema.NullOr(Sha),
  commits: Commits,
});

/** The row, or null: the instance has none yet (no ask, auto-deploy off). */
export const readControl = (sql: Sql): Effect.Effect<Control | null, DeployError | NoTable> =>
  Effect.gen(function* () {
    const rows = yield* sql(
      `SELECT ${row("json_object('auto', auto, 'ask', ask, 'by', ask_by, 'at', ask_at, 'looked', looked, 'head', head, 'commits', json(commits))")} FROM deploy_control WHERE id = 1`,
      []
    );
    const [r] = yield* rowsAs(Row, rows);
    if (!r) return null;
    const control = { auto: r.auto == 1, looked: r.looked, head: r.head, commits: r.commits };
    if (r.ask == null) return { ...control, ask: null };
    if (r.by == null || r.at == null)
      return yield* new DeployError({ message: "The ask on the instance does not say who asked, and when." });
    const who = { by: r.by, at: r.at };
    const ask: Ask = r.ask == "rollback" ? { kind: "rollback", ...who } : { kind: "deploy", sha: r.ask.slice("deploy ".length), ...who };
    return { ...control, ask };
  });

/**
 * Writes the deployer's look: now, the head of the spec's branch, the branch's last commits (newest first, COMMITS at
 * most), and why the look failed (else null). It makes the row when there is none. It never touches auto-deploy or
 * the ask. A look that the row's reader could not read is refused, never written.
 */
export const writeLook = (
  sql: Sql,
  look: { head: string | null; error: string | null; commits: readonly Commit[] }
): Effect.Effect<void, DeployError | NoTable> =>
  Effect.gen(function* () {
    const checked = yield* Effect.mapError(
      Schema.decodeUnknownEffect(Schema.Struct({ head: Schema.NullOr(Sha), commits: Commits }), { onExcessProperty: "error" })({
        head: look.head,
        commits: look.commits,
      }),
      (e) => new DeployError({ message: `This is not a look: ${e.message}` })
    );
    const now = yield* Clock.currentTimeMillis;
    yield* sql(
      "INSERT INTO deploy_control (id, looked, head, error, commits) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET looked = excluded.looked, head = excluded.head, error = excluded.error, commits = excluded.commits",
      [now, checked.head, look.error, JSON.stringify(checked.commits)]
    );
  });

/**
 * Turns auto-deploy on or off, as the app does: setup turns it on when a person chooses deploys from the cloud. It
 * makes the row when there is none, and touches nothing else of it.
 */
export const writeAuto = (sql: Sql, on: boolean): Effect.Effect<void, DeployError | NoTable> =>
  Effect.asVoid(
    sql("INSERT INTO deploy_control (id, auto) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET auto = excluded.auto", [on ? 1 : 0])
  );

/**
 * Takes `ask` off the row: true when it was still there. The deployer calls it after it has the instance's lock
 * (openJob, with startOf(ask)), so an ask waits while another job runs, and is not lost. false: the ask is gone, or
 * another one took its place; the job that was opened for it ends, and the next look reads the row again.
 */
export const takeAsk = (sql: Sql, ask: Ask): Effect.Effect<boolean, DeployError | NoTable> =>
  sql(
    `UPDATE deploy_control SET ask = NULL, ask_by = NULL, ask_at = NULL WHERE id = 1 AND ask = ? AND ask_by = ? AND ask_at = ? RETURNING ${row("json_object('id', id)")}`,
    [askText(ask), ask.by, ask.at]
  ).pipe(Effect.map((rows) => rows.length > 0));

/** What starts the job of an ask (openJob): its kind, its command as the job log shows it, and that it came from the app. */
export const startOf = (ask: Ask): Start => ({
  kind: ask.kind,
  command: ask.kind == "deploy" ? `deploy ${ask.sha.slice(0, 12)}` : "rollback",
  source: `app, by ${ask.by}`,
});
