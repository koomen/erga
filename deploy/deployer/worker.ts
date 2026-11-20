// The deployer on Cloudflare: a Worker in the person's own account that deploys each new release of the instance's
// branch by itself. It has no route and no address. Its schedule runs it each minute, and ONE RUN IS ONE DEPLOY: a run
// carries no work over to the next one, and it always ends with a result.
//
// A run:
//   1. Takes the deployer's lock (its own Durable Object, DeployerState). A run that stopped frees it after LOCK_MS.
//   2. Reads the instance's spec and the admin's switch and ask (the instance's database, through the binding DB). The
//      store keeps the last spec and switch that it read: a database that gives no answer does not stop the deployer.
//   3. Reads GitHub: the branch's head, its last commits, and whether each has a release.
//   4. Deploys, when an admin asked or the head is new: the release from GitHub's registry (checked against its
//      digest), the release's new migrations, the static files, the Worker. Then it asks the instance's own
//      /api/health for at most HEALTH_MS. The new release must answer healthy two times in a row; else one call puts
//      the version before back (Cloudflare's own deployment of that version).
//   5. Writes the result into its store, and a COPY of its look and of the job into the instance's rows
//      (deploy_control, deploy_jobs), where /admin/deploy reads them. The copy is best effort: the deployer never
//      needs it. The job's row is also the lock that a deploy from a machine takes (instance.ts).
//
// What setup gives it (deploy/pipeline/deployer.ts; nothing else changes this Worker, and it can't change itself):
//   CLOUDFLARE_API_TOKEN   a secret: a token for the instance's Worker only (the role Editor). No permission for D1.
//   ACCOUNT, WORKER        the account and the instance's Worker: every call of Cloudflare's API is for those two
//   DATABASE               the id of the instance's database, for the Worker's upload
//   DB                     the instance's database: the spec, the migrations and the copy
//   STATE                  its own Durable Object: the lock, the last commit tried, the job that runs
//   INSTANCE               the instance's Worker: /api/health, when the public address does not give the server's
//                          answer (Cloudflare Access is in front of it)
//
// Health is the server's own answer to a request ({ok, version, checks}: server/health.ts). It is never a row that
// the new release must write. The migrations only add, so the version before runs on the newer tables: an unhealthy
// release goes back with no change to the database, and the log gives the one command that restores the database too.
//
// No Effect here, by Pete's word (2026-11-20): "the deployer as compact and dead simple as possible, so a bad Erga
// deploy can't take it down". This is the one exception to AGENTS.md's "Effect by default": plain TypeScript, and only
// the plain files of this folder (worker-form.ts, bindings.ts, d1-binding.ts). A test holds its size, its lines and
// its calls (tests/deployer-worker.test.ts).
//
// Trap: it has no fetch handler. A handler is an address: a way for a stranger to start, or to slow, a deploy.
// Trap: Cloudflare takes a Worker's module only when each thing that it exports is a handler or a class: the module
// that it runs is worker-main.ts, which exports the Worker and its store, and nothing else of this file.
// Trap: one run may make CALLS calls at most (Cloudflare's free plan stops a run at 50). Every call goes through `net`.
// Trap: the spec's names go into addresses. specOf checks each one that this file uses, with spec.ts's own patterns.

import { bindingsProblem } from "./bindings";
import { type D1, statementsOf } from "./d1-binding";
import type { Release, ReleaseIndex } from "./release-format";
import type { CloudflareTarget, Spec } from "./spec";
import { HEADERS_FILE, toHex, typeOf, workerMetadata } from "./worker-form";

/** How long a run's lock holds when the run stopped with no end. A run lasts about a minute at most. */
export const LOCK_MS = 3 * 60_000;
/** How long a deploy waits for the new release's healthy answer, and how often it asks. */
export const HEALTH_MS = 30_000;
const HEALTH_EACH_MS = 5000;
/** The most calls out of one run, and how many the Worker's upload leaves room for: the upload, the health checks, a rollback, the store. */
export const CALLS = 45;
const RESERVE = 12;
/** One call's time limit. */
const CALL_MS = 20_000;
/** How long a job of the instance holds the instance's lock after its last write (instance.ts, LEASE_MS). */
const LEASE_MS = 30 * 60_000;
/** How many commits a look keeps, how many releases it asks the registry for, and how often auto-deploy tries a commit that changed nothing. */
const COMMITS = 10;
const ASKED = 3;
const TRIES = 3;
const RELEASE_TYPE = "application/vnd.erga.release.v1+json";
const MAX_BYTES = 100_000_000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type ReleaseState = "released" | "none" | "refused";
interface Commit {
  sha: string;
  title: string;
  at: number;
  /** As GitHub's registry said it. None yet: not asked. */
  release?: ReleaseState;
}
type CloudSpec = Pick<Spec, "repo" | "branch" | "settings"> & { target: CloudflareTarget };

/** What the deployer keeps, in its own store. */
export interface State {
  /** When the run that holds the lock took it. */
  lock?: number;
  /** The last spec and switch that a run read from the instance. */
  spec?: CloudSpec;
  auto?: boolean;
  /** The last look: the branch's head and commits. */
  head?: string;
  commits?: Commit[];
  /** The last commit that auto-deploy tried: how often, whether its deploy ended well, and whether it got to the Worker's upload. */
  tried?: { sha: string; n: number; ok: boolean; up: boolean };
  /** The job that a run started and did not end. `row`: its copy on the instance. `before`: the version to go back to, set just before the Worker's upload. */
  job?: { row: number | null; sha: string | null; before?: string | null };
}

export interface Store {
  /** The state, with the lock taken at `now`. null: another run holds it. */
  take(now: number): Promise<State | null>;
  put(state: State): Promise<void>;
}

export interface Env {
  CLOUDFLARE_API_TOKEN: string;
  ACCOUNT: string;
  WORKER: string;
  DATABASE: string;
  DB: D1;
  STATE: { idFromName(name: string): unknown; get(id: unknown): { fetch: Fetch } };
  INSTANCE: { fetch: Fetch };
}

/** The ways out of a run: the network, the time, and the store (a test gives its own). */
export interface IO {
  fetch: Fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  store?: Store;
}

/** One run: what each step reads. */
interface Run {
  io: IO;
  env: Env;
  store: Store;
  state: State;
  spec: CloudSpec;
  /** The calls that the run made. */
  calls: number;
  /** The registry's token, asked one time. */
  token?: string;
  /** The public address does not give the server's own report: the health asks go to the instance's Worker. */
  direct?: boolean;
  /** "<branch> on <repo> is at <head>": how each line of a look starts. */
  at: string;
}

const short = (sha: string) => sha.slice(0, 12);
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const sha256 = async (bytes: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
const rows = async (db: D1, sql: string, ...values: (string | number | null)[]) =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .all()
  ).results ?? [];

/** One call out of the run, counted, with a time limit. `via`: the instance's Worker, not the network. */
function net(c: Run, url: string, init: RequestInit = {}, via: Fetch = c.io.fetch): Promise<Response> {
  if (++c.calls > CALLS) throw new Error(`The run made ${CALLS} calls: it stops here.`);
  return via(url, { ...init, signal: AbortSignal.timeout(CALL_MS) });
}

// ------------------------------------------------------------------ the store

const storeOf = (env: Env): Store => {
  const stub = env.STATE.get(env.STATE.idFromName("state"));
  const ask = (body: object) => stub.fetch("https://state/", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  return { take: (now) => ask({ take: now }) as Promise<State | null>, put: (state) => ask({ put: state }).then(() => undefined) };
};

/** The deployer's store: one value. Cloudflare runs one request of it at a time, so one run only takes the lock. */
export class DeployerState {
  constructor(private ctx: { storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> } }) {}
  async fetch(request: Request): Promise<Response> {
    const ask = (await request.json()) as { take?: number; put?: State };
    let state = ((await this.ctx.storage.get("state")) ?? {}) as State;
    if (ask.put) state = ask.put;
    else if (state.lock && ask.take! - state.lock < LOCK_MS) return Response.json(null);
    else state.lock = ask.take;
    await this.ctx.storage.put("state", state);
    return Response.json(state);
  }
}

// ------------------------------------------------------------------ the spec

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const NAME = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/;

/** The instance's spec, when it is this deployer's instance and each name that this file uses has spec.ts's pattern. */
export function specOf(value: unknown, env: Pick<Env, "ACCOUNT" | "WORKER">): CloudSpec {
  const s = value as CloudSpec | null;
  const t = s?.target;
  if (t?.kind != "cloudflare" || t.account != env.ACCOUNT || t.worker != env.WORKER)
    throw new Error("The instance's spec names another instance than the one that this deployer is for.");
  const text = (v: unknown, pattern: RegExp, max: number) => typeof v == "string" && v.length <= max && pattern.test(v);
  const good =
    text(s?.repo, /^github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*$/, 200) &&
    text(s?.branch, /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/, 200) &&
    text(t.database, NAME, 63) &&
    (t.app?.kind == "domain" ? text(t.app.hostname, HOST, 253) : t.app?.kind == "workers.dev" && text(t.subdomain, NAME, 63)) &&
    !!t.pages &&
    !!s?.settings &&
    Object.entries(s.settings).every(([k, v]) => text(k, /^(?!ERGA_|PAGES_)[A-Z][A-Z0-9_]*$/, 64) && typeof v == "string");
  if (!good) throw new Error("The spec on the instance is not one that this deployer reads.");
  return { repo: s!.repo, branch: s!.branch, settings: s!.settings, target: t };
}

const hostOf = (t: CloudflareTarget) => (t.app.kind == "domain" ? t.app.hostname : `${t.worker}.${t.subdomain}.workers.dev`);

// ------------------------------------------------------------------ GitHub, and its registry

/** One page of GitHub's, with no credential. null: 404. */
async function page(c: Run, url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  const r = await net(c, url, { headers: { "User-Agent": "erga-deployer", ...headers } });
  if (r.status == 404) return null;
  if (r.status != 200) throw new Error(`${new URL(url).host} answered ${r.status}. The deployer looks again in a minute.`);
  return r;
}

/** The branch's head: the commit's full name, from git's own list of the repository's refs. */
async function headOf(c: Run): Promise<string> {
  const { repo, branch } = c.spec;
  const refs = await (await page(c, `https://${repo}.git/info/refs?service=git-upload-pack`))?.text();
  for (const line of (refs ?? "").split("\n")) {
    const ref = /([0-9a-f]{40}) (.+)$/.exec(line.split("\0")[0]);
    if (ref?.[2] == `refs/heads/${branch}`) return ref[1];
  }
  throw new Error(`${repo} has no branch ${branch}, as GitHub lists its refs: the repository and the branch must be there, and public.`);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The branch's last commits, newest first, from its feed. The titles are a stranger's text: whatever shows them escapes them. */
async function commitsOf(c: Run): Promise<Commit[]> {
  const feed = (await (await page(c, `https://${c.spec.repo}/commits/${c.spec.branch}.atom`))?.text()) ?? "";
  return feed
    .split("<entry>")
    .slice(1)
    .map((entry) => {
      const sha = /<id>[^<]*Commit\/([0-9a-f]{40})<\/id>/.exec(entry)?.[1];
      const title = /<title>([^<]*)<\/title>/.exec(entry)?.[1];
      const at = Date.parse(/<updated>([^<]*)<\/updated>/.exec(entry)?.[1] ?? "");
      if (!sha || title == null || Number.isNaN(at))
        throw new Error("GitHub gave the branch's commits in a way that the deployer doesn't understand.");
      const plain = title.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, dec, hex, name) =>
        dec || hex ? String.fromCodePoint(Number.parseInt(dec ?? hex, dec ? 10 : 16) || 0xfffd) : (ENTITIES[name.toLowerCase()] ?? all)
      );
      return { sha, title: plain.replace(/\s+/g, " ").trim().slice(0, 200), at };
    });
}

/** Whether the branch has the commit, as GitHub's API says it (60 calls an hour with no credential: only an ask uses it). */
async function onBranch(c: Run, sha: string): Promise<boolean> {
  const { repo, branch } = c.spec;
  const r = await net(c, `https://api.github.com/repos/${repo.slice("github.com/".length)}/compare/${branch}...${sha}?per_page=1`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "erga-deployer" },
  });
  if (r.status == 404) return false;
  if (r.status != 200) throw new Error(`GitHub did not say if ${short(sha)} is on ${branch} (it answered ${r.status}). Ask again.`);
  return ((await r.json()) as { ahead_by?: number }).ahead_by === 0;
}

/** The package that holds the branch's releases: verify's commits have one of their own. */
const packageOf = (s: CloudSpec) => `${s.repo.slice("github.com/".length).toLowerCase()}${s.branch == "verify" ? "-verify" : ""}`;

/** What the registry has for a commit: its release's one layer (the bundle), none, or something that is no release. */
async function layerOf(c: Run, sha: string): Promise<{ digest: string; size: number } | "none" | "refused"> {
  const name = packageOf(c.spec);
  // The package is public: the registry gives a token to read it with no login.
  c.token ??= (
    (await (await page(c, `https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:pull`))?.json()) as { token?: string }
  )?.token;
  if (!c.token) return "none";
  const tagged = await page(c, `https://ghcr.io/v2/${name}/manifests/${sha}`, {
    Authorization: `Bearer ${c.token}`,
    Accept: "application/vnd.oci.image.manifest.v1+json",
  });
  if (!tagged) return "none";
  const [layer, ...more] = ((await tagged.json()) as { layers?: { mediaType: string; digest: string; size: number }[] }).layers ?? [];
  const one = layer && !more.length && layer.mediaType == RELEASE_TYPE && /^sha256:[0-9a-f]{64}$/.test(layer.digest);
  return one && layer.size > 0 && layer.size <= MAX_BYTES ? layer : "refused";
}

/**
 * The release of `sha`, fetched and checked against the digest and the size that its manifest names. `files`: the
 * static files as the bundle holds them (base64), by path: they go up as they are.
 */
async function releaseOf(c: Run, sha: string): Promise<{ release: Release; files: Record<string, string> }> {
  const at = `ghcr.io/${packageOf(c.spec)}:${sha}`;
  const layer = await layerOf(c, sha);
  if (layer == "none") throw new Error(`GitHub's registry has no release of ${short(sha)}.`);
  if (layer == "refused") throw new Error(`${at} is not a release: it is not deployed.`);
  const blob = await page(c, `https://ghcr.io/v2/${packageOf(c.spec)}/blobs/${layer.digest}`, { Authorization: `Bearer ${c.token}` });
  if (!blob) throw new Error(`GitHub's registry has the release ${at}, but not its bundle.`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength != layer.size || `sha256:${await sha256(bytes)}` != layer.digest)
    throw new Error(`The bundle of ${at} is not the one that its manifest names. It is not deployed.`);
  const { index, files } = JSON.parse(new TextDecoder().decode(bytes)) as { index: ReleaseIndex; files: Record<string, string> };
  if (!index || !files || typeof index.version != "string" || index.version.length < 12 || !sha.startsWith(index.version))
    throw new Error(`The release at ${at} says that it is ${index?.version}, not that commit. It is not deployed.`);
  const part = (dir: string, names: string[]) =>
    names.map((n): [string, string] => {
      if (typeof files[`${dir}/${n}`] != "string") throw new Error(`The release at ${at} is missing ${dir}/${n}.`);
      return [n, files[`${dir}/${n}`]];
    });
  const assets = Object.fromEntries(part("assets", index.assets).map(([n, text]) => [`/${n}`, text]));
  const headers = assets[HEADERS_FILE];
  delete assets[HEADERS_FILE];
  const release: Release = {
    version: index.version,
    built: index.built,
    worker: index.worker,
    mainModule: index.mainModule,
    modules: Object.fromEntries(part("bundle", index.modules).map(([n, text]) => [n, fromBase64(text)])),
    // Only the file of headers: the Worker's metadata holds it. The other files stay as base64 (`files`).
    assets: headers ? { [HEADERS_FILE]: fromBase64(headers) } : {},
    migrations: Object.fromEntries(
      part("migrations", index.migrations).map(([n, text]) => [n, new TextDecoder().decode(fromBase64(text))])
    ),
    ...(index.bindings ? { bindings: index.bindings } : {}),
  };
  return { release, files: assets };
}

// ------------------------------------------------------------------ Cloudflare

/** One call of Cloudflare's API for the instance's Worker: its result. `bearer`: an upload's own token. */
async function cf<T>(
  c: Run,
  method: string,
  path: string,
  body?: object | FormData | Blob,
  bearer = c.env.CLOUDFLARE_API_TOKEN
): Promise<T> {
  const plain = body && !(body instanceof FormData) && !(body instanceof Blob);
  const r = await net(c, `https://api.cloudflare.com/client/v4/accounts/${c.env.ACCOUNT}/workers${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...(plain ? { "Content-Type": "application/json" } : {}) },
    body: plain ? JSON.stringify(body) : (body as FormData | Blob | undefined),
  });
  const answer = (await r.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    errors?: { code?: number; message?: string }[] | null;
  } | null;
  if (!r.ok || !answer?.success)
    throw new Error(
      `Cloudflare refused ${method} ${path.replace(/\?.*/, "")} (it answered ${r.status}${(answer?.errors ?? []).map((e) => `: ${e.message} [code ${e.code}]`).join("")}).`
    );
  return answer.result as T;
}

/** The Worker's versions as its deployments had them, newest first, each one time: the first one serves now. */
async function versionsOf(c: Run): Promise<string[]> {
  const list = await cf<{ deployments?: { created_on: string; versions: { version_id: string; percentage: number }[] }[] }>(
    c,
    "GET",
    `/scripts/${c.env.WORKER}/deployments`
  );
  const newest = [...(list?.deployments ?? [])].sort((x, y) => Date.parse(y.created_on) - Date.parse(x.created_on));
  const top = newest.map((d) => [...d.versions].sort((a, b) => b.percentage - a.percentage)[0]?.version_id).filter((v) => v != null);
  return [...new Set(top)];
}

/** Cloudflare's own rollback: a deployment of `version` at 100%. Seconds; no build, no upload. */
const rollbackTo = (c: Run, version: string, message: string) =>
  cf(c, "POST", `/scripts/${c.env.WORKER}/deployments?force=true`, {
    strategy: "percentage",
    versions: [{ version_id: version, percentage: 100 }],
    annotations: { "workers/message": message },
  });

/** Applies the release's migrations that the database does not have, each with its record in one transaction: their names. */
async function migrate(db: D1, migrations: Record<string, string>): Promise<string[]> {
  await rows(
    db,
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)"
  );
  const done = new Set((await rows(db, "SELECT name FROM d1_migrations")).map((r) => String(r.name)));
  const pending = Object.keys(migrations)
    .sort()
    .filter((n) => !done.has(n));
  for (const name of pending)
    await db
      .batch([
        ...statementsOf(migrations[name]).map((s) => db.prepare(s)),
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name),
      ])
      .catch((e) => Promise.reject(new Error(`The instance's database refused the migration ${name}: ${said(e)}`)));
  return pending;
}

/**
 * Uploads the static files that Cloudflare does not have yet: the completion token for the Worker's upload. As
 * cloudflare.ts's uploadAssets: a session (its token, and the hashes still needed), then each group as base64, or,
 * when the session's token says so, each file by itself. It starts no upload that the run has no calls for.
 */
async function uploadFiles(c: Run, files: Record<string, string>): Promise<string> {
  const W = c.env.WORKER;
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    const hash = (await sha256(new TextEncoder().encode(text + (/\.([^./]+)$/.exec(path)?.[1] ?? "")))).slice(0, 32);
    manifest[path] = { hash, size: (text.length * 3) / 4 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0) };
    byHash.set(hash, path);
  }
  type Session = { jwt?: string | null; buckets?: string[][] | null } | null;
  const session = await cf<Session>(c, "POST", `/scripts/${W}/assets-upload-session`, { manifest });
  const bearer = session?.jwt;
  if (!bearer) throw new Error("Cloudflare didn't start the upload of the editor's files: its answer had no upload token.");
  let single = false;
  try {
    single = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).wrangler_single_asset_uploads === true;
  } catch {
    /* a token that says nothing: groups */
  }
  const buckets = (session.buckets ?? []).filter((b) => b.length);
  const groups = single ? buckets.flat().map((h) => [h]) : buckets;
  if (!groups.length) return bearer;
  if (c.calls + groups.length + RESERVE > CALLS)
    throw new Error(
      `This release has ${groups.length} uploads of files, and one run of the deployer has room for ${CALLS - RESERVE - c.calls}. Nothing changed. Deploy it one time from a machine: bun erga deploy ${hostOf(c.spec.target)}`
    );
  let done: string | null = null;
  for (const group of groups) {
    const paths = group.map((hash) => byHash.get(hash) ?? "");
    if (paths.includes("")) throw new Error("Cloudflare asked for a file that the release doesn't have.");
    const form = new FormData();
    for (const [i, hash] of group.entries()) form.append(hash, new File([files[paths[i]]], hash, { type: typeOf(paths[i]) }));
    const answer = single
      ? await cf<Session>(
          c,
          "POST",
          `/assets/upload/${group[0]}`,
          new Blob([fromBase64(files[paths[0]])], { type: typeOf(paths[0]) }),
          bearer
        )
      : await cf<Session>(c, "POST", "/assets/upload?base64=true", form, bearer);
    if (answer?.jwt) done = answer.jwt;
  }
  if (!done) throw new Error("Cloudflare took the editor's files but didn't say that the upload was complete.");
  return done;
}

// ------------------------------------------------------------------ health

interface Health {
  ok: boolean;
  /** Why not, or what passed. */
  why: string;
  /** The release that answered. */
  version?: string;
}
type Report = { ok?: boolean; version?: string; checks?: Record<string, { ok: boolean; ms?: number; error?: string }> } | null;

/**
 * One ask of the instance's own /api/health: whether the release `want` (null: any) answers that it is healthy. The
 * public address first. An answer there that is not the server's (Cloudflare Access's, or Cloudflare's own for an
 * address that a Worker may not call) goes to the instance's Worker itself, for the rest of the run: the same request.
 */
async function healthNow(c: Run, want: string | null): Promise<Health> {
  const url = `https://${hostOf(c.spec.target)}/api/health`;
  try {
    let r = c.direct ? null : await net(c, url, { redirect: "manual" });
    let h = r && ((await r.json().catch(() => null)) as Report);
    if (typeof h?.ok != "boolean") {
      c.direct = true;
      r = await net(c, url, {}, (u, init) => c.env.INSTANCE.fetch(u, init));
      h = (await r.json().catch(() => null)) as Report;
    }
    const checks = Object.entries(h?.checks ?? {});
    const version = h?.version;
    if (typeof h?.ok != "boolean") return { ok: false, why: `it answered ${r!.status}, and not the server's own report` };
    if (want && version != want) return { ok: false, why: `release ${version ?? "?"} answers, not ${want}`, version };
    if (h.ok)
      return { ok: true, why: checks.map(([n, k]) => `${n} ok${k.ms != null ? ` ${k.ms} ms` : ""}`).join(", ") || "no checks", version };
    const failed = checks.filter(([, k]) => !k.ok).map(([n, k]) => `${n}: ${k.error ?? "failed"}`);
    return { ok: false, why: failed.join("; ") || "its report says not ok", version };
  } catch (e) {
    return { ok: false, why: said(e) };
  }
}

/**
 * After an upload or a rollback: asks each HEALTH_EACH_MS, for at most HEALTH_MS, until two answers in a row are
 * healthy. Two, and none at once: Cloudflare gives a new version to its machines in some seconds, and until then the
 * version before can answer, healthy, under the same release's name (the same commit deployed again with another
 * setting: seen on real Cloudflare, 2026-11-20).
 */
async function settledHealth(c: Run, want: string | null): Promise<Health> {
  let last: Health = { ok: false, why: "it gave no answer" };
  for (let waited = HEALTH_EACH_MS, good = 0; waited <= HEALTH_MS; waited += HEALTH_EACH_MS) {
    await c.io.sleep(HEALTH_EACH_MS);
    last = await healthNow(c, want);
    good = last.ok ? good + 1 : 0;
    if (good == 2) return last;
  }
  return last.ok ? { ok: false, why: "it answered healthy one time only, at the end of the wait", version: last.version } : last;
}

// ------------------------------------------------------------------ a deploy, and a rollback

/** Deploys the release of `sha`. It fails with what stopped it; an unhealthy release goes back first. */
async function deploy(c: Run, sha: string, log: (line: string) => void): Promise<void> {
  const W = c.env.WORKER;
  log("Fetch the release from GitHub...");
  const { release, files } = await releaseOf(c, sha);
  const problem = bindingsProblem(release);
  if (problem) throw new Error(problem);
  log(`Fetch the release from GitHub: done, ghcr.io/${packageOf(c.spec)}:${sha}, checked against its digest`);
  const before = (await versionsOf(c))[0] ?? null;
  log("Set up the database's tables...");
  const at = c.io.now();
  const applied = await migrate(c.env.DB, release.migrations);
  log(
    `Set up the database's tables: done, ${applied.length ? `applied ${applied.join(", ")}` : "already up to date"}; restore point: ${before ? `version ${before}` : "no version"}, the database at ${new Date(at).toISOString()}`
  );
  log("Upload the editor's files...");
  const assetsJwt = await uploadFiles(c, files);
  log(`Upload the editor's files: done, ${Object.keys(files).length} files`);
  if (c.calls + RESERVE > CALLS)
    throw new Error(
      `The run made ${c.calls} calls before the Worker's upload, and the health check needs ${RESERVE}. Nothing that the instance runs changed.`
    );
  // From here the instance may run the release: the store knows where to go back to, also for the run after a run that stopped.
  c.state.job!.before = before;
  if (c.state.tried?.sha == sha) c.state.tried.up = true;
  await c.store.put(c.state);
  log("Upload the Worker, with its settings...");
  const form = new FormData();
  form.set("metadata", JSON.stringify(workerMetadata(release, c.spec, { dbId: c.env.DATABASE, assetsJwt })));
  for (const [module, bytes] of Object.entries(release.modules))
    form.append(module, new File([new Uint8Array(bytes)], module, { type: "application/javascript+module" }));
  await cf(c, "PUT", `/scripts/${W}`, form);
  log(`Upload the Worker, with its settings: done, ${W}, release ${release.version}`);
  log("Wait for its health...");
  const h = await settledHealth(c, release.version);
  if (h.ok) return log(`Wait for its health: done, release ${release.version}, healthy (${h.why})`);
  const why = `Release ${release.version} is deployed to ${W}, but it is not healthy after ${HEALTH_MS / 1000} seconds: ${h.why}.`;
  // The migrations only add: the version before runs on the newer tables. A person may put the database back too.
  const restore = applied.length
    ? ` The database keeps what this deploy added (${applied.join(", ")}). To put it back as it was before the deploy, which loses what people wrote since: npx wrangler d1 time-travel restore ${c.spec.target.database} --timestamp=${Math.floor(at / 1000)}`
    : "";
  if (!before) throw new Error(`${why} There is no version before it to go back to.`);
  log(`${why} It goes back to ${before}, which ran before.`);
  await rollbackTo(c, before, `deploy: release ${release.version} was unhealthy`).catch((e) =>
    Promise.reject(new Error(`${why} The rollback to ${before} failed too: ${said(e)}${restore}`))
  );
  throw new Error(`${why} It is rolled back to ${before}, which ran before.${restore}`);
}

/** The rollback that an admin asked for: the version before the one that runs, and its own healthy answer. */
async function back(c: Run, log: (line: string) => void): Promise<void> {
  const W = c.env.WORKER;
  const [now, before] = await versionsOf(c);
  if (!now || !before) throw new Error(`${W} has no deployment of another version to go back to.`);
  // The release of the version before, from the version's own bindings: the health check waits for that one.
  const version = await cf<{ resources?: { bindings?: { name: string; text?: string }[] } }>(c, "GET", `/scripts/${W}/versions/${before}`);
  const to = version?.resources?.bindings?.find((b) => b.name == "ERGA_VERSION")?.text ?? null;
  log(
    `The Worker ${W} runs version ${now}. The rollback goes to the version before it: ${before}${to ? ` (release ${to})` : ""}. The database stays as it is.`
  );
  await rollbackTo(c, before, "rollback");
  const h = await settledHealth(c, to);
  if (!h.ok) throw new Error(`The health check fails after the rollback: ${h.why}`);
  log(`Release ${h.version ?? "?"} runs again, healthy (${h.why}).`);
}

// ------------------------------------------------------------------ a job, and a run

/** Writes the job's end into the copy's row, and takes the job off the store's state. */
async function end(c: Run, lines: string[], failed: string | null) {
  const job = c.state.job;
  const state = failed ? `failed: ${failed}` : "done";
  if (job?.row != null)
    await quiet(
      rows(
        c.env.DB,
        "UPDATE deploy_jobs SET log = log || ?, state = ?, alive = ? WHERE id = ?",
        `${lines.join("\n")}\n`,
        state,
        c.io.now(),
        job.row
      )
    );
  if (job?.sha && c.state.tried?.sha == job.sha) c.state.tried.ok = !failed;
  delete c.state.job;
}

/**
 * One job: its row on the instance (the copy, and the instance's lock: one job at a time, also with a machine's), the
 * work, and its end, whatever stopped the work. The result: the run's line.
 */
async function job(
  c: Run,
  start: { kind: "deploy" | "rollback"; command: string; source: string; sha: string | null },
  what: string,
  work: (log: (line: string) => void) => Promise<void>
): Promise<string> {
  const now = c.io.now();
  let row: number | null = null;
  try {
    const made = await rows(
      c.env.DB,
      "INSERT INTO deploy_jobs (kind, command, source, sha, started, alive, state) SELECT ?, ?, ?, ?, ?, ?, 'running' WHERE NOT EXISTS (SELECT 1 FROM deploy_jobs WHERE state = 'running' AND alive > ?) RETURNING id",
      start.kind,
      start.command,
      start.source,
      start.sha,
      now,
      now,
      now - LEASE_MS
    );
    if (!made.length) return `${c.at}. A job runs on the instance: the deployer waits.`;
    row = Number(made[0].id);
  } catch {
    /* no copy: the store has the job */
  }
  c.state.job = { row, sha: start.sha };
  if (start.source == "auto-deploy" && start.sha)
    c.state.tried = { sha: start.sha, n: (c.state.tried?.sha == start.sha ? c.state.tried.n : 0) + 1, ok: false, up: false };
  await c.store.put(c.state);
  const lines: string[] = [];
  const failed = await work((line) => lines.push(line)).then(
    () => null,
    (e) => said(e)
  );
  if (failed) lines.push(failed);
  await end(c, lines, failed);
  return failed ? `${c.at}. ${what} failed: ${failed}` : `${c.at}. ${what} is done.`;
}

/** The job of a run that stopped with no end: its release is healthy, or the instance goes back; then the job ends. */
async function settle(c: Run) {
  const { sha, before } = c.state.job!;
  let failed: string | null = "The deployer's run stopped before the job's end.";
  if (before === undefined) failed += " Nothing that the instance runs changed.";
  else {
    const h = await healthNow(c, sha ? short(sha) : null);
    if (h.ok) failed = null;
    else if (!before) failed += ` The release is not healthy (${h.why}), and there is no version before it to go back to.`;
    else
      failed += await rollbackTo(c, before, "deploy: the deployer's run stopped, and the release was unhealthy").then(
        () => ` The release is not healthy (${h.why}). It is rolled back to ${before}, which ran before.`,
        (e) => ` The release is not healthy (${h.why}). The rollback to ${before} failed too: ${said(e)}`
      );
  }
  await end(c, [failed ?? "The deployer's run stopped before the job's end. Its release is up, and healthy."], failed);
}

/** One run, with the lock held. The result: one line that says what it did. */
async function run(c: Run): Promise<string> {
  const { state } = c;
  const db = c.env.DB;
  if (state.job && state.spec) await settle(c);
  delete state.job;

  // What the look saw, or why it failed: the copy on the instance, for /admin/deploy.
  const copy = (error: string | null) =>
    quiet(
      rows(
        db,
        "INSERT INTO deploy_control (id, looked, head, error, commits) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET looked = excluded.looked, head = excluded.head, error = excluded.error, commits = excluded.commits",
        c.io.now(),
        state.head ?? null,
        error,
        JSON.stringify((state.commits ?? []).map((k) => ({ ...k, release: k.release ?? "none" })))
      )
    );
  const stop = async (e: unknown) => {
    await copy(said(e));
    return said(e);
  };

  // The instance's spec and switch. No answer: the last ones that a run read.
  const spec = await rows(db, "SELECT spec FROM deploy_spec WHERE id = 1").catch(() => null);
  if (spec && !spec[0]) return "The instance has no spec: nothing to look at.";
  try {
    if (spec) state.spec = specOf(JSON.parse(String(spec[0].spec)), c.env);
  } catch (e) {
    return stop(e);
  }
  if (!state.spec) return "The instance's database gave no spec, and the deployer has none from before: it looks again in a minute.";
  c.spec = state.spec;
  const control = await rows(db, "SELECT auto, ask, ask_by, ask_at FROM deploy_control WHERE id = 1").catch(() => null);
  if (control) state.auto = !!control[0]?.auto;

  // GitHub: the head, the commits when the head is new, and each commit's release (the head's until it is there).
  let head: string;
  let release: ReleaseState;
  try {
    head = await headOf(c);
    if (state.commits?.[0]?.sha != head) {
      const known = new Map((state.commits ?? []).map((k) => [k.sha, k.release]));
      const feed = await commitsOf(c);
      // A feed that is behind the head (GitHub makes it a moment later) changes nothing: the next run reads it again.
      if (feed[0]?.sha == head) state.commits = feed.slice(0, COMMITS).map((k) => ({ ...k, release: known.get(k.sha) }));
    }
    const stateOf = async (sha: string): Promise<ReleaseState> => {
      const layer = await layerOf(c, sha);
      return typeof layer == "string" ? layer : "released";
    };
    let asked = 0;
    for (const k of state.commits ?? [])
      if (k.sha == head ? k.release != "released" && k.release != "refused" : k.release == null && asked++ < ASKED)
        k.release = await stateOf(k.sha);
    release = state.commits?.find((k) => k.sha == head)?.release ?? (await stateOf(head));
    state.head = head;
    await copy(null);
  } catch (e) {
    return stop(e);
  }
  c.at = `${c.spec.branch} on ${c.spec.repo} is at ${short(head)}`;

  // An admin's ask: it runs one time. The job takes the instance's lock first, and then takes the ask off the row.
  const asks = control?.[0];
  if (asks?.ask != null) {
    const ask = /^(?:deploy ([0-9a-f]{40})|rollback)$/.exec(String(asks.ask));
    const by = String(asks.ask_by ?? "");
    const when = asks.ask_at;
    if (!ask || !/^[^\n\r]{1,100}$/.test(by) || typeof when != "number")
      return `${c.at}. The ask on the instance is not one that the deployer reads.`;
    const sha = ask[1] ?? null;
    const start = {
      kind: sha ? ("deploy" as const) : ("rollback" as const),
      command: sha ? `deploy ${short(sha)}` : "rollback",
      source: `app, by ${by}`,
      sha,
    };
    return job(c, start, `The ${start.kind} that ${by} asked for`, async (log) => {
      const took = await rows(
        db,
        "UPDATE deploy_control SET ask = NULL, ask_by = NULL, ask_at = NULL WHERE id = 1 AND ask = ? AND ask_by = ? AND ask_at = ? RETURNING id",
        String(asks.ask),
        by,
        when
      );
      if (!took.length) throw new Error("The ask changed before its job started: nothing is done.");
      if (!sha) return back(c, log);
      // A commit of another branch is refused, whatever the registry has of it (a build of verify stays off staging).
      // The registry first, for a commit that the look did not see: it has no limit on its calls, and GitHub's API has
      // one (60 an hour with no login, for all Workers together). Then the API says whether the branch has the commit.
      const seen = state.commits?.some((k) => k.sha == sha);
      if (!seen && (await layerOf(c, sha)) == "none")
        throw new Error(
          `GitHub's registry has no release of ${short(sha)} among the releases of ${c.spec.branch} on ${c.spec.repo}: the instance deploys only a commit of that branch, when its release is built.`
        );
      if (!seen && !(await onBranch(c, sha)))
        throw new Error(
          `Release ${short(sha)} is not a commit of ${c.spec.branch} on ${c.spec.repo}: the instance deploys only a commit of that branch.`
        );
      return deploy(c, sha, log);
    });
  }

  if (!state.auto) return `${c.at}. Auto-deploy is off.`;
  const tried = state.tried?.sha == head ? state.tried : null;
  if (tried?.ok) return `${c.at}. The instance has ${short(head)}: nothing to deploy.`;
  if (tried && (tried.up || tried.n >= TRIES))
    return `${c.at}. Its deploy failed: the deployer waits for a new commit, or for an admin's ask.`;
  if (release == "none") return `${c.at}. GitHub has no release of it yet: the deployer waits.`;
  if (release == "refused") return `${c.at}. What GitHub's registry has for it is not a release: it is not deployed.`;
  // A head that the deployer did not try: the instance may run it already (a deploy from a machine, a new deployer).
  if (!tried && (await healthNow(c, short(head))).ok) {
    state.tried = { sha: head, n: 0, ok: true, up: true };
    return `${c.at}. The instance has ${short(head)}: nothing to deploy.`;
  }
  return job(c, { kind: "deploy", command: `deploy ${head}`, source: "auto-deploy", sha: head }, "Its deploy", (log) => {
    log(`${c.at}: auto-deploy deploys its release.`);
    return deploy(c, head, log);
  });
}

/** The Worker, with its ways out (a test gives its own). */
export const deployer = (io: IO) => ({
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const store = io.store ?? storeOf(env);
    const state = await store.take(io.now());
    if (!state) return console.log("Another run of the deployer holds its lock: this one does nothing.");
    const c: Run = { io, env, store, state, spec: state.spec!, calls: 0, at: "" };
    const line = await run(c).catch((e) => `The deployer stopped: ${said(e)}`);
    delete state.lock;
    await store.put(state);
    console.log(`${line} (${c.calls} calls)`);
  },
});
