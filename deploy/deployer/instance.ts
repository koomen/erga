// The instance's own record of its deploys, in its database (server/migrations/0470_deploys.sql): its spec, and one
// row for each deploy or rollback. The row is the job's log; while the job runs, it is also the instance's lock: one
// job at a time, from any machine and from the deployer in the cloud. A job holds the lock until its row says that it
// ended, or until LEASE_MS after its last write (a job that stopped with no end).
//
// This file knows the database only through one call (Sql): a machine gives it with a person's own login (Cloudflare's
// D1 API; on AWS, Systems Manager), the deployer in the cloud with its narrow credential. Every value goes in as a
// parameter. Every row comes back as one text, `erga:` and the hex of a JSON object (of a log's bytes, for a part of
// a log), so that a platform that gives the rows as printed text (AWS's machine) gives the same rows as one that
// gives values. A part of a log, written or read, has CHUNK bytes at most: AWS's Systems Manager carries little.
//
// The writer of a job's row is a state machine (AGENTS.md, rule 6): `stepWriter` is pure; `openJob` is its thin owner.
// One write runs at a time; what comes in while it runs goes in the next one.

import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import { DeployError } from "./cloudflare-api";
import { decodeSpec, type Spec } from "./spec";

/** The instance's database has no table for this yet: it is from before the migration, or the instance has no release yet. */
export class NoTable extends Data.TaggedError("NoTable") {}

/** One SQL statement on the instance's database: its rows, each the text of its one column. */
export type Sql = (sql: string, params: readonly (string | number | null)[]) => Effect.Effect<readonly string[], DeployError | NoTable>;

/** How long after its last write a job that did not end still holds the lock. */
export const LEASE_MS = 30 * 60_000;
/**
 * The most bytes of a log that one write sends, and that one read asks for. AWS's Systems Manager gives back 24,000
 * characters of a command's output at most, and a row is the hex of its bytes.
 */
export const CHUNK = 8000;
/** The most text that a job's log holds. */
const MAX_LOG = 400_000;

const MARK = "erga:";
/** A row's one column: the mark, and the hex of `json` (a JSON text). */
const row = (json: string) => `'${MARK}' || hex(${json})`;

/** A row's bytes. */
const bytesOf = (r: string): Effect.Effect<Uint8Array, DeployError> =>
  Effect.mapError(
    Effect.fromResult(Hex.decode(r.slice(MARK.length))),
    () => new DeployError({ message: "The instance's database gave a row of its deploys that is not whole." })
  );

/** Each row as `schema` reads it. A row that it can't read is an error: this code can't act on what it doesn't understand. */
const rowsAs = <A>(schema: Schema.Codec<A>, rows: readonly string[]): Effect.Effect<A[], DeployError> =>
  Effect.forEach(rows, (r) =>
    bytesOf(r).pipe(
      Effect.flatMap((bytes) =>
        Effect.mapError(
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes)),
          (e) =>
            new DeployError({
              message: `The instance's database gave a row of its deploys that this code can't read: ${e.message.slice(0, 300)}`,
            })
        )
      )
    )
  );

// ------------------------------------------------------------------ the spec

/** The instance's spec, or null: it has none yet. */
export const readSpec = (sql: Sql): Effect.Effect<Spec | null, DeployError | NoTable> =>
  Effect.gen(function* () {
    const [hex] = yield* sql(`SELECT ${row("spec")} FROM deploy_spec WHERE id = 1`, []);
    if (!hex) return null;
    const [value] = yield* rowsAs(Schema.Unknown, [hex]);
    return yield* Effect.mapError(
      decodeSpec(value),
      (e) => new DeployError({ message: `The spec on the instance is not one that this code reads: ${e.message}` })
    );
  });

/** Writes the instance's spec: it replaces the one that is there. A value that is no spec is refused, never written. */
export const writeSpec = (sql: Sql, spec: Spec): Effect.Effect<void, DeployError | NoTable> =>
  Effect.gen(function* () {
    const checked = yield* Effect.mapError(decodeSpec(spec), (e) => new DeployError({ message: `This is not a spec: ${e.message}` }));
    const now = yield* Clock.currentTimeMillis;
    yield* sql(
      "INSERT INTO deploy_spec (id, spec, at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET spec = excluded.spec, at = excluded.at",
      [JSON.stringify(checked), now]
    );
  });

// ------------------------------------------------------------------ a job's row

/** A job's state, as its row says it (the column `state`): 'running', 'done' or 'failed: <why>'. */
export type JobState = { at: "running" } | { at: "done" } | { at: "failed"; why: string };
const stateText = (s: JobState) => (s.at == "failed" ? `failed: ${s.why}` : s.at);
const stateOf = (text: string): JobState =>
  text == "running" || text == "done" ? { at: text } : { at: "failed", why: text.replace(/^failed: ?/, "") };

/** What starts a job: a deploy or a rollback, its command as typed, and where the command came from. */
export interface Start {
  kind: "deploy" | "rollback";
  command: string;
  source: string;
}

const JobRow = Schema.Struct({
  id: Schema.Number,
  kind: Schema.Literals(["deploy", "rollback"]),
  command: Schema.String,
  source: Schema.String,
  sha: Schema.NullOr(Schema.String),
  started: Schema.Number,
  alive: Schema.Number,
  state: Schema.String,
  size: Schema.Number,
});
/** A job, as the instance has it. `alive`: its last write. `size`: how many bytes its log has. */
export type Job = Omit<typeof JobRow.Type, "state"> & { state: JobState };

const JOB = row(
  "json_object('id', id, 'kind', kind, 'command', command, 'source', source, 'sha', sha, 'started', started, 'alive', alive, 'state', state, 'size', length(CAST(log AS BLOB)))"
);
const HOLDS = "state = 'running' AND alive > ?";

/** Whether the job holds the instance's lock at `now`: it runs, and its last write is not too old. */
export const holds = (job: Pick<Job, "state" | "alive">, now: number) => job.state.at == "running" && job.alive > now - LEASE_MS;

/** The instance's last jobs, newest first. */
export const readJobs = (sql: Sql, limit = 10): Effect.Effect<Job[], DeployError | NoTable> =>
  sql(`SELECT ${JOB} FROM deploy_jobs ORDER BY id DESC LIMIT ?`, [limit]).pipe(
    Effect.flatMap((rows) => rowsAs(JobRow, rows)),
    Effect.map((rows) => rows.map((r) => ({ ...r, state: stateOf(r.state) })))
  );

/**
 * A part of a job's log: at most CHUNK bytes, after its first `from` bytes. A part can end inside a character: its
 * reader puts the parts together before it reads them as text.
 */
export const readLog = (sql: Sql, id: number, from: number): Effect.Effect<Uint8Array, DeployError | NoTable> =>
  sql(`SELECT '${MARK}' || hex(substr(CAST(log AS BLOB), ?, ?)) FROM deploy_jobs WHERE id = ?`, [from + 1, CHUNK, id]).pipe(
    Effect.flatMap((rows) => (rows[0] ? bytesOf(rows[0]) : Effect.succeed(new Uint8Array())))
  );

/**
 * Takes the instance's lock with a new job's row: its id. One statement, so that of two jobs that start together one
 * gets the lock. Another job holds it: an error that names that job.
 */
const take = (sql: Sql, start: Start, started: number): Effect.Effect<number, DeployError | NoTable> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const made = yield* sql(
      `INSERT INTO deploy_jobs (kind, command, source, started, alive, state) SELECT ?, ?, ?, ?, ?, 'running' WHERE NOT EXISTS (SELECT 1 FROM deploy_jobs WHERE ${HOLDS}) RETURNING ${row("json_object('id', id)")}`,
      [start.kind, start.command, start.source, started, now, now - LEASE_MS]
    );
    const [mine] = yield* rowsAs(Schema.Struct({ id: Schema.Number }), made);
    if (mine) return mine.id;
    const [held] = yield* Effect.flatMap(
      sql(`SELECT ${JOB} FROM deploy_jobs WHERE ${HOLDS} ORDER BY id DESC LIMIT 1`, [now - LEASE_MS]),
      (rows) => rowsAs(JobRow, rows)
    );
    return yield* new DeployError({
      message: `Another job runs on the instance${held ? `: ${held.command} (from ${held.source}), since ${new Date(held.started).toISOString()}` : ""}. Wait for it to end. A job that stopped frees the instance ${LEASE_MS / 60_000} minutes after its last line.`,
    });
  });

// ------------------------------------------------------------------ the writer

/** What one write puts in the job's row. */
export interface Write {
  text: string;
  sha: string | null;
  state: JobState;
}

/** The writer of one job's row. */
export interface Writer {
  /** The row's id. null: the instance had no table when the job started, so the row is made when the job ends. */
  id: number | null;
  /** What waits for the next write: the log's text, the commit, and the job's state when the row does not have it yet. */
  text: string;
  sha: string | null;
  state: JobState;
  stated: boolean;
  /** How much text the job's log took: MAX_LOG at most. */
  size: number;
  /** The write that runs now, or null. */
  flight: Write | null;
  /** The last write failed: what it carried waits again. A new event tries again. */
  failed: string | null;
}

export type WriterEvent =
  | { type: "line"; line: string }
  | { type: "commit"; sha: string }
  | { type: "end"; state: JobState }
  /** The write that ran is in the row. `id`: the row that it made. */
  | { type: "written"; id?: number }
  | { type: "failed"; why: string };

export type WriterEffect = { do: "take" } | ({ do: "write"; id: number } & Write);

export const startWriter = (id: number | null): Writer => ({
  id,
  text: "",
  sha: null,
  state: { at: "running" },
  stated: true,
  size: 0,
  flight: null,
  failed: null,
});

/** Whether nothing waits and no write runs: the row has all that the job said. */
export const settled = (w: Writer) => !w.flight && !w.text && !w.sha && w.stated && (w.id != null || w.state.at == "running");

const CUT = "(The log is cut here: the rest is only where the command ran.)\n";

/** The writer after `event`, and the write to start now, or null. */
export function stepWriter(w: Writer, event: WriterEvent): { writer: Writer; effect: WriterEffect | null } {
  let next: Writer = { ...w, failed: null };
  if (event.type == "line") {
    const line = `${event.line}\n`;
    const room = MAX_LOG - w.size;
    const text = line.length <= room ? line : w.size < MAX_LOG ? CUT : "";
    next = { ...next, text: w.text + text, size: line.length <= room ? w.size + line.length : MAX_LOG };
  } else if (event.type == "commit") next = { ...next, sha: event.sha };
  else if (event.type == "end") next = w.state.at == "running" ? { ...next, state: event.state, stated: false } : next;
  else if (event.type == "written") next = { ...next, id: event.id ?? w.id, flight: null };
  else if (w.flight) {
    // What the failed write carried waits again, in front. A failure starts no write by itself: the next event does.
    const f = w.flight;
    next = {
      ...next,
      flight: null,
      text: f.text + w.text,
      sha: w.sha ?? f.sha,
      stated: w.stated && f.state.at == "running",
      failed: event.why,
    };
    return { writer: next, effect: null };
  }
  if (next.flight || settled(next)) return { writer: next, effect: null };
  // No row yet (no table when the job started): the job's end makes it, and then the writes fill it.
  if (next.id == null) {
    if (next.state.at == "running") return { writer: next, effect: null };
    const flight = { text: "", sha: null, state: { at: "running" } as const };
    return { writer: { ...next, flight }, effect: { do: "take" } };
  }
  // As many whole characters as CHUNK bytes hold. The job's end goes with the last of the text, never before it.
  const fits = new TextEncoder().encodeInto(next.text, new Uint8Array(CHUNK)).read;
  const text = next.text.slice(0, fits);
  const rest = next.text.slice(fits);
  const state: JobState = rest ? { at: "running" } : next.state;
  const flight: Write = { text, sha: next.sha, state };
  return {
    writer: { ...next, text: rest, sha: null, stated: next.stated || !rest, flight },
    effect: { do: "write", id: next.id, ...flight },
  };
}

/** A job's row, for the job to write: its lines, its commit and its end. */
export interface JobLog {
  /** The row's id, or null: the row is made when the job ends. */
  id: () => number | null;
  line: (line: string) => void;
  commit: (sha: string) => void;
  /** Ends the job, and waits for its row. The result: why the row does not have all of the job, or null. */
  end: (state: JobState) => Promise<string | null>;
}

/**
 * Starts a job: takes the instance's lock, or fails with the job that holds it. On an instance with no table yet (its
 * first deploy, or the first one of the release that brings the table), the job runs with no lock on the instance, and
 * its row is made when it ends: by then, its deploy applied the migrations.
 */
export const openJob = (sql: Sql, start: Start): Effect.Effect<JobLog, DeployError> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const id = yield* Effect.catchTag(take(sql, start, started), "NoTable", () => Effect.succeed(null));
    let writer = startWriter(id);
    let wake: (() => void) | null = null;
    const run = (effect: WriterEffect) =>
      effect.do == "take"
        ? Effect.map(take(sql, start, started), (id) => ({ type: "written", id }) as const)
        : Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.as(
              sql("UPDATE deploy_jobs SET log = log || ?, sha = coalesce(?, sha), state = ?, alive = ? WHERE id = ?", [
                effect.text,
                effect.sha,
                stateText(effect.state),
                now,
                effect.id,
              ]),
              { type: "written" } as const
            )
          );
    const on = (event: WriterEvent) => {
      const next = stepWriter(writer, event);
      writer = next.writer;
      if (next.effect)
        void Effect.runPromise(
          Effect.match(run(next.effect), {
            onSuccess: (e): WriterEvent => e,
            onFailure: (e): WriterEvent => ({
              type: "failed",
              why: e._tag == "NoTable" ? "the instance's database has no table for its deploys" : e.message,
            }),
          })
        ).then(on);
      else if (!writer.flight) wake?.();
    };
    return {
      id: () => writer.id,
      line: (line) => on({ type: "line", line }),
      commit: (sha) => on({ type: "commit", sha }),
      end: async (state) => {
        const ended = new Promise<void>((resolve) => (wake = resolve));
        on({ type: "end", state });
        if (writer.flight) await ended;
        return settled(writer) ? null : (writer.failed ?? "a write did not end");
      },
    };
  });
