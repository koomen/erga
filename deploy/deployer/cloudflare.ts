// The code steps of a deploy on Cloudflare: the database's migrations, the static files, the Worker, and the wait for
// its health. Each step is a few calls of Cloudflare's API. Nothing here asks the deployed server: the server's
// scheduled run (each minute: server/health.ts, tick) writes its health into its database, and the live step reads the
// row through D1's API. And what the steps read and undo: the Worker version that serves, the release it is, a rollback.
//
// The steps change the code only. The instance's shape (its Worker's name and address, its database, its zones and
// buckets, its secrets) is there before: setup's steps make it, with a person's own login (deploy/pipeline/).
//
// Trap: the deployer runs these steps with a credential that can run code in someone's account. A step takes its names
// from the spec only (spec.ts checks each one's pattern), and adds no call that the code steps do not need.

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Base64, Base64Url, Hex } from "effect/encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Cloudflare, DeployError, Unhealthy, tried } from "./cloudflare-api";
import { NoTable, type Sql } from "./instance";
import type { Step } from "./job";
import type { Release } from "./release-format";
import { OLD_SECRETS_KEY, readsSecretsKey, SECRETS_KEY } from "./secrets-key";
import type { CloudflareTarget } from "./spec";
import { assetHash, type CloudflareSpec, DEPLOYER_TAG, deployerName, servedAssets, typeOf, workerMetadata } from "./worker-form";

export {
  assetHash,
  bucketName,
  type CloudflareSpec,
  deployFacts,
  HEADERS_FILE,
  servedAssets,
  sharedPagesHost,
  typeOf,
  WORKER_TAG,
  workerMetadata,
} from "./worker-form";

/**
 * Where a target was before a deploy: the Worker version that served (a
 * deployment of it again is a rollback, in seconds, with no build), the release it
 * ran, and the database's D1 Time Travel bookmark from before the deploy's
 * migrations (a restore to it loses everything written since: for a person
 * to decide, never automatic). Null where there was none to record (a new
 * Worker, a token that may not read it).
 */
export interface RestorePoint { versionId: string | null; version: string | null; bookmark: string | null; at: number }

/**
 * The restore point of a target, read before a deploy changes anything: the
 * Worker version serving now (its latest deployment's), the release it runs,
 * and the database's Time Travel bookmark. Nothing here fails a deploy: what
 * can't be read is null, and `why` says so.
 */
export async function restorePoint(
  cf: Cloudflare,
  target: Pick<CloudflareTarget, "account" | "worker">,
  o: { database: Database; existing: boolean; at: number }
): Promise<{ point: RestorePoint; why: string }> {
  const acc = `/accounts/${target.account}`;
  const point: RestorePoint = { versionId: null, version: null, bookmark: null, at: o.at };
  const why: string[] = [];
  if (o.existing) {
    try {
      point.versionId = (await liveDeployment(cf, target.account, target.worker))?.versionId ?? null;
      if (!point.versionId) why.push("the Worker has no deployment yet");
    } catch (e) {
      why.push(`the Worker's deployments couldn't be read: ${(e as Error).message}`);
    }
    try {
      if (point.versionId) point.version = (await liveRelease(cf, target.account, target.worker, point.versionId)).version;
    } catch {
      /* the version id is what a rollback needs */
    }
  } else why.push("a new Worker");
  try {
    point.bookmark = await o.database.bookmark();
    if (!point.bookmark) why.push("no bookmark of the database");
  } catch (e) { why.push(`the database's bookmark couldn't be read: ${(e as Error).message}`); }
  return { point, why: why.join("; ") };
}

/**
 * What serves a Worker's requests now: its latest deployment, and the Worker version that the deployment gives the most
 * requests (after a rollback, in the dashboard too, an older one). Null: no Worker by that name, or no deployment yet.
 */
export async function liveDeployment(cf: Cloudflare, accountId: string, worker: string): Promise<{ id: string; versionId: string } | null> {
  const r = await cf.call<{ deployments?: { id: string; created_on: string; versions?: { version_id: string; percentage: number }[] }[] }>(
    "GET",
    `/accounts/${accountId}/workers/scripts/${worker}/deployments`,
    `read ${worker}'s deployments`,
    undefined,
    { allow404: true }
  );
  const latest = [...(r?.deployments ?? [])].sort((x, y) => Date.parse(y.created_on) - Date.parse(x.created_on))[0];
  const versionId = [...(latest?.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0]?.version_id;
  return latest && versionId ? { id: latest.id, versionId } : null;
}

/** Whether the account has the instance's deployer, as setup made it (deploy/pipeline/deployer.ts): a Worker with its name and its tag. */
export async function hasDeployer(cf: Cloudflare, target: Pick<CloudflareTarget, "account" | "worker">): Promise<boolean> {
  const scripts =
    (await cf.call<{ id: string; tags?: string[] }[]>("GET", `/accounts/${target.account}/workers/scripts`, "list your Workers")) ?? [];
  return !!scripts.find((s) => s.id == deployerName(target.worker))?.tags?.includes(DEPLOYER_TAG);
}

/**
 * The release that one version of a Worker is, and where the pipeline deployed it: the version's own bindings, read
 * from Cloudflare. ERGA_VERSION and ERGA_DEPLOY (workerMetadata sets both; `facts`: ERGA_DEPLOY as JSON, or null), the
 * database it binds as DB (its health row is there), and its plain settings.
 */
export async function liveRelease(
  cf: Cloudflare,
  accountId: string,
  worker: string,
  versionId: string
): Promise<{ version: string | null; facts: unknown; database: string | null; vars: Record<string, string> }> {
  const v = await cf.call<{
    resources?: { bindings?: { name: string; type: string; text?: string; id?: string; database_id?: string }[] };
  }>("GET", `/accounts/${accountId}/workers/scripts/${worker}/versions/${versionId}`, `read ${worker}'s version ${versionId.slice(0, 8)}`);
  const bindings = v?.resources?.bindings ?? [];
  const vars = Object.fromEntries(bindings.flatMap((b) => (b.type == "plain_text" && b.text != null ? [[b.name, b.text]] : [])));
  const db = bindings.find((b) => b.type == "d1" && b.name == "DB");
  return {
    version: vars.ERGA_VERSION ?? null,
    facts: Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(vars.ERGA_DEPLOY ?? "")),
    database: db?.database_id ?? db?.id ?? null,
    vars,
  };
}

/** The Worker's Cron Trigger: each minute, the server's scheduled run (server/health.ts, tick). */
export const EACH_MINUTE = "* * * * *";

/** Gives the Worker its Cron Trigger, each minute: it replaces the Worker's schedules. */
export const setSchedule = (cf: Cloudflare, acc: string, worker: string) =>
  cf.call("PUT", `${acc}/workers/scripts/${worker}/schedules`, `set ${worker}'s Cron Trigger (each minute)`, [{ cron: EACH_MINUTE }]);

/** A server's health as it wrote it into its own database (server/health.ts, tick: the one row of `health`). */
export interface HealthRow {
  at: number;
  version: string | null;
  ok: boolean;
  checks: Record<string, { ok: boolean; ms?: number; error?: string }>;
}
const checksOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({ ok: Schema.Boolean, ms: Schema.optionalKey(Schema.Number), error: Schema.optionalKey(Schema.String) })
    )
  )
);

/**
 * The health row of the server on the database `db`. Null: no row yet (its scheduled run did not run), or no table (a
 * release from before the row).
 */
export async function healthRow(db: Database): Promise<HealthRow | null> {
  const rows = await db.query("SELECT at, version, ok, checks FROM health WHERE id = 1", [], "read the server's health").catch((e) => {
      if (e instanceof DeployError && /no such table/i.test(e.message)) return [];
      throw e;
    }
  );
  const r = rows?.[0];
  if (!r) return null;
  return {
    at: Number(r.at),
    version: r.version == null ? null : String(r.version),
    ok: !!r.ok,
    checks: Option.getOrElse(checksOf(String(r.checks ?? "")), () => ({})),
  };
}

/** How old a health row may be: the server writes one each minute. An older one says nothing of the server now. */
export const HEALTH_FRESH_MS = 3 * 60_000;

/** A health row's reading: `healthy` null when the row says nothing of this release now; `why` in words; `summary` what passed. */
export interface Checked {
  healthy: boolean | null;
  why: string;
  summary: string;
}

/**
 * What a health row says of the release `want` (null: any) at `now`: healthy, not healthy (the checks that failed), or
 * nothing: no row, a row older than three minutes, or the row of another release (the one before, in the first minute
 * after a deploy). `after`: the time of the row that was there before a deploy (the server's own time): only a newer
 * row is the deploy's. Without it, a deploy of the release that runs already, with other settings, would pass on the
 * row that the version before wrote.
 */
export function readHealth(row: HealthRow | null, want: string | null, now: number, after?: number): Checked {
  const no = (why: string): Checked => ({ healthy: null, why, summary: "" });
  if (!row) return no("the server wrote no health row yet");
  const age = now - row.at;
  if (age > HEALTH_FRESH_MS) return no(`the server's last health row is ${Math.round(age / 60_000)} minutes old`);
  if (want && row.version != want) return no(`the health row is of release ${row.version ?? "?"}, not ${want}`);
  if (after != null && row.at <= after) return no("the server wrote no health row since the deploy");
  const failed = Object.entries(row.checks)
    .filter(([, c]) => !c.ok)
    .map(([n, c]) => `${n}: ${c.error ?? "failed"}`);
  if (!row.ok) return { healthy: false, why: failed.join("; ") || "the health row says not ok", summary: "" };
  const summary = Object.entries(row.checks)
    .map(([n, c]) => `${n} ok${c.ms != null ? ` ${c.ms} ms` : ""}`)
    .join(", ");
  return { healthy: true, why: "", summary: summary || "no checks" };
}

/**
 * Waits for the release `want` to write a healthy row, for at most `ms`: the row is read each 5 seconds. The result is
 * the last reading: healthy, or what the row said at the end. The server's scheduled run writes a row each minute, and
 * Cloudflare gives a Durable Object the new code seconds to minutes after the Worker: a first row can say that a
 * document does not open (2026-11-14: 42 seconds), and the next one that it does.
 */
export const settledHealth = (db: Database, want: string, ms: number, after?: number): Effect.Effect<Checked, DeployError> => {
  const read = Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () => healthRow(db),
      catch: (e) => (e instanceof DeployError ? e : new DeployError({ message: String(e) })),
    });
    return readHealth(row, want, yield* Clock.currentTimeMillis, after);
  });
  return read.pipe(
    Effect.repeat({ schedule: Schedule.spaced("5 seconds").pipe(Schedule.upTo({ duration: ms })), until: (h) => h.healthy === true })
  );
};

/**
 * Rolls a Worker back: a deployment of `versionId` at 100% (seconds; no
 * build, no upload). Its bound resources stay as they are: the database keeps
 * the schema it has (server/migrations/ only add, so the older Worker runs on it).
 */
export async function rollbackTo(
  cf: Cloudflare,
  target: Pick<CloudflareTarget, "account" | "worker">,
  versionId: string,
  message: string
): Promise<void> {
  await cf.call(
    "POST",
    `/accounts/${target.account}/workers/scripts/${target.worker}/deployments?force=true`,
    `roll ${target.worker} back to version ${versionId.slice(0, 8)}`,
    {
    // Only the message: Cloudflare refuses any other annotation ("workers/triggered_by" is its own; it refused it on 2026-10-12).
    strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }], annotations: { "workers/message": message.slice(0, 900) },
  });
}


/** An upload of the assets: tried up to four times, 1, 2 and 4 seconds apart, unless Cloudflare refused it (a 4xx but 429). */
const UPLOAD_RETRY = {
  schedule: Schedule.exponential("1 second"),
  times: 3,
  while: (e: DeployError) => !(e.status >= 400 && e.status < 500 && e.status != 429),
};

/** What an upload session, or an upload, answers. */
const UploadSession = Schema.Struct({
  jwt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  buckets: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Array(Schema.String)))),
});

/**
 * Uploads the assets Cloudflare doesn't have yet; the completion token for
 * the Worker's upload. As workers-sdk's deploy does it: the manifest opens a
 * session (its JWT, and buckets of hashes still needed), then each bucket goes
 * up as base64 multipart, or, when the JWT says so
 * (wrangler_single_asset_uploads), each file on its own as its raw bytes.
 */
export const uploadAssets = (
  cf: Cloudflare,
  acc: string,
  worker: string,
  assets: Record<string, Uint8Array>,
  label = "the editor's files"
): Effect.Effect<string, DeployError> =>
  Effect.gen(function* () {
    const manifest: Record<string, { hash: string; size: number }> = {};
    const byHash = new Map<string, string>();
    for (const [path, bytes] of Object.entries(assets)) {
      const hash = yield* Effect.promise(() => assetHash(path, bytes));
      manifest[path] = { hash, size: bytes.byteLength };
      byHash.set(hash, path);
    }
    const session = yield* cf.request(
      "POST",
      `${acc}/workers/scripts/${worker}/assets-upload-session`,
      `start uploading ${label}`,
      { manifest },
      { schema: UploadSession, need: "upload token" }
    );
    const bearer = session?.jwt;
    if (!bearer)
      return yield* new DeployError({
        message: `Cloudflare didn't start the upload of ${label}: its answer had no upload token (${JSON.stringify(session).slice(0, 300)}). Deploy again.`,
      });
    const buckets = (session.buckets ?? []).filter((b) => b.length);
    if (!buckets.length) return bearer;
    const single = jwtClaims(bearer).wrangler_single_asset_uploads === true;
    const pathOf = (hash: string) => {
      const path = byHash.get(hash);
      return path
        ? Effect.succeed(path)
        : Effect.fail(new DeployError({ message: "Cloudflare asked for a file the release doesn't have. Deploy again." }));
    };
    const upload = (bucket: readonly string[]) =>
      Effect.gen(function* () {
        if (single) {
          const path = yield* pathOf(bucket[0]);
          return yield* cf.request(
            "POST",
            `${acc}/workers/assets/upload/${bucket[0]}`,
            `upload ${path}`,
            new Blob([new Uint8Array(assets[path])], { type: typeOf(path) }),
            { bearer, schema: UploadSession }
          );
        }
        const form = new FormData();
        for (const hash of bucket) {
          const path = yield* pathOf(hash);
          form.append(hash, new File([Base64.encode(assets[path])], hash, { type: typeOf(path) }));
        }
        return yield* cf.request("POST", `${acc}/workers/assets/upload?base64=true`, `upload ${label}`, form, {
          bearer,
          schema: UploadSession,
        });
      });
    let jwt: string | null = null;
    for (const bucket of single ? buckets.flat().map((h) => [h]) : buckets) {
      const done = yield* upload(bucket).pipe(Effect.retry(UPLOAD_RETRY));
      if (done?.jwt) jwt = done.jwt;
    }
    if (!jwt)
      return yield* new DeployError({
        message: `Cloudflare took ${label} but didn't say the upload was complete (no completion token). Deploy again: files already up aren't sent twice.`,
      });
    return jwt;
  });

/** A JWT's claims, unchecked (only to read how Cloudflare wants the files sent). */
const jwtClaims = (jwt: string): Record<string, unknown> =>
  Result.match(Base64Url.decodeString(jwt.split(".")[1] ?? ""), {
    onFailure: () => ({}),
    onSuccess: (json) => Option.getOrElse(claimsOf(json), () => ({})),
  });
const claimsOf = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));

/**
 * The instance's database, as the deploy's steps reach it: through D1's API, with a person's own login (d1Api).
 */
export interface Database {
  /** One statement: its rows. */
  query: (sql: string, params: readonly (string | number | null)[], what: string) => Promise<Record<string, unknown>[]>;
  /** A migration's file and the statement that records it: all of their statements, or none. */
  apply: (file: string, record: string, what: string) => Promise<void>;
  /** The database's Time Travel bookmark, for the restore point that the log says. null: this way to the database gives none. */
  bookmark: () => Promise<string | null>;
}

/** The database `db` of the account, through D1's API. */
export const d1Api = (cf: Cloudflare, acc: string, db: string): Database => ({
  query: async (sql, params, what) => (await d1(cf, acc, db, sql, [...params], what)) ?? [],
  // One /query call (its statements run as one batch, so all or nothing), as wrangler's `d1 migrations apply --remote` sends it.
  apply: async (file, record, what) => {
    const sql = file.trim();
    await d1(cf, acc, db, `${sql}${sql.endsWith(";") ? "" : ";"}\n${record}`, [], what);
  },
  bookmark: async () =>
    (
      await cf.call<{ bookmark?: string }>(
        "GET",
        `${acc}/d1/database/${db}/time_travel/bookmark`,
        "read the database's Time Travel bookmark"
      )
    )?.bookmark ?? null,
});

/** One statement (or a few, separated by semicolons) on a D1 database, through the API: the first statement's rows. */
export async function d1(
  cf: Cloudflare,
  acc: string,
  db: string,
  sql: string,
  params: (string | number | null)[],
  what: string
): Promise<Record<string, unknown>[] | null> {
  const answer = await cf.call<{ results?: Record<string, unknown>[]; success?: boolean }[]>(
    "POST",
    `${acc}/d1/database/${db}/query`,
    what,
    { sql, ...(params.length ? { params } : {}) }
  );
  return answer?.[0]?.results ?? [];
}

/** The database a Worker's DB binding names now, or null (no Worker, no binding). */
export async function boundDatabase(cf: Cloudflare, acc: string, worker: string): Promise<string | null> {
  const settings = await cf.call<{ bindings?: { name: string; type: string; id?: string; database_id?: string }[] }>("GET", `${acc}/workers/scripts/${worker}/settings`, `read ${worker}'s settings`, undefined, { allow404: true });
  const b = settings?.bindings?.find((x) => x.type == "d1" && x.name == "DB");
  return b?.database_id ?? b?.id ?? null;
}

/** The names of the secrets that a Worker holds, as its settings list them. None: no such Worker. */
export async function secretNames(cf: Cloudflare, acc: string, worker: string): Promise<string[]> {
  const settings = await cf.call<{ bindings?: { name: string; type: string }[] }>(
    "GET",
    `${acc}/workers/scripts/${worker}/settings`,
    `read ${worker}'s settings`,
    undefined,
    { allow404: true }
  );
  return (settings?.bindings ?? [])
    .filter((b) => b.type == "secret_text")
    .map((b) => b.name)
    .sort();
}

/**
 * The instance's database, for its own record of its deploys (instance.ts): D1's API, on the database that the Worker
 * is bound to. No Worker yet, or a database from before the record's migration: NoTable.
 */
export function d1Sql(cf: Cloudflare, target: Pick<CloudflareTarget, "account" | "worker">): Sql {
  const acc = `/accounts/${target.account}`;
  let db: string | null = null;
  return (sql, params) =>
    Effect.gen(function* () {
      db ??= yield* tried(() => boundDatabase(cf, acc, target.worker));
      if (!db) return yield* new NoTable();
      const id = db;
      const rows = yield* Effect.mapError(
        tried(() => d1(cf, acc, id, sql, [...params], "read or write the instance's record of its deploys")),
        (e) => (/no such table/.test(e.message) ? new NoTable() : e)
      );
      return (rows ?? []).map((r) => String(Object.values(r)[0]));
    });
}

// ------------------------------------------------------------------ the steps

/** What runs on from one step to the next. */
export interface Carry {
  /** The database's id. Setup's own step gives it (it made the database); else the migrations step reads the Worker's binding. */
  dbId?: string;
  /** Whether the Worker was there before this deploy. */
  existing?: boolean;
  /** What the target ran before this deploy changed anything (the migrations step records it): a rollback goes back to it. */
  restore?: RestorePoint;
  /** The static files' completion token, from their upload to the Worker's. */
  assetsJwt?: string;
  /** The server wrote a health row in the minutes before the upload: its Cron Trigger runs (the live step's wait). */
  ticking?: boolean;
  /** The time of the health row that was there before the upload: the live step takes only a newer one. */
  rowAt?: number;
}

/** One deploy's run of the steps: what each step reads, and what it leaves for the next (`carry`). */
export interface CloudflareRun {
  cf: Cloudflare;
  spec: CloudflareSpec;
  release: Release;
  carry: Carry;
  /** `bun erga setup`'s first deploy only: the secrets that the Worker doesn't hold yet. The deployer gives none. */
  secrets?: Record<string, string>;
  /** How long the live step waits for the release's health row. Default: 3 minutes; 15 for a Cron Trigger that is new. */
  waitMs?: number;
  /** What the caller does when the release's code is up, before the wait for its health (deploy.ts, Ports). */
  uploaded?: Effect.Effect<void, DeployError>;
}

const accountOf = (run: CloudflareRun) => `/accounts/${run.spec.target.account}`;

/**
 * The database's id: the carry's, or the one that the Worker is bound to. A deploy of the code makes no database: an
 * instance with none stops here.
 */
async function databaseOf(run: CloudflareRun): Promise<string> {
  if (run.carry.dbId) return run.carry.dbId;
  const worker = run.spec.target.worker;
  const bound = await boundDatabase(run.cf, accountOf(run), worker);
  if (!bound)
    throw new DeployError({
      message: `The Worker ${worker} is not there, or it has no database. A deploy changes the code only: set the instance up first (bun erga setup).`,
    });
  run.carry.dbId = bound;
  run.carry.existing = true;
  return bound;
}

/**
 * The way to the instance's database: D1's API, for the database that the Worker is bound to. An instance with no
 * Worker or no database stops here.
 */
const reach = async (run: CloudflareRun): Promise<Database> => d1Api(run.cf, accountOf(run), await databaseOf(run));

// server/migrations/, each once, recorded in d1_migrations as the cf CLI does.
// First, the restore point: the last thing before the deploy changes what the target runs on.
const migrations = (run: CloudflareRun) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    tried(async () => {
      const { cf, release, carry } = run;
      const db = await reach(run);
      const restore = await restorePoint(cf, run.spec.target, { database: db, existing: !!carry.existing, at: now });
      carry.restore = restore.point;
      const noted =
        restore.point.versionId || restore.point.bookmark
          ? `restore point: ${restore.point.versionId ? `version ${restore.point.versionId.slice(0, 8)}${restore.point.version ? ` (release ${restore.point.version})` : ""}` : "no version"}, ${restore.point.bookmark ? `database bookmark ${restore.point.bookmark}` : "no database bookmark"}`
          : `no restore point (${restore.why})`;
      await db.query(
        "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
        [],
        "set up the database"
      );
      const done = new Set(
        (await db.query("SELECT name FROM d1_migrations", [], "read the database's migrations")).map((r) => String(r.name))
      );
      const pending = Object.keys(release.migrations)
        .sort()
        .filter((n) => !done.has(n));
      for (const name of pending) {
        // The file and its record in d1_migrations: all or nothing.
        await db.apply(
          release.migrations[name],
          `INSERT INTO d1_migrations (name) VALUES ('${name.replace(/'/g, "''")}');`,
          `apply the database migration ${name}`
        );
      }
      return `${pending.length ? `applied ${pending.join(", ")}` : "already up to date"}; ${noted}`;
    })
  );

// The static assets: the manifest, then each bucket Cloudflare asks for.
const assets = (run: CloudflareRun) => {
  const files = servedAssets(run.release);
  return uploadAssets(run.cf, accountOf(run), run.spec.target.worker, files).pipe(
    Effect.map((jwt) => {
      run.carry.assetsJwt = jwt;
      return `${Object.keys(files).length} files`;
    })
  );
};

// The Worker: modules, bindings (from the build's config, made the target's own), its Durable Objects, and its Cron Trigger.
const worker = (run: CloudflareRun) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    tried(async () => {
      const { cf, release, carry } = run;
      const acc = accountOf(run);
      const name = run.spec.target.worker;
      const assetsJwt = carry.assetsJwt;
      if (!assetsJwt) throw new DeployError({ message: "The editor's files weren't uploaded first: deploy again." });
      const dbId = await databaseOf(run);
      // Whether the server's scheduled run runs already (a row of the last minutes): the live step waits by it.
      const before = await healthRow(await reach(run)).catch(() => null);
      carry.ticking = readHealth(before, null, now).healthy != null;
      carry.rowAt = before?.at;
      // The instance's deployer, when setup made one: the Worker binds it, to hand it the token that a person pastes.
      const deployer = await hasDeployer(cf, run.spec.target);
      /** `rename`: Cloudflare gives the key its new name with this upload (secrets-key.ts), or refuses the upload. */
      const upload = (rename: boolean) => {
        const metadata = workerMetadata(release, run.spec, {
          dbId,
          assetsJwt,
          upload: `${release.version}-${now}`,
          secrets: run.secrets,
          deployer,
        });
        if (rename) metadata.bindings.push({ type: "inherit", name: SECRETS_KEY, old_name: OLD_SECRETS_KEY });
        const form = new FormData();
        form.set("metadata", JSON.stringify(metadata));
        for (const [module, bytes] of Object.entries(release.modules))
          form.append(module, new File([new Uint8Array(bytes)], module, { type: "application/javascript+module" }));
        return cf.call("PUT", `${acc}/workers/scripts/${name}${rename ? "?bindings_inherit=strict" : ""}`, "upload the Worker", form);
      };
      // The key under its old name (secrets-key.ts): a release that reads the new name, on a Worker whose settings list
      // no SECRETS_KEY. Cloudflare says whether there is a key to rename (10057: none), never that list: just after an
      // upload, it does not have the secrets that the Worker kept.
      const rename =
        readsSecretsKey(release) && run.secrets?.[SECRETS_KEY] == null && !(await secretNames(cf, acc, name)).includes(SECRETS_KEY);
      const moved =
        rename &&
        (await upload(true).then(
          () => true,
          (e: unknown) => {
            if (String((e as Error)?.message).includes("[code 10057]")) return false;
            throw e;
          }
        ));
      if (!moved) await upload(false);
      delete carry.assetsJwt;
      // Its Cron Trigger, each minute: the server's own health into its database, and the default homepage.
      await setSchedule(cf, acc, name);
      return `${name}, release ${release.version}; its Cron Trigger runs each minute${moved ? `; its key ${OLD_SECRETS_KEY} has the name ${SECRETS_KEY} now` : ""}`;
    })
  );

// Healthy: the release's own health row, which its scheduled run writes into its database each minute (the database,
// a document), read from the database (D1's API, or the deployer's binding). A server whose Cron Trigger ran before the deploy writes the new release's
// row in about a minute: three minutes without a healthy one is an unhealthy release, which the caller rolls back.
// A new Cron Trigger (the first deploy with one) can take up to 15 minutes to start, by Cloudflare's own words:
// the step waits that long, and then stops with no rollback.
const live = (run: CloudflareRun) =>
  Effect.gen(function* () {
    const want = run.release.version;
    const name = run.spec.target.worker;
    const ticking = !!run.carry.ticking;
    const db = yield* tried(() => reach(run));
    const h = yield* settledHealth(db, want, run.waitMs ?? (ticking ? 180_000 : 900_000), run.carry.rowAt);
    if (h.healthy) return `release ${want}, healthy (${h.summary})`;
    if (h.healthy === false)
      return yield* Effect.fail(new Unhealthy(`Release ${want} is deployed to ${name}, but its health check fails: ${h.why}`, h.why));
    if (ticking)
      return yield* Effect.fail(
        new Unhealthy(
          `Release ${want} is deployed to ${name}, but it wrote no health row in 3 minutes (${h.why}): its scheduled run fails.`,
          h.why
        )
      );
    return yield* new DeployError({
      message: `Release ${want} is deployed to ${name}, but its first health row has not come yet (${h.why}). Cloudflare can take up to 15 minutes to start a new Cron Trigger. Look again in a few minutes: bun erga status`,
    });
  });

/** The code steps of a deploy on Cloudflare, in order. Every step is safe to run again. */
export const CLOUDFLARE_STEPS = [
  { id: "migrations", title: "Set up the database's tables", run: migrations },
  { id: "assets", title: "Upload the editor's files", run: assets },
  {
    id: "worker",
    title: "Upload the Worker, with its settings and secrets",
    run: (run: CloudflareRun) => Effect.flatMap(worker(run), (detail) => Effect.as(run.uploaded ?? Effect.void, detail)),
  },
  { id: "live", title: "Wait for its health", run: live },
] as const satisfies readonly (Step & { run: (run: CloudflareRun) => Effect.Effect<string, DeployError> })[];
