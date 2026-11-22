// The deployer on Cloudflare: a Worker in the person's own account that deploys the instance's branch by itself. It
// has no route and no address. Its schedule runs it each minute, and ONE RUN IS ONE DEPLOY: a run carries no work over
// to the next one, and it always ends with a result.
//
// A run:
//   1. Takes the deployer's lock (its own Durable Object: store.ts). A run that stopped frees it after LOCK_MS.
//   2. Reads the instance's spec, and the admin's switch and ask (the instance's database, through the binding DB).
//   3. Reads GitHub: the branch's head, its last commits, and whether each has a release.
//   4. Deploys, when an admin asked or auto-deploy has a new commit: the release from GitHub's registry (checked
//      against its digest), its new migrations, the static files, the Worker. Then the instance's own /api/health
//      must answer healthy two times in a row within HEALTH_MS; else one call puts the version before back.
//   5. Writes its look and the job into the instance's rows (deploy_control, deploy_jobs), where /admin/deploy reads
//      them. The job's row is also the lock that a deploy from a machine takes (instance.ts).
//   6. After a healthy deploy, uploads the release's deployer code as its own (renew).
//
// Setup gives it its bindings (worker-form.ts, deployerForm), and each deploy after gives them again: KEY (a secret,
// which seals the token in the store), ACCOUNT and WORKER (every call of Cloudflare's API is for those two), DATABASE
// and DB (the instance's database: its id, and the binding), STATE (the store) and INSTANCE (the instance's Worker).
// The token is no part of the install: a person pastes it on the instance, which hands it to `fetch` here (token.ts).
// With no token, a run looks at GitHub and deploys nothing.
//
// Health is the server's own answer to a request ({ok, version, checks, upload}: server/health.ts). `upload` is the
// name that this deployer gave its upload: the answer must be that upload's, not the version before's. The migrations
// only add, so the version before runs on the newer tables: an unhealthy release goes back with no change to the
// database, and the log gives the one command that restores the database too.
//
// No Effect here, by Pete's word (2026-11-20): "the deployer as compact and dead simple as possible, so a bad Erga
// deploy can't take it down". Plain TypeScript, and only the plain files of this folder (worker-form.ts, bindings.ts,
// d1-binding.ts, store.ts, tags.ts, token.ts). A test holds its size, its lines and its calls
// (tests/deployer-worker.test.ts).
//
// Trap: its fetch handler takes a token to check, and nothing else (token.ts): it starts no deploy.
// Trap: Cloudflare takes a Worker's module only when each thing that it exports is a handler or a class: the module
// that it runs is worker-main.ts, which exports the Worker and its store, and nothing else of this file.
// Trap: one run may make CALLS calls at most (Cloudflare's free plan stops a run at 50). Every call goes through `net`.
// Trap: the spec's names go into addresses. specOf checks each one that this file uses, with spec.ts's own patterns.

import { bindingsProblem } from "./bindings";
import { type D1, statementsOf } from "./d1-binding";
import type { Release, ReleaseIndex } from "./release-format";
import type { CloudflareTarget, Spec } from "./spec";
import { type Store, storeOf } from "./store";
import * as tags from "./tags";
import { answer, open } from "./token";
import { DEPLOYER_MODULE, deployerForm, deployerName, HEADERS_FILE, toHex, typeOf, workerMetadata } from "./worker-form";

export { DeployerState, LOCK_MS } from "./store";
/** How long a deploy waits for the new release's healthy answer, and how often it asks. */
export const HEALTH_MS = 30_000;
const HEALTH_EACH_MS = 5000;
/** The most calls out of one run, and how many the Worker's upload leaves room for: the upload, the health checks, a rollback, its own code. */
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
  tag?: string;
}
type CloudSpec = Pick<Spec, "repo" | "branch" | "settings"> & { target: CloudflareTarget };

/** What the deployer keeps from run to run, in its own store. */
export interface State {
  /** When the run that holds the lock took it. */
  lock?: number;
  /** The last look: the branch's head, commits and newest release tag. */
  head?: string;
  commits?: Commit[];
  latestRelease?: tags.LatestRelease | null;
  /** The last commit that auto-deploy tried: how often (TRIES: no more, as after the Worker's upload), and whether its deploy ended well. */
  tried?: { sha: string; n: number; ok: boolean };
  /**
   * The job that a run started and did not end. `row`: its row on the instance. `before`: the version to go back to,
   * and `upload`: the upload's own name (ERGA_UPLOAD), both set just before the Worker's upload.
   */
  job?: { row: number; sha: string | null; before?: string | null; upload?: string };
}

export interface Env {
  KEY: string;
  ACCOUNT: string;
  WORKER: string;
  DATABASE: string;
  DB: D1;
  STATE: { idFromName(name: string): unknown; get(id: unknown): { fetch: Fetch } };
  INSTANCE: { fetch: Fetch };
}

/** The ways out of a run: the network and the time (a test gives its own). `version`: the release that this code is of. */
export interface IO {
  fetch: Fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  version: string;
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
  /** The token for the instance's Worker, opened from the store. null: the deployer holds none. */
  bearer: string | null;
  /** After a healthy deploy: the release, its deployer code (none: a release from before it had one), and the job's row. */
  renew?: { version: string; code?: string; row: number };
}

const NO_TOKEN = "The deployer has no token: an admin pastes one on the instance's Deploy page (/admin/deploy).";

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
const textOf = async (c: Run, url: string) => (await (await page(c, url))?.text()) ?? "";

/** The branch's head and semver release tags (newest first), from git's own list of the repository's refs. */
async function refsOf(c: Run): Promise<{ head: string; tags: tags.ReleaseTag[] }> {
  const { repo, branch } = c.spec;
  const { head, tags: all } = tags.parseRefs(await textOf(c, `https://${repo}.git/info/refs?service=git-upload-pack`), branch);
  if (head) return { head, tags: all };
  throw new Error(`GitHub lists no branch ${branch} of ${repo}: the repository and the branch must be there, and public.`);
}

/** The branch's last commits, newest first, from its feed. The titles are a stranger's text: whatever shows them escapes them. */
async function commitsOf(c: Run): Promise<Commit[]> {
  const parsed = tags.parseCommitsFeed(await textOf(c, `https://${c.spec.repo}/commits/${c.spec.branch}.atom`));
  if (parsed) return parsed;
  throw new Error("The deployer can't read GitHub's feed of the branch's commits.");
}

/** Whether the branch has the commit of a release tag, as GitHub's API says it (60 calls an hour with no credential). */
async function onBranch(c: Run, sha: string): Promise<boolean> {
  const { repo, branch } = c.spec;
  const r = await page(c, `https://api.github.com/repos/${repo.slice("github.com/".length)}/compare/${branch}...${sha}?per_page=1`, {
    Accept: "application/vnd.github+json",
  });
  return !!r && ((await r.json()) as { ahead_by?: number }).ahead_by === 0;
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
 * static files as the bundle holds them (base64), by path: they go up as they are. `self`: the deployer's own code.
 */
async function releaseOf(c: Run, sha: string): Promise<{ release: Release; files: Record<string, string>; self?: string }> {
  const at = `ghcr.io/${packageOf(c.spec)}:${sha}`;
  const no = (why: string) => new Error(`${at} is not deployed: ${why}.`);
  const layer = await layerOf(c, sha);
  if (layer == "none") throw new Error(`GitHub's registry has no release of ${short(sha)}.`);
  if (layer == "refused") throw no("it is not a release");
  const blob = await page(c, `https://ghcr.io/v2/${packageOf(c.spec)}/blobs/${layer.digest}`, { Authorization: `Bearer ${c.token}` });
  if (!blob) throw no("the registry does not have its bundle");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength != layer.size || `sha256:${await sha256(bytes)}` != layer.digest)
    throw no("its bundle is not the one that its manifest names");
  const { index, files } = JSON.parse(new TextDecoder().decode(bytes)) as { index: ReleaseIndex; files: Record<string, string> };
  if (!index || !files || typeof index.version != "string" || index.version.length < 12 || !sha.startsWith(index.version))
    throw no(`it says that it is ${index?.version}, not that commit`);
  const part = (dir: string, names: string[], as: (text: string) => unknown = (text) => text) =>
    Object.fromEntries(
      names.map((n) => {
        if (typeof files[`${dir}/${n}`] != "string") throw no(`it has no ${dir}/${n}`);
        return [n, as(files[`${dir}/${n}`])];
      })
    );
  const assets = part("assets", index.assets) as Record<string, string>;
  const headers = assets[HEADERS_FILE.slice(1)];
  delete assets[HEADERS_FILE.slice(1)];
  const release: Release = {
    ...index,
    modules: part("bundle", index.modules, fromBase64) as Release["modules"],
    // Only the file of headers: the Worker's metadata holds it. The other files stay as base64 (`files`).
    assets: headers ? { [HEADERS_FILE]: fromBase64(headers) } : {},
    migrations: part("migrations", index.migrations, (text) => new TextDecoder().decode(fromBase64(text))) as Release["migrations"],
  };
  return { release, files: Object.fromEntries(Object.entries(assets).map(([n, text]) => [`/${n}`, text])), self: files[DEPLOYER_MODULE] };
}

// ------------------------------------------------------------------ Cloudflare

/** One call of Cloudflare's API for the instance's Worker: its result. `bearer`: an upload's own token. */
async function cf<T>(c: Run, method: string, path: string, body?: object | FormData | Blob, bearer = c.bearer): Promise<T> {
  if (!bearer) throw new Error(NO_TOKEN);
  const plain = body && !(body instanceof FormData) && !(body instanceof Blob);
  const r = await net(c, `https://api.cloudflare.com/client/v4/accounts/${c.env.ACCOUNT}/workers${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...(plain ? { "Content-Type": "application/json" } : {}) },
    body: plain ? JSON.stringify(body) : (body as FormData | Blob | undefined),
  });
  type Answer = { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] | null } | null;
  const answer = (await r.json().catch(() => null)) as Answer;
  if (r.ok && answer?.success) return answer.result as T;
  const errors = (answer?.errors ?? []).map((e) => `: ${e.message} [code ${e.code}]`).join("");
  throw new Error(`Cloudflare refused ${method} ${path.replace(/\?.*/, "")} (it answered ${r.status}${errors}).`);
}

/** The Worker's versions as its deployments had them, newest first, each one time: the first one serves now. */
async function versionsOf(c: Run): Promise<string[]> {
  type Deployments = { deployments?: { created_on: string; versions: { version_id: string; percentage: number }[] }[] };
  const list = (await cf<Deployments>(c, "GET", `/scripts/${c.env.WORKER}/deployments`))?.deployments ?? [];
  const newest = [...list].sort((x, y) => Date.parse(y.created_on) - Date.parse(x.created_on));
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

/**
 * Applies the release's migrations that the database does not have, each with its record in one transaction: their
 * names. (The record's table is there: the instance's first deploy, from a machine, made it.)
 */
async function migrate(db: D1, migrations: Record<string, string>): Promise<string[]> {
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
  if (!bearer) throw new Error("Cloudflare gave no upload token for the editor's files.");
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
      `This release has ${groups.length} uploads of files, and the run has room for ${CALLS - RESERVE - c.calls}. Nothing changed. Deploy it one time from a machine: bun erga deploy ${hostOf(c.spec.target)}`
    );
  let done: string | null = null;
  for (const group of groups) {
    const paths = group.map((hash) => byHash.get(hash) ?? "");
    if (paths.includes("")) throw new Error("Cloudflare asked for a file that the release doesn't have.");
    const form = new FormData();
    for (const [i, hash] of group.entries()) form.append(hash, new File([files[paths[i]]], hash, { type: typeOf(paths[i]) }));
    const body = single ? new Blob([fromBase64(files[paths[0]])], { type: typeOf(paths[0]) }) : form;
    const answer = await cf<Session>(c, "POST", single ? `/assets/upload/${group[0]}` : "/assets/upload?base64=true", body, bearer);
    if (answer?.jwt) done = answer.jwt;
  }
  if (!done) throw new Error("Cloudflare took the editor's files but didn't say that the upload was complete.");
  return done;
}

// ------------------------------------------------------------------ health

interface Health {
  ok: boolean;
  why: string;
  version?: string;
}
type Report = {
  ok?: boolean;
  version?: string;
  upload?: string | null;
  checks?: Record<string, { ok: boolean; ms?: number; error?: string }>;
} | null;

/**
 * One ask of the instance's own /api/health: whether the release `want` (null: any) answers that it is healthy.
 * `upload`: the name of the upload that must answer (ERGA_UPLOAD: the server says which upload it is; a release from
 * before 2026-11-20 does not). The public address first. An answer there that is not the server's (Cloudflare Access's,
 * or Cloudflare's own for an address that a Worker may not call) goes to the instance's Worker itself, for the rest of
 * the run: the same request.
 */
async function healthNow(c: Run, want: string | null, upload?: string): Promise<Health> {
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
    if (upload && h.upload != null && h.upload != upload)
      return { ok: false, why: "the version before still answers, not this upload", version };
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
async function settledHealth(c: Run, want: string | null, upload?: string): Promise<Health> {
  let last: Health = { ok: false, why: "it gave no answer" };
  for (let waited = HEALTH_EACH_MS, good = 0; waited <= HEALTH_MS; waited += HEALTH_EACH_MS) {
    await c.io.sleep(HEALTH_EACH_MS);
    last = await healthNow(c, want, upload);
    good = last.ok ? good + 1 : 0;
    if (good == 2) return last;
  }
  return last.ok ? { ok: false, why: "it answered healthy one time only, at the end of the wait", version: last.version } : last;
}

// ------------------------------------------------------------------ a deploy, and a rollback

/** Deploys the release of `sha`. It fails with what stopped it; an unhealthy release goes back first. */
async function deploy(c: Run, sha: string, log: (line: string) => void): Promise<void> {
  const W = c.env.WORKER;
  const { release, files, self } = await releaseOf(c, sha);
  const problem = bindingsProblem(release);
  if (problem) throw new Error(problem);
  log(`Fetch the release from GitHub: done, ghcr.io/${packageOf(c.spec)}:${sha}, checked against its digest`);
  const before = (await versionsOf(c))[0] ?? null;
  const at = c.io.now();
  const applied = await migrate(c.env.DB, release.migrations);
  log(
    `Set up the database's tables: done, ${applied.length ? `applied ${applied.join(", ")}` : "already up to date"}; restore point: ${before ? `version ${before}` : "no version"}, the database at ${new Date(at).toISOString()}`
  );
  const assetsJwt = await uploadFiles(c, files);
  log(`Upload the editor's files: done, ${Object.keys(files).length} files`);
  // From here the instance may run the release: the store knows where to go back to, also for the run after a run that stopped.
  const upload = `${release.version}-${c.io.now()}`;
  const job = c.state.job!;
  Object.assign(job, { before, upload });
  if (c.state.tried?.sha == sha) c.state.tried.n = TRIES;
  await c.store.put(c.state);
  const form = new FormData();
  form.set("metadata", JSON.stringify(workerMetadata(release, c.spec, { dbId: c.env.DATABASE, assetsJwt, upload, deployer: true })));
  for (const [module, bytes] of Object.entries(release.modules))
    form.append(module, new File([new Uint8Array(bytes)], module, { type: "application/javascript+module" }));
  await cf(c, "PUT", `/scripts/${W}`, form);
  log(`Upload the Worker, with its settings: done, ${W}, release ${release.version}`);
  const h = await settledHealth(c, release.version, upload);
  if (h.ok) {
    c.renew = { version: release.version, code: self, row: job.row };
    return log(`Wait for its health: done, release ${release.version}, healthy (${h.why})`);
  }
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

/**
 * After a run that deployed, and last of all (Cloudflare starts the deployer again with the upload): the release's
 * deployer code as the deployer's own, with what setup gave it. A token may be for the instance's Worker only: then
 * the code stays. The store keeps how it went, for /admin/deploy: as done before the upload (the code that asked may
 * not run after it), and why not when the upload failed. The job's log gets the same line.
 */
async function renew(c: Run): Promise<void> {
  const { version, code, row } = c.renew!;
  const name = deployerName(c.env.WORKER);
  const note = (why: string | null) => quiet(c.store.says({ renewed: { at: c.io.now(), version, why } }));
  let why: string | null = `Release ${version} carries no deployer code.`;
  if (code) {
    await note(null);
    why = await cf(c, "PUT", `/scripts/${name}`, deployerForm(fromBase64(code), c.env.ACCOUNT, c.env.WORKER, c.env.DATABASE)).then(
      () => null,
      (e) => `${said(e)} A token for ${name} too changes that.`
    );
  }
  if (why) await note(why);
  const line = why ? `The deployer keeps its code. ${why}` : `Update the deployer: done, ${name} has this release's code`;
  await quiet(rows(c.env.DB, "UPDATE deploy_jobs SET log = log || ? WHERE id = ?", `${line}\n`, row));
}

/** The rollback that an admin asked for: the version before the one that runs, and its own healthy answer. */
async function back(c: Run, log: (line: string) => void): Promise<void> {
  const W = c.env.WORKER;
  const [now, before] = await versionsOf(c);
  if (!now || !before) throw new Error(`${W} has no deployment of another version to go back to.`);
  // The release and the upload of the version before, from the version's own bindings: the health check waits for that one.
  const version = await cf<{ resources?: { bindings?: { name: string; text?: string }[] } }>(c, "GET", `/scripts/${W}/versions/${before}`);
  const text = (name: string) => version?.resources?.bindings?.find((b) => b.name == name)?.text;
  const to = text("ERGA_VERSION") ?? null;
  log(
    `The Worker ${W} runs version ${now}. The rollback goes to the version before it: ${before}${to ? ` (release ${to})` : ""}. The database stays as it is.`
  );
  await rollbackTo(c, before, "rollback");
  const h = await settledHealth(c, to, text("ERGA_UPLOAD"));
  if (!h.ok) throw new Error(`The health check fails after the rollback: ${h.why}`);
  log(`Release ${h.version ?? "?"} runs again, healthy (${h.why}).`);
}

// ------------------------------------------------------------------ a job, and a run

/** Writes the job's end into its row, and takes the job off the store's state. */
async function end(c: Run, lines: string[], failed: string | null) {
  const job = c.state.job!;
  const sql = "UPDATE deploy_jobs SET log = log || ?, state = ?, alive = ? WHERE id = ?";
  await quiet(rows(c.env.DB, sql, `${lines.join("\n")}\n`, failed ? `failed: ${failed}` : "done", c.io.now(), job.row));
  if (job.sha && c.state.tried?.sha == job.sha) c.state.tried.ok = !failed;
  delete c.state.job;
}

const JOB_SQL =
  "INSERT INTO deploy_jobs (kind, command, source, sha, started, alive, state) SELECT ?, ?, ?, ?, ?, ?, 'running' WHERE NOT EXISTS (SELECT 1 FROM deploy_jobs WHERE state = 'running' AND alive > ?) RETURNING id";

/**
 * One job: its row on the instance (the instance's lock: one job at a time, also with a machine's), the work, and its
 * end, whatever stopped the work. `by`: the admin who asked; null: auto-deploy. The result: the run's line.
 */
async function job(
  c: Run,
  kind: "deploy" | "rollback",
  command: string,
  by: string | null,
  sha: string | null,
  work: (log: (line: string) => void) => Promise<void>
): Promise<string> {
  const now = c.io.now();
  const [made] = await rows(c.env.DB, JOB_SQL, kind, command, by ? `app, by ${by}` : "auto-deploy", sha, now, now, now - LEASE_MS);
  if (!made) return `${c.at}. A job runs on the instance: the deployer waits.`;
  c.state.job = { row: Number(made.id), sha };
  if (!by && sha) c.state.tried = { sha, n: (c.state.tried?.sha == sha ? c.state.tried.n : 0) + 1, ok: false };
  await c.store.put(c.state);
  const lines: string[] = [];
  const failed = await work((line) => void lines.push(line)).then(() => null, said);
  if (failed) lines.push(failed);
  await end(c, lines, failed);
  return `${c.at}. ${by ? `The ${kind} that ${by} asked for` : "Its deploy"} ${failed ? `failed: ${failed}` : "is done."}`;
}

/** The job of a run that stopped with no end: its release is healthy, or the instance goes back; then the job ends. */
async function settle(c: Run) {
  const { sha, before, upload } = c.state.job!;
  let failed: string | null = "The deployer's run stopped before the job's end.";
  if (before === undefined) failed += " Nothing that the instance runs changed.";
  else {
    const h = await healthNow(c, sha ? short(sha) : null, upload);
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

const LOOK_SQL =
  "INSERT INTO deploy_control (id, looked, head, error, commits, latest_release) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET looked = excluded.looked, head = excluded.head, error = excluded.error, commits = excluded.commits, latest_release = excluded.latest_release";
const ASK_SQL =
  "UPDATE deploy_control SET ask = NULL, ask_by = NULL, ask_at = NULL WHERE id = 1 AND ask = ? AND ask_by = ? AND ask_at = ? RETURNING id";

/** One run, with the lock held. The result: one line that says what it did. */
async function run(c: Run): Promise<string> {
  const { state } = c;
  const db = c.env.DB;
  // What the look saw, or why it failed: on the instance, for /admin/deploy.
  const copy = (error: string | null) => {
    const commits = JSON.stringify((state.commits ?? []).map((k) => ({ ...k, release: k.release ?? "none" })));
    const latest = state.latestRelease ? JSON.stringify(state.latestRelease) : null;
    return quiet(rows(db, LOOK_SQL, c.io.now(), state.head ?? null, error, commits, latest));
  };
  const stop = async (e: unknown) => {
    await copy(said(e));
    return said(e);
  };

  // The instance's spec, its switch and an admin's ask.
  const [spec] = await rows(db, "SELECT spec FROM deploy_spec WHERE id = 1");
  if (!spec) return "The instance has no spec: nothing to look at.";
  try {
    c.spec = specOf(JSON.parse(String(spec.spec)), c.env);
  } catch (e) {
    return stop(e);
  }
  if (state.job) await settle(c);
  const [control] = await rows(db, "SELECT auto, auto_mode, ask, ask_by, ask_at FROM deploy_control WHERE id = 1");
  const mode = tags.autoModeOf(control?.auto as number | undefined, control?.auto_mode as string | undefined);

  // GitHub: the head, the release tags, the commits when the head is new, and each commit's release.
  let head: string;
  let release: ReleaseState;
  try {
    const refs = await refsOf(c);
    head = refs.head;
    if (state.commits?.[0]?.sha != head) {
      const known = new Map((state.commits ?? []).map((k) => [k.sha, k.release]));
      const feed = await commitsOf(c);
      if (feed[0]?.sha == head) state.commits = feed.slice(0, COMMITS).map((k) => ({ ...k, release: known.get(k.sha) }));
    }
    const bySha = tags.tagBySha(refs.tags);
    for (const k of state.commits ?? []) k.tag = bySha.get(k.sha);
    const latestTag = await tags.resolveLatestTag(refs.tags, head, state.commits, state.latestRelease, (sha) => onBranch(c, sha));
    const stateOf = (sha: string): Promise<ReleaseState> => layerOf(c, sha).then((l) => (typeof l == "string" ? l : "released"));
    let asked = 0;
    for (const k of state.commits ?? []) {
      const retry = k.sha == head || (mode == "releases" && k.sha == latestTag?.sha);
      if (retry ? k.release != "released" && k.release != "refused" : k.release == null && asked++ < ASKED)
        k.release = await stateOf(k.sha);
    }
    release = state.commits?.find((k) => k.sha == head)?.release ?? (await stateOf(head));
    const prev = latestTag && state.latestRelease?.sha == latestTag.sha ? state.latestRelease.release : null;
    state.latestRelease = latestTag
      ? {
          tag: latestTag.tag,
          sha: latestTag.sha,
          release:
            state.commits?.find((k) => k.sha == latestTag.sha)?.release ?? (prev && prev != "none" ? prev : await stateOf(latestTag.sha)),
        }
      : null;
    state.head = head;
    await copy(null);
  } catch (e) {
    return stop(e);
  }
  const { branch, repo } = c.spec;
  c.at = `${branch} on ${repo} is at ${short(head)}`;

  // An admin's ask: it runs one time. The job takes the instance's lock first, and then takes the ask off the row.
  if (control?.ask != null) {
    const ask = /^(?:deploy ([0-9a-f]{40})|rollback)$/.exec(String(control.ask));
    const by = String(control.ask_by ?? "");
    const when = control.ask_at;
    if (!ask || !/^[^\n\r]{1,100}$/.test(by) || typeof when != "number")
      return `${c.at}. The ask on the instance is not one that the deployer reads.`;
    const sha = ask[1] ?? null;
    return job(c, sha ? "deploy" : "rollback", sha ? `deploy ${short(sha)}` : "rollback", by, sha, async (log) => {
      const took = await rows(db, ASK_SQL, String(control.ask), by, when);
      if (!took.length) throw new Error("The ask changed before its job started: nothing is done.");
      if (!sha) return back(c, log);
      // Only a commit that the look saw on the branch: the instance offers no other (server/operations/deploys.ts).
      if (!state.commits?.some((k) => k.sha == sha))
        throw new Error(`${short(sha)} is not one of the last commits of ${branch} on ${repo}: the deployer deploys only those.`);
      return deploy(c, sha, log);
    });
  }

  const target = tags.pickAutoTarget(mode, branch, head, release, state.latestRelease ?? null);
  if ("wait" in target) return `${c.at}. ${target.wait}`;
  if (!c.bearer) return `${c.at}. ${NO_TOKEN}`;
  const tried = state.tried?.sha == target.sha ? state.tried : null;
  if (tried?.ok) return `${c.at}. The instance has ${short(target.sha)}: nothing to deploy.`;
  if (tried && tried.n >= TRIES)
    return `${c.at}. Its deploy failed: the deployer waits for a new ${target.tag ? "release" : "commit"}, or for an admin's ask.`;
  if (target.release == "none") return `${c.at}. GitHub has no release of ${target.tag ?? "it"} yet: the deployer waits.`;
  if (target.release == "refused")
    return `${c.at}. What GitHub's registry has for ${target.tag ?? "it"} is not a release: it is not deployed.`;
  // A target that the deployer did not try: it may run already, or a job (deploy then rollback) already tried it.
  if (!tried) {
    const seen = await rows(db, "SELECT 1 FROM deploy_jobs WHERE sha = ? LIMIT 1", target.sha);
    if (seen.length || (await healthNow(c, short(target.sha))).ok) {
      state.tried = { sha: target.sha, n: 0, ok: true };
      return `${c.at}. The instance has ${short(target.sha)}: nothing to deploy.`;
    }
  }
  const command = target.tag ? `deploy ${target.tag} (${short(target.sha)})` : `deploy ${target.sha}`;
  return job(c, "deploy", command, null, target.sha, (log) => {
    log(`${c.at}: auto-deploy deploys ${target.tag ? `release ${target.tag} (${short(target.sha)})` : "its release"}.`);
    return deploy(c, target.sha, log);
  });
}

/** The Worker, with its ways out (a test gives its own). */
export const deployer = (io: IO) => ({
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const store = storeOf(env);
    const state = await store.take(io.now());
    if (!state) return console.log("Another run of the deployer holds its lock: this one does nothing.");
    const bearer = await open(env.KEY, (await store.says()).token);
    const c: Run = { io, env, store, state, spec: null as never, calls: 0, at: "", bearer };
    const line = await run(c).catch((e) => `The deployer stopped: ${said(e)}`);
    delete state.lock;
    await store.put(state);
    console.log(`${line} (${c.calls} calls)`);
    if (c.renew) await renew(c);
  },
  fetch: (request: Request, env: Env): Promise<Response> => answer(request, io, env, storeOf(env)),
});
