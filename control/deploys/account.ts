// What the pipeline's steps do in the account: the Worker's upload (its bindings, buckets and assets), its database
// (export and import), its health and its version, and a rollback.

import { createHash } from "node:crypto";
import { Cloudflare, DeployError, type Fetch } from "./cloudflare-api";
import type { Release } from "./release-format";
import type { RestorePoint, Target } from "./pipeline";
import { base64, fromBase64url, sha256Hex } from "../../shared/bytes";
import { sleep } from "../../shared/time";

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
  // Which release this is (GET /api/deploys/version answers it), when this upload was made (a document's object older
  // than its caller restarts: cloudflare/objects/document-stub.ts), and which account the server is in (for its own branch deploys).
  const text: Record<string, string> = { ERGA_VERSION: release.version, ERGA_DEPLOYED: String(Date.now()), CLOUDFLARE_ACCOUNT_ID: target.accountId, ...target.vars };
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
    else throw new DeployError(`This release has a binding this page doesn't know how to make (${name}, ${b.type}): it needs a newer deploy page.`);
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
export interface Health { ok: boolean; version?: string | null; checks?: Record<string, { ok: boolean; ms?: number; error?: string }> }

/**
 * The app's health, at `host`: GET /api/health must answer 200 with ok true
 * and the release `want` (when given). `why` says what failed, in words.
 */
export async function checkHealth(site: Fetch, host: string, want: string | null, o: { query?: string } = {}): Promise<{ ok: boolean; why: string; summary: string }> {
  const r = await site(`https://${host}/api/health${o.query ? `?${o.query}` : ""}`).catch((e) => ({ ok: false, status: 0, json: async () => null, text: async () => (e as Error).message }) as unknown as Response);
  const body = (await r.json().catch(() => null)) as Health | null;
  if (!body) return { ok: false, why: `GET /api/health answered ${r.status || "nothing"} and no JSON`, summary: "" };
  const failed = Object.entries(body.checks ?? {}).filter(([, c]) => !c.ok).map(([n, c]) => `${n}: ${c.error ?? "failed"}`);
  if (!r.ok || !body.ok) return { ok: false, why: failed.length ? failed.join("; ") : `GET /api/health answered ${r.status}`, summary: "" };
  if (want && body.version && body.version != want) return { ok: false, why: `GET /api/health says release ${body.version}, not ${want}`, summary: "" };
  return { ok: true, why: "", summary: Object.entries(body.checks ?? {}).map(([n, c]) => `${n} ok${c.ms != null ? ` ${c.ms} ms` : ""}`).join(", ") || "no checks" };
}

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
  if (!zone) throw new DeployError(`The account has no zone called ${name}: add it to Cloudflare first.`);
  return zone.id;
}

/**
 * A D1 database as SQL, through D1's export (POST …/export, polled until
 * it's ready, then the file from its signed URL), as `wrangler d1 export
 * --remote` does. Read-only on the database (it's never written to); D1
 * holds the database's writes for the moment the export takes.
 */
export async function exportD1(cf: Cloudflare, acc: string, dbId: string, name: string, site: Fetch, sleep: (ms: number) => Promise<void>): Promise<string> {
  let bookmark: string | undefined;
  for (let tries = 0; ; tries++) {
    const r = await cf.call<{ status?: string; at_bookmark?: string; error?: string; result?: { signed_url?: string; filename?: string } }>(
      "POST", `${acc}/d1/database/${dbId}/export`, `export ${name} (read-only)`, { output_format: "polling", ...(bookmark ? { current_bookmark: bookmark } : {}) });
    if (r?.error || r?.status == "error") throw new DeployError(`D1 couldn't export ${name}: ${r?.error ?? "it said it failed"}.`);
    if (r?.status == "complete" && r.result?.signed_url) {
      const file = await site(r.result.signed_url).catch(() => null);
      if (!file?.ok) throw new DeployError(`D1 exported ${name}, but its file couldn't be downloaded (${file?.status ?? "no answer"}). Deploy again.`);
      return await file.text();
    }
    bookmark = r?.at_bookmark ?? bookmark;
    if (tries >= 300) throw new DeployError(`D1's export of ${name} took too long. Deploy again.`);
    await sleep(1000);
  }
}

/**
 * SQL into a D1 database, through D1's import (init with the file's MD5,
 * upload to the URL it gives, ingest, poll), as `wrangler d1 execute
 * --remote --file` does.
 */
export async function importD1(cf: Cloudflare, acc: string, dbId: string, name: string, sql: string, site: Fetch, sleep: (ms: number) => Promise<void>): Promise<void> {
  const etag = md5hex(sql);
  const path = `${acc}/d1/database/${dbId}/import`;
  type Answer = { status?: string; success?: boolean; error?: string; filename?: string; upload_url?: string; at_bookmark?: string };
  const init = await cf.call<Answer>("POST", path, `start loading the copy into ${name}`, { action: "init", etag });
  if (init?.upload_url) {
    const put = await site(init.upload_url, { method: "PUT", body: sql }).catch(() => null);
    if (!put?.ok) throw new DeployError(`The copy couldn't be uploaded for ${name} (${put?.status ?? "no answer"}). Deploy again.`);
    const got = put.headers.get("etag")?.replace(/"/g, "");
    if (got && got != etag) throw new DeployError(`The copy uploaded for ${name} arrived changed (its checksum doesn't match). Deploy again.`);
  }
  const ingest = await cf.call<Answer>("POST", path, `load the copy into ${name}`, { action: "ingest", etag, filename: init?.filename });
  let bookmark = ingest?.at_bookmark;
  if (ingest?.status == "complete") return;
  for (let tries = 0; ; tries++) {
    const r = await cf.call<Answer>("POST", path, `check on loading the copy into ${name}`, { action: "poll", current_bookmark: bookmark });
    if (r?.status == "complete" || r?.error == "Not currently importing anything.") return;
    if (r?.status == "error" || (r?.error && r.success === false)) throw new DeployError(`D1 couldn't load the copy into ${name}: ${r?.error ?? "it said it failed"}.`);
    bookmark = r?.at_bookmark ?? bookmark;
    if (tries >= 300) throw new DeployError(`Loading the copy into ${name} took too long. Deploy again.`);
    await sleep(1000);
  }
}

/** The static assets' 32-hex hash, as Cloudflare's direct upload takes it: SHA-256 of the base64 contents and the extension. */
export async function assetHash(path: string, bytes: Uint8Array): Promise<string> {
  const ext = /\.([^./]+)$/.exec(path)?.[1] ?? "";
  return (await sha256Hex(base64(bytes) + ext)).slice(0, 32);
}

const TYPES: Record<string, string> = { html: "text/html", js: "application/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", woff2: "font/woff2", woff: "font/woff", png: "image/png", ico: "image/x-icon", txt: "text/plain", md: "text/markdown", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", pdf: "application/pdf", xml: "application/xml", mp4: "video/mp4", webmanifest: "application/manifest+json" };
export const typeOf = (path: string) => TYPES[/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";

/**
 * Uploads the assets Cloudflare doesn't have yet; the completion token for
 * the Worker's upload. As workers-sdk's deploy does it: the manifest opens a
 * session (its JWT, and buckets of hashes still needed), then each bucket goes
 * up as base64 multipart, or, when the JWT says so
 * (wrangler_single_asset_uploads), each file on its own as its raw bytes.
 * Each upload is tried up to four times.
 */
export async function uploadAssets(cf: Cloudflare, acc: string, worker: string, assets: Record<string, Uint8Array>, label = "the editor's files"): Promise<string> {
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, string>();
  for (const [path, bytes] of Object.entries(assets)) {
    const hash = await assetHash(path, bytes);
    manifest[path] = { hash, size: bytes.byteLength };
    byHash.set(hash, path);
  }
  const session = await cf.call<{ jwt: string; buckets?: string[][] }>("POST", `${acc}/workers/scripts/${worker}/assets-upload-session`, `start uploading ${label}`, { manifest });
  if (!session?.jwt) throw new DeployError(`Cloudflare didn't start the upload of ${label} (no upload token came back). Deploy again.`);
  const buckets = (session.buckets ?? []).filter((b) => b.length);
  if (!buckets.length) return session.jwt;
  const single = jwtClaims(session.jwt).wrangler_single_asset_uploads === true;
  let jwt: string | null = null;
  const pathOf = (hash: string) => {
    const path = byHash.get(hash);
    if (!path) throw new DeployError("Cloudflare asked for a file the release doesn't have. Deploy again.");
    return path;
  };
  for (const bucket of single ? buckets.flat().map((h) => [h]) : buckets) {
    for (let attempt = 1; ; attempt++) {
      try {
        let done: { jwt?: string } | null;
        if (single) {
          const path = pathOf(bucket[0]);
          done = await cf.call<{ jwt?: string }>("POST", `${acc}/workers/assets/upload/${bucket[0]}`, `upload ${path}`, new Blob([new Uint8Array(assets[path])], { type: typeOf(path) }), { bearer: session.jwt });
        } else {
          const form = new FormData();
          for (const hash of bucket) {
            const path = pathOf(hash);
            form.append(hash, new File([base64(assets[path])], hash, { type: typeOf(path) }));
          }
          done = await cf.call<{ jwt?: string }>("POST", `${acc}/workers/assets/upload?base64=true`, `upload ${label}`, form, {
            bearer: session.jwt,
          });
        }
        if (done?.jwt) jwt = done.jwt;
        break;
      } catch (e) {
        if (attempt >= 4 || (e instanceof DeployError && e.status >= 400 && e.status < 500 && e.status != 429)) throw e;
        await sleep(500 * 2 ** attempt);
      }
    }
  }
  if (!jwt) throw new DeployError(`Cloudflare took ${label} but didn't say the upload was complete (no completion token). Deploy again: files already up aren't sent twice.`);
  return jwt;
}

/** A JWT's claims, unchecked (only to read how Cloudflare wants the files sent). */
function jwtClaims(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(jwt.split(".")[1])));
  } catch {
    return {};
  }
}

/** One statement (or a few, separated by semicolons) on a D1 database, through the API: the first statement's rows. */
/**
 * The API keys a server stored itself, into the new copy of
 * another server's data it moves to: the copy's rows (the other server's,
 * encrypted with its FACTORY_KEY, so they don't open here) go, and the rows of
 * the copy it was on (`from`; none on its first copy) come in. Without this,
 * each new copy would drop staging's Anthropic key, and its agents would stop.
 */
export async function ownCredentials(cf: Cloudflare, acc: string, from: string | null, to: string): Promise<string> {
  const rows = from ? (await d1(cf, acc, from, "SELECT * FROM credentials", [], "read the API keys this server stored")) ?? [] : [];
  await d1(cf, acc, to, "DELETE FROM credentials", [], "remove the other server's API keys from the copy");
  for (const r of rows) {
    const cols = Object.keys(r).filter((c) => /^\w+$/.test(c));
    await d1(cf, acc, to, `INSERT INTO credentials (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`, cols.map((c) => r[c] as string | number | null), `keep the API key ${String(r.name)}`);
  }
  return rows.length ? `its own API keys kept (${rows.map((r) => String(r.name)).join(", ")})` : "no API keys of its own to keep";
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
