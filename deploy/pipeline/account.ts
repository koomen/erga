// What the pipeline's steps do in the account: the Worker's upload (its bindings, buckets and assets), its database
// (export and import), its health (the row that the server writes into its database each minute) and its version, and
// a rollback. Nothing here asks the deployed server: Cloudflare's API answers.

import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Base64, Base64Url } from "effect/encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Cloudflare, DeployError, type Fetch } from "./cloudflare-api";
import type { Release } from "./release-format";
import { bindingsProblem, passedBinding } from "./bindings";
import type { RestorePoint, Target } from "./pipeline";
import { sha256Hex } from "../../shared/bytes";

/** The tag the deploy puts on the Workers it makes, so a second run knows them as its own. */
export const WORKER_TAG = "erga-deploy";

/** The shared pages host's Worker: every request to the app, as it came (the app tells pages requests by their host, PAGES_HOST). */
export const PAGES_PROXY = `export default { fetch: (request, env) => env.APP.fetch(request) };\n`;

/** The build's file of headers for its static assets (Cloudflare's _headers): it goes in the Worker's config, not among the files. */
export const HEADERS_FILE = "/_headers";

/** The static assets as uploaded: all of the release's but its _headers. */
export const servedAssets = (release: Release) => Object.fromEntries(Object.entries(release.assets).filter(([p]) => p != HEADERS_FILE));

/**
 * The Worker's upload metadata: the build's bindings (cloudflare.config.ts
 * as `cf build` wrote it), each made the target's own: its database, its
 * text settings, its secrets, its services and where its pages run.
 */
export function workerMetadata(release: Release, target: Target, o: { dbId: string; assetsJwt: string; pagesHost: string | null }) {
  const w = release.worker;
  // Which release this is, and where it is deployed: the CLI reads both from the version's bindings (liveRelease).
  const text: Record<string, string> = { ERGA_VERSION: release.version, ERGA_DEPLOY: JSON.stringify(deployFacts(target)), ...target.vars };
  const secrets = target.secrets;
  const bindings: Record<string, unknown>[] = [];
  const named = new Set<string>();
  for (const [name, b] of Object.entries(w.env)) {
    named.add(name);
    if (b.type == "durable-object") bindings.push({ type: "durable_object_namespace", name, class_name: b.exportName });
    else if (b.type == "d1") bindings.push({ type: "d1", name, database_id: o.dbId, id: o.dbId });
    else if (b.type == "assets") bindings.push({ type: "assets", name });
    else if (b.type == "text") bindings.push({ type: "plain_text", name, text: text[name] ?? b.value ?? "" });
    else if (b.type == "secret") { if (secrets[name] != null) bindings.push({ type: "secret_text", name, text: secrets[name] }); }
    else if (b.type == "service" && b.name && target.services?.[name]) bindings.push(serviceBinding(name, target.services[name]));
    // A bucket of the target's own (documents' files: FILES), made before the upload if it isn't there (ensureBuckets).
    else if (b.type == "r2") bindings.push({ type: "r2_bucket", name, bucket_name: bucketName(target, name) });
    // Any other kind is the same on every target: the release's own metadata for it, sent as it is (bindings.ts).
    else {
      const passed = passedBinding(release, name, b);
      if (!passed) throw new DeployError({ message: bindingsProblem(release)! });
      bindings.push(passed);
    }
  }
  // Settings and secrets the build doesn't declare (the version, the account, the branch deploys' own secrets), and services.
  for (const [name, value] of Object.entries(text)) if (!named.has(name)) { bindings.push({ type: "plain_text", name, text: value }); named.add(name); }
  for (const [name, value] of Object.entries(secrets)) if (!named.has(name)) { bindings.push({ type: "secret_text", name, text: value }); named.add(name); }
  for (const [name, service] of Object.entries(target.services ?? {})) if (!named.has(name)) { bindings.push(serviceBinding(name, service)); named.add(name); }
  // Where documents' pages run: a domain of their own, or the shared host.
  if (target.pages.kind == "zone") bindings.push({ type: "plain_text", name: "PAGES_DOMAIN", text: target.pages.domain ?? target.pages.zoneName });
  else bindings.push({ type: "plain_text", name: "PAGES_HOST", text: o.pagesHost });
  // Durable Objects as declarative exports, as `cf deploy` sends them: the platform makes each namespace on the first
  // deploy and matches it after, with no migration tags, so a deploy run again (or retried) is the same deploy.
  const exports = Object.fromEntries(
    Object.entries(w.exports ?? {})
      .filter(([, e]) => e.type == "durable-object")
      .map(([n, e]) => [n, { type: "durable-object", storage: e.storage ?? "sqlite" }])
  );
  return {
    main_module: release.mainModule,
    compatibility_date: w.compatibilityDate,
    compatibility_flags: w.compatibilityFlags ?? [],
    bindings,
    // Secrets set once on the Worker stay from version to version, as with `cf deploy`.
    ...(target.keepSecrets ? { keep_bindings: ["secret_text", "secret_key"] } : {}),
    assets: {
      jwt: o.assetsJwt,
      config: {
        html_handling: w.assets?.htmlHandling ?? "auto-trailing-slash", not_found_handling: w.assets?.notFoundHandling ?? "none", run_worker_first: w.assets?.runWorkerFirst ?? false,
        // The headers Cloudflare gives the files it serves without the Worker (the build's _headers, client/build.ts).
        ...(release.assets[HEADERS_FILE] ? { _headers: new TextDecoder().decode(release.assets[HEADERS_FILE]) } : {}),
      },
    },
    observability: { enabled: !!w.observability?.enabled, logs: { enabled: !!w.observability?.logs?.enabled, invocation_logs: !!w.observability?.logs?.invocationLogs } },
    ...(Object.keys(exports).length ? { exports } : {}),
    tags: [WORKER_TAG],
  };
}

/**
 * Where a target is deployed, as its Worker holds it (the binding ERGA_DEPLOY) and its entry in .erga/config.json: the
 * target's own names and its plain settings (vars). `bun erga register` reads it from Cloudflare (liveRelease), so a
 * machine can deploy the instance again with no list of instances in the code. Never a secret: the secrets stay on the
 * Worker.
 */
export const deployFacts = (t: Target) => ({
  account: t.accountId,
  worker: t.workerName,
  database: t.databaseName,
  ...(t.subdomain ? { subdomain: t.subdomain } : {}),
  app: t.app,
  pages: t.pages,
  ...(t.domains?.length ? { domains: t.domains } : {}),
  vars: t.vars,
});

/**
 * The R2 bucket a target binds as `binding`: one of its own, named after its
 * Worker (FILES on the Worker example is example-files), so no two targets share one.
 */
export const bucketName = (target: Pick<Target, "workerName">, binding: string) => `${target.workerName}-${binding.toLowerCase().replace(/_/g, "-")}`;

/**
 * Makes each R2 bucket the release binds that the target's account doesn't
 * have yet. A credential that may not read the account's buckets (a token
 * with no R2 permission) goes on: the upload says in Cloudflare's words
 * if a bucket is missing.
 */
export async function ensureBuckets(cf: Cloudflare, acc: string, release: Release, target: Target): Promise<void> {
  for (const [name, b] of Object.entries(release.worker.env)) {
    if (b.type != "r2") continue;
    const bucket = bucketName(target, name);
    const found = await cf.call<{ buckets?: { name: string }[] }>("GET", `${acc}/r2/buckets?name_contains=${encodeURIComponent(bucket)}`, `look for the R2 bucket ${bucket}`).catch((e) => {
      if (e instanceof DeployError && (e.status == 403 || e.status == 401)) return "not allowed" as const;
      throw e;
    });
    if (found == "not allowed" || found?.buckets?.some((x) => x.name == bucket)) continue;
    await cf.call("POST", `${acc}/r2/buckets`, `make the R2 bucket ${bucket} (documents' files)`, { name: bucket });
  }
}

/** A service binding's metadata: the Worker, and its entrypoint when it isn't the default export. */
const serviceBinding = (name: string, to: string | { service: string; entrypoint?: string }) =>
  typeof to == "string" ? { type: "service", name, service: to } : { type: "service", name, service: to.service, ...(to.entrypoint ? { entrypoint: to.entrypoint } : {}) };

/**
 * The account's Workers, as the account step needs them (is the target's
 * there, and is it Erga's). A token scoped to some Workers only may not list the account's: then the
 * target's own settings answer whether it's there and Erga's.
 */
export async function listScripts(
  cf: Cloudflare,
  acc: string,
  target: Target
): Promise<{ id: string; tags?: string[]; named_handlers?: { name?: string }[] }[]> {
  try {
    const all = (await cf.call<{ id: string; tags?: string[]; named_handlers?: { name?: string }[] }[]>("GET", `${acc}/workers/scripts`, "list your Workers")) ?? [];
    // A scoped token's list may hold only the Workers it can see: the target's own settings are the answer then.
    if (all.some((s) => s.id == target.workerName) || !target.keepSecrets) return all;
  } catch (e) {
    if (!(target.keepSecrets && e instanceof DeployError && e.status == 403)) throw e;
  }
  const settings = await cf.call<{ tags?: string[]; bindings?: { type: string; class_name?: string }[] }>("GET", `${acc}/workers/scripts/${target.workerName}/settings`, `read ${target.workerName}'s settings`, undefined, { allow404: true });
  if (!settings) return [];
  const docHost = settings.bindings?.some((b) => b.type == "durable_object_namespace" && b.class_name == "DocumentObject");
  return [{ id: target.workerName, tags: settings.tags ?? [], named_handlers: docHost ? [{ name: "DocumentObject" }] : [] }];
}

/**
 * The restore point of a target, read before a deploy changes anything: the
 * Worker version serving now (its latest deployment's), the release it runs,
 * and the database's Time Travel bookmark. Nothing here fails a deploy: what
 * can't be read is null, and `why` says so.
 */
export async function restorePoint(cf: Cloudflare, target: Pick<Target, "accountId" | "workerName">, o: { dbId: string; existing: boolean }): Promise<{ point: RestorePoint; why: string }> {
  const acc = `/accounts/${target.accountId}`;
  const point: RestorePoint = { versionId: null, version: null, bookmark: null, at: Date.now() };
  const why: string[] = [];
  if (o.existing) {
    try {
      point.versionId = (await liveDeployment(cf, target.accountId, target.workerName))?.versionId ?? null;
      if (!point.versionId) why.push("the Worker has no deployment yet");
    } catch (e) {
      why.push(`the Worker's deployments couldn't be read: ${(e as Error).message}`);
    }
    try {
      if (point.versionId) point.version = (await liveRelease(cf, target.accountId, target.workerName, point.versionId)).version;
    } catch {
      /* the version id is what a rollback needs */
    }
  } else why.push("a new Worker");
  try {
    const b = await cf.call<{ bookmark?: string }>("GET", `${acc}/d1/database/${o.dbId}/time_travel/bookmark`, "read the database's Time Travel bookmark");
    point.bookmark = b?.bookmark ?? null;
    if (!point.bookmark) why.push("D1 gave no bookmark");
  } catch (e) { why.push(`the database's bookmark couldn't be read: ${(e as Error).message}`); }
  // In the Worker's logs too (the deploy log is admins' only): what a rollback can go back to.
  console.log(`restore point of ${target.workerName}: version ${point.versionId ?? "none"}, release ${point.version ?? "unknown"}, bookmark ${point.bookmark ?? "none"}${why.length ? ` (${why.join("; ")})` : ""}`);
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
 * The health row of the server on the database `db`, read through D1's API. Null: no row yet (its scheduled run did
 * not run), or no table (a release from before the row).
 */
export async function healthRow(cf: Cloudflare, acc: string, db: string): Promise<HealthRow | null> {
  const rows = await d1(cf, acc, db, "SELECT at, version, ok, checks FROM health WHERE id = 1", [], "read the server's health").catch(
    (e) => {
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
 * after a deploy).
 */
export function readHealth(row: HealthRow | null, want: string | null, now: number): Checked {
  const no = (why: string): Checked => ({ healthy: null, why, summary: "" });
  if (!row) return no("the server wrote no health row yet");
  const age = now - row.at;
  if (age > HEALTH_FRESH_MS) return no(`the server's last health row is ${Math.round(age / 60_000)} minutes old`);
  if (want && row.version != want) return no(`the health row is of release ${row.version ?? "?"}, not ${want}`);
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
export const settledHealth = (cf: Cloudflare, acc: string, db: string, want: string, ms: number): Effect.Effect<Checked, DeployError> => {
  const read = Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () => healthRow(cf, acc, db),
      catch: (e) => (e instanceof DeployError ? e : new DeployError({ message: String(e) })),
    });
    return readHealth(row, want, yield* Clock.currentTimeMillis);
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
export async function rollbackTo(cf: Cloudflare, target: Pick<Target, "accountId" | "workerName">, versionId: string, message: string): Promise<void> {
  await cf.call("POST", `/accounts/${target.accountId}/workers/scripts/${target.workerName}/deployments?force=true`, `roll ${target.workerName} back to version ${versionId.slice(0, 8)}`, {
    // Only the message: Cloudflare refuses any other annotation ("workers/triggered_by" is its own; it refused it on 2026-10-12).
    strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }], annotations: { "workers/message": message.slice(0, 900) },
  });
}

/**
 * The state of the certificate for `hostname` on its zone ("active", "pending_validation", ...), read from Cloudflare:
 * the hostname's own certificate, else one that covers it by a wildcard. Null: none names it, or the credential may not
 * read the zone's certificates. The deploy says it; nothing asks the address itself.
 */
export async function certificateOf(cf: Cloudflare, zoneId: string, hostname: string): Promise<string | null> {
  const packs = await cf
    .call<{ hosts?: string[]; status?: string }[]>(
      "GET",
      `/zones/${zoneId}/ssl/certificate_packs?status=all`,
      `read ${hostname}'s certificate`
    )
    .catch(() => null);
  const wild = `*.${hostname.split(".").slice(1).join(".")}`;
  const pack = packs?.find((p) => p.hosts?.includes(hostname)) ?? packs?.find((p) => p.hosts?.includes(wild));
  return pack?.status ?? null;
}

/** A D1 database's id by name, or null. */
export async function findDatabase(cf: Cloudflare, acc: string, name: string): Promise<string | null> {
  return ((await cf.call<{ uuid: string; name: string }[]>("GET", `${acc}/d1/database?name=${encodeURIComponent(name)}`, "list your D1 databases")) ?? []).find((d) => d.name == name)?.uuid ?? null;
}

/** A zone's id, by its name, in the account. */
export async function zoneIdOf(cf: Cloudflare, accountId: string, name: string): Promise<string> {
  const zones = (await cf.call<{ id: string; name: string }[]>("GET", `/zones?name=${encodeURIComponent(name)}&account.id=${accountId}`, `find the zone ${name}`)) ?? [];
  const zone = zones.find((z) => z.name == name);
  if (!zone) throw new DeployError({ message: `The account has no zone called ${name}: add it to Cloudflare first.` });
  return zone.id;
}

/** The static assets' 32-hex hash, as Cloudflare's direct upload takes it: SHA-256 of the base64 contents and the extension. */
export async function assetHash(path: string, bytes: Uint8Array): Promise<string> {
  const ext = /\.([^./]+)$/.exec(path)?.[1] ?? "";
  return (await sha256Hex(Base64.encode(bytes) + ext)).slice(0, 32);
}

const TYPES: Record<string, string> = { html: "text/html", js: "application/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", woff2: "font/woff2", woff: "font/woff", png: "image/png", ico: "image/x-icon", txt: "text/plain", md: "text/markdown", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", pdf: "application/pdf", xml: "application/xml", mp4: "video/mp4", webmanifest: "application/manifest+json" };
export const typeOf = (path: string) => TYPES[/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";

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

/** MD5, as hex: the checksum D1's import takes (etag). */
const md5hex = (text: string) => createHash("md5").update(text).digest("hex");
