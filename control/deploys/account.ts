// What the pipeline's steps do in the account: the Worker's upload (its bindings, buckets and assets), its database
// (export and import), its health and its version, and a rollback.

import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { Base64, Base64Url } from "effect/encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Cloudflare, DeployError, type Fetch } from "./cloudflare-api";
import type { Release } from "./release-format";
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
export function workerMetadata(release: Release, target: Target, o: { dbId: string; assetsJwt: string; pagesHost: string | null; existing?: boolean }) {
  const w = release.worker;
  // Which release this is (GET /api/deploys/version answers it), and which account the server is in (for its own branch deploys).
  const text: Record<string, string> = { ERGA_VERSION: release.version, CLOUDFLARE_ACCOUNT_ID: target.accountId, ...target.vars };
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
    // Erga's own source: only on a target that names the namespace; elsewhere left out.
    else if (b.type == "artifacts") { if (target.artifacts) bindings.push({ type: "artifacts", name, namespace: target.artifacts }); }
    // A bucket of the target's own (documents' files: FILES), made before the upload if it isn't there (ensureBuckets).
    else if (b.type == "r2") bindings.push({ type: "r2_bucket", name, bucket_name: bucketName(target, name) });
    // A Worker Loader: the Worker runs code it loads, in a sandbox of its own (a page's own API, for agents' calls).
    else if (b.type == "worker-loader") bindings.push({ type: "worker_loader", name });
    else
      throw new DeployError({
        message: `This release has a binding this page doesn't know how to make (${name}, ${b.type}): it needs a newer deploy page.`,
      });
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
  // A "deleted" tombstone (erga.dev's DocList) goes only to a Worker that's there already: a new one has nothing to delete.
  const exports = Object.fromEntries(Object.entries(w.exports ?? {})
    .filter(([, e]) => e.type == "durable-object" && (o.existing || e.state != "deleted"))
    .map(([n, e]) => [n, e.state == "deleted" ? { type: "durable-object", state: "deleted" } : { type: "durable-object", storage: e.storage ?? "sqlite" }]));
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
 * The R2 bucket a target binds as `binding`: one of its own, named after its
 * Worker (FILES on erga is erga-files, on erga-staging erga-staging-files),
 * so no two targets share one.
 */
export const bucketName = (target: Pick<Target, "workerName">, binding: string) => `${target.workerName}-${binding.toLowerCase().replace(/_/g, "-")}`;

/**
 * Makes each R2 bucket the release binds that the target's account doesn't
 * have yet. A credential that may not read the account's buckets (the
 * control Worker's grant has no R2 scope) goes on: the buckets of Erga's own
 * targets are made once, by hand, and the upload says in Cloudflare's words
 * if one is missing.
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
 * there, and is it Erga's). A token scoped to some Workers only (Erga's own
 * credential, control/deploys/credential.ts) may not list the account's: then the
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
    try { point.versionId = await liveVersion(cf, target.accountId, target.workerName); if (!point.versionId) why.push("the Worker has no deployment yet"); } catch (e) { why.push(`the Worker's deployments couldn't be read: ${(e as Error).message}`); }
    try { point.version = await workerVersion(cf, target.accountId, target.workerName); } catch { /* the version id is what a rollback needs */ }
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

/** The Worker version serving now: the one its latest deployment names (null: no deployment). */
export async function liveVersion(cf: Cloudflare, accountId: string, worker: string): Promise<string | null> {
  const r = await cf.call<{ deployments?: { versions?: { version_id: string; percentage: number }[] }[] }>("GET", `/accounts/${accountId}/workers/scripts/${worker}/deployments?per_page=1`, `read ${worker}'s deployments`);
  const latest = r?.deployments?.[0]?.versions ?? [];
  return [...latest].sort((a, b) => b.percentage - a.percentage)[0]?.version_id ?? null;
}

/** What the health check answers (GET /api/health: the app's own checks), as the pipeline reads it. */
export const Health = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.optionalKey(Schema.NullOr(Schema.String)),
  checks: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({ ok: Schema.Boolean, ms: Schema.optionalKey(Schema.Number), error: Schema.optionalKey(Schema.String) })
    )
  ),
});
export type Health = typeof Health.Type;
const healthOf = Schema.decodeUnknownOption(Schema.fromJsonString(Health));

/** A health check's result: `why` says what failed, in words; `summary` what passed. */
export interface Checked {
  ok: boolean;
  why: string;
  summary: string;
}

/**
 * The app's health, at `host`: GET /api/health must answer 200 with ok true
 * and the release `want` (when given). It never fails: a check that can't be
 * made is a check that didn't pass.
 */
export const checkHealth = (site: Fetch, host: string, want: string | null, o: { query?: string } = {}): Effect.Effect<Checked> =>
  Effect.promise(async (): Promise<Checked> => {
    const r = await site(`https://${host}/api/health${o.query ? `?${o.query}` : ""}`).catch(() => null);
    const body = Option.getOrNull(healthOf(r ? await r.text().catch(() => "") : ""));
    if (!r || !body) return { ok: false, why: `GET /api/health answered ${r?.status || "nothing"} and no JSON`, summary: "" };
    const failed = Object.entries(body.checks ?? {}).filter(([, c]) => !c.ok).map(([n, c]) => `${n}: ${c.error ?? "failed"}`);
    if (!r.ok || !body.ok) return { ok: false, why: failed.length ? failed.join("; ") : `GET /api/health answered ${r.status}`, summary: "" };
    if (want && body.version && body.version != want) return { ok: false, why: `GET /api/health says release ${body.version}, not ${want}`, summary: "" };
    return { ok: true, why: "", summary: Object.entries(body.checks ?? {}).map(([n, c]) => `${n} ok${c.ms != null ? ` ${c.ms} ms` : ""}`).join(", ") || "no checks" };
  });

/** A release that answers its version: healthy, or unhealthy three times over ten seconds (one slow cold start isn't a broken release). */
export const settledHealth = (site: Fetch, host: string, want: string, o: { query?: string } = {}): Effect.Effect<Checked> =>
  checkHealth(site, host, want, o).pipe(Effect.repeat({ schedule: Schedule.spaced("5 seconds"), times: 2, until: (h) => h.ok }));

/**
 * The wait for a new release to answer, for at most `ms`: a second, then half
 * a second longer each time, at most five seconds apart (a new workers.dev
 * address or certificate can take a minute or two).
 */
export const untilUp = (ms: number) =>
  Schedule.spaced("1 second").pipe(
    Schedule.modifyDelay(({ attempt }) => Effect.succeed(Math.min(5000, 500 + attempt * 500))),
    Schedule.upTo({ duration: ms })
  );

/**
 * The version a release says it is (GET /api/deploys/version, or the health check's), or "" when it doesn't answer.
 * `anyStatus`: an answer that isn't 200 counts too (an unhealthy release still says its version).
 */
export const answeredVersion = (site: Fetch, url: string, o: { anyStatus?: boolean } = {}): Effect.Effect<string> =>
  Effect.promise(async () => {
    const r = await site(url).catch(() => null);
    return r && (r.ok || o.anyStatus) ? (Option.getOrNull(versionOf(await r.text().catch(() => "")))?.version ?? "") : "";
  });
const versionOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.optionalKey(Schema.NullOr(Schema.String)) }))
);

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

/** The release a Worker runs, by its ERGA_VERSION setting (the pipeline sets it), or null. */
export async function workerVersion(cf: Cloudflare, accountId: string, worker: string): Promise<string | null> {
  const settings = await cf.call<{ bindings?: { name: string; type: string; text?: string }[] }>("GET", `/accounts/${accountId}/workers/scripts/${worker}/settings`, `read ${worker}'s settings`, undefined, { allow404: true });
  return settings?.bindings?.find((b) => b.name == "ERGA_VERSION" && b.type == "plain_text")?.text ?? null;
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

/**
 * A D1 database as SQL, through D1's export (POST …/export, polled until
 * it's ready, then the file from its signed URL), as `wrangler d1 export
 * --remote` does. Read-only on the database (it's never written to); D1
 * holds the database's writes for the moment the export takes.
 */
export const exportD1 = (cf: Cloudflare, acc: string, dbId: string, name: string, site: Fetch): Effect.Effect<string, DeployError> => {
  let bookmark: string | undefined;
  const ask = Effect.suspend(() =>
    cf.request(
      "POST",
      `${acc}/d1/database/${dbId}/export`,
      `export ${name} (read-only)`,
      { output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) },
      { schema: D1Export }
    )
  ).pipe(
    Effect.tap((r) => {
      if (r?.error || r?.status == "error")
        return new DeployError({ message: `D1 couldn't export ${name}: ${r?.error ?? "it said it failed"}.` });
      bookmark = r?.at_bookmark ?? bookmark;
      return Effect.void;
    })
  );
  const ready = (r: D1Export | null) => r?.status == "complete" && !!r.result?.signed_url;
  return Effect.gen(function* () {
    // Asked again each second until the file is ready: at most 300 times more.
    const r = yield* ask.pipe(Effect.repeat({ schedule: POLL, times: 300, until: ready }));
    const url = ready(r) ? r!.result!.signed_url! : null;
    if (!url) return yield* new DeployError({ message: `D1's export of ${name} took too long. Deploy again.` });
    const file = yield* Effect.promise(() => site(url).catch(() => null));
    if (!file?.ok)
      return yield* new DeployError({
        message: `D1 exported ${name}, but its file couldn't be downloaded (${file?.status ?? "no answer"}). Deploy again.`,
      });
    return yield* Effect.promise(() => file.text());
  });
};

/** D1's answer to an export, polled. */
const D1Export = Schema.Struct({
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  at_bookmark: Schema.optionalKey(Schema.NullOr(Schema.String)),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  result: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ signed_url: Schema.optionalKey(Schema.String), filename: Schema.optionalKey(Schema.String) }))
  ),
});
type D1Export = typeof D1Export.Type;

/** D1's answer at each step of an import. */
const D1Import = Schema.Struct({
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  success: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  filename: Schema.optionalKey(Schema.NullOr(Schema.String)),
  upload_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  at_bookmark: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
type D1Import = typeof D1Import.Type;

/** How often D1's export and import are asked whether they're done. */
const POLL = Schedule.spaced("1 second");

/**
 * SQL into a D1 database, through D1's import (init with the file's MD5,
 * upload to the URL it gives, ingest, poll), as `wrangler d1 execute
 * --remote --file` does.
 */
export const importD1 = (
  cf: Cloudflare,
  acc: string,
  dbId: string,
  name: string,
  sql: string,
  site: Fetch
): Effect.Effect<void, DeployError> =>
  Effect.gen(function* () {
    const etag = md5hex(sql);
    const path = `${acc}/d1/database/${dbId}/import`;
    const init = yield* cf.request("POST", path, `start loading the copy into ${name}`, { action: "init", etag }, { schema: D1Import });
    const upload = init?.upload_url;
    if (upload) {
      const put = yield* Effect.promise(() => site(upload, { method: "PUT", body: sql }).catch(() => null));
      if (!put?.ok)
        return yield* new DeployError({
          message: `The copy couldn't be uploaded for ${name} (${put?.status ?? "no answer"}). Deploy again.`,
        });
      const got = put.headers.get("etag")?.replace(/"/g, "");
      if (got && got != etag)
        return yield* new DeployError({
          message: `The copy uploaded for ${name} arrived changed (its checksum doesn't match). Deploy again.`,
        });
    }
    const ingest = yield* cf.request(
      "POST",
      path,
      `load the copy into ${name}`,
      { action: "ingest", etag, filename: init?.filename },
      { schema: D1Import }
    );
    if (ingest?.status == "complete") return;
    let bookmark = ingest?.at_bookmark;
    const done = (r: D1Import | null) => r?.status == "complete" || r?.error == "Not currently importing anything.";
    const ask = Effect.suspend(() =>
      cf.request(
        "POST",
        path,
        `check on loading the copy into ${name}`,
        { action: "poll", current_bookmark: bookmark },
        { schema: D1Import }
      )
    ).pipe(
      Effect.tap((r) => {
        if (done(r)) return Effect.void;
        if (r?.status == "error" || (r?.error && r.success === false))
          return new DeployError({ message: `D1 couldn't load the copy into ${name}: ${r?.error ?? "it said it failed"}.` });
        bookmark = r?.at_bookmark ?? bookmark;
        return Effect.void;
      })
    );
    // Asked again each second until it's loaded: at most 300 times more.
    const r = yield* ask.pipe(Effect.repeat({ schedule: POLL, times: 300, until: done }));
    if (!done(r)) return yield* new DeployError({ message: `Loading the copy into ${name} took too long. Deploy again.` });
  });

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
/**
 * The API keys a server stored itself, into the new copy of
 * another server's data it moves to: the copy's rows (the other server's,
 * encrypted with its FACTORY_KEY, so they don't open here) go, and the rows of
 * the copy it was on (`from`; none on its first copy) come in. Without this,
 * each new copy would drop staging's Anthropic key, and its agents would stop. The same for each person's own keys.
 */
export async function ownCredentials(cf: Cloudflare, acc: string, from: string | null, to: string): Promise<string> {
  const rows = from ? (await d1(cf, acc, from, "SELECT * FROM credentials", [], "read the API keys this server stored")) ?? [] : [];
  await d1(cf, acc, to, "DELETE FROM credentials", [], "remove the other server's API keys from the copy");
  for (const r of rows) {
    const cols = Object.keys(r).filter((c) => /^\w+$/.test(c));
    await d1(cf, acc, to, `INSERT INTO credentials (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`, cols.map((c) => r[c] as string | number | null), `keep the API key ${String(r.name)}`);
  }
  // Each person's own keys too (server/migrations/0290_person_keys.sql): production's people's keys never stay in the
  // copy, and the copy it was on keeps its own (none if its copy is older than the table).
  const theirs = from
    ? ((await d1(cf, acc, from, "SELECT * FROM person_keys", [], "read the people's own API keys this server stored").catch(() => null)) ??
      [])
    : [];
  await d1(cf, acc, to, "DELETE FROM person_keys", [], "remove the other server's people's API keys from the copy");
  for (const r of theirs)
    await d1(
      cf,
      acc,
      to,
      "INSERT INTO person_keys (login, name, iv, data, last4, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ["login", "name", "iv", "data", "last4", "updated"].map((c) => r[c] as string | number | null),
      "keep a person's own API key"
    );
  return `${rows.length ? `its own API keys kept (${rows.map((r) => String(r.name)).join(", ")})` : "no API keys of its own to keep"}; ${theirs.length} of its people's own keys kept`;
}

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
