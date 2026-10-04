// The deploy pipeline: the one way any Erga server is deployed, through the
// Cloudflare API, with no CLI and no container. Each step below is a few
// plain API calls, so a page can show them one at a time, and the tests run
// every one against a mock Cloudflare (deploy/mock.ts).
//
// Its input is a target (Target: an account, a Worker, a database, its
// addresses, settings and secrets, and maybe a snapshot to copy in) and a
// release (deploy/release.ts: the Worker exactly as `cf build` builds it from
// cloudflare.config.ts, its static assets and the migrations). Its output is
// a live server, each step reported as it goes. Three kinds of targets use it:
//
//   - /deploy (worker/deployer.ts, deploy/page.ts): a copy of Erga on
//     someone's own Cloudflare account, them its admin (targetOfPlan);
//   - production and staging (deploy/targets.ts): erga.dev and
//     staging.erga.dev, deployed by the server itself when their branch moves
//     (deploy/branches.ts, worker/pipeline.ts), or from a machine (deploy/run.ts);
//   - staging takes a fresh copy of production's data on every deploy
//     (Target.snapshot: the "data" and "documents" steps).
//
// The steps (ALL_STEPS): check the account, find or make the D1 database
// (afresh, for a snapshot), copy the source's database into it, apply
// migrations/ to it (recorded in d1_migrations, as `cf d1 migrations apply`
// does), upload the static assets (direct upload), upload the Worker with its
// bindings, secrets and Durable Objects, give it its address (workers.dev,
// or a custom domain), give documents' pages theirs, wait for it to answer,
// and copy the source's documents into it. A new server makes its own front
// page from the landing project built into it, the first time someone opens
// it (front.ts), owned by its first admin.


import { createHash } from "node:crypto";
import { copyDocuments } from "./snapshot";

export const API = "https://api.cloudflare.com/client/v4";
export type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** Something Cloudflare refused or that went wrong, said for a person to act on. */
export class DeployError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

interface Envelope<T> { success: boolean; result: T; errors?: { code: number; message: string }[]; result_info?: unknown }

/**
 * The Cloudflare API with one token. Every call says what it's for (`what`,
 * "make the database"), so a refusal reads as what couldn't be done and why:
 * a token without the permission, a bad token, or Cloudflare's own message.
 */
export class Cloudflare {
  constructor(private token: string, private fetch: Fetch = globalThis.fetch) {}

  async call<T>(method: string, path: string, what: string, body?: unknown, opts: { bearer?: string; allow404?: boolean } = {}): Promise<T | null> {
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.bearer ?? this.token}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body instanceof Blob) { payload = body; headers["Content-Type"] = body.type || "application/null"; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
    let r: Response;
    try { r = await this.fetch(`${API}${path}`, { method, headers, body: payload }); } catch (e) {
      throw new DeployError(`Couldn't reach Cloudflare to ${what}: ${(e as Error).message}. Try again in a moment.`);
    }
    const answer = (await r.json().catch(() => null)) as Envelope<T> | null;
    if (r.status == 404 && opts.allow404) return null;
    if (r.ok && answer?.success !== false) return (answer?.result ?? null) as T | null;
    throw new DeployError(explain(what, r.status, answer?.errors ?? []), r.status);
  }
}

/** A refusal from Cloudflare, in plain words. */
export function explain(what: string, status: number, errors: { code: number; message: string }[]): string {
  const said = errors.map((e) => (e.code ? `${e.message} [code ${e.code}]` : e.message)).filter(Boolean).join("; ");
  if (status == 401 || errors.some((e) => e.code == 1000 || e.code == 9109 || e.code == 6003)) {
    return `Cloudflare didn't accept the token when we tried to ${what}: it may be mistyped, expired or revoked. Connect again with a new one.${said ? ` (Cloudflare said: ${said})` : ""}`;
  }
  if (status == 403 || errors.some((e) => e.code == 10000 || e.code == 9103)) {
    return `The token isn't allowed to ${what}. Make a new token with the link on this page (it has every permission the deploy needs), or add the missing permission to yours.${said ? ` (Cloudflare said: ${said})` : ""}`;
  }
  if (status == 429) return `Cloudflare asked us to slow down while we tried to ${what}. Wait a minute and try again.${said ? ` (Cloudflare said: ${said})` : ""}`;
  if (status >= 500) return `Cloudflare had a problem on its side while we tried to ${what}${said ? ` (Cloudflare said: ${said})` : ` (it answered ${status})`}. Try again in a few minutes.`;
  return `Cloudflare refused to ${what}${said ? `: ${said}` : ` (it answered ${status})`}.`;
}

// ------------------------------------------------------------------ release

/** One binding or Durable Object as `cf build` writes them (worker.config.json). */
export interface BuiltBinding { type: string; value?: string; exportName?: string; worker?: string; name?: string }
/** What `cf build` says about the Worker (its worker.config.json), as the release carries it. */
export interface BuiltWorker {
  name: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  assets?: { htmlHandling?: string; notFoundHandling?: string; runWorkerFirst?: boolean };
  observability?: { enabled?: boolean; logs?: { enabled?: boolean; invocationLogs?: boolean } };
  env: Record<string, BuiltBinding>;
  exports?: Record<string, { type: string; storage?: string; state?: string }>;
  manifest?: { mainModule?: string };
}

/** What's deployed: erga.dev's own build (deploy/release.ts makes it, into the server's static assets under /release/). */
export interface Release {
  /** Which build: the commit, and when it was made. */
  version: string;
  built: string;
  worker: BuiltWorker;
  mainModule: string;
  /** The Worker's modules by name (index.js, assets/….js). */
  modules: Record<string, Uint8Array>;
  /** Its static assets, by path ("/page.js"). */
  assets: Record<string, Uint8Array>;
  /** migrations/, by file name, in order. */
  migrations: Record<string, string>;
}

/** The release's table of contents (release.json). */
export interface ReleaseIndex {
  version: string;
  built: string;
  worker: BuiltWorker;
  mainModule: string;
  modules: string[];
  assets: string[];
  migrations: string[];
}

/** A release, read file by file (`get` answers a path under release/, or null). */
export async function loadRelease(get: (path: string) => Promise<Uint8Array | null>): Promise<Release | null> {
  const index = await get("release.json");
  if (!index) return null;
  const toc = JSON.parse(new TextDecoder().decode(index)) as ReleaseIndex;
  const read = async (dir: string, names: string[]) => {
    const out: Record<string, Uint8Array> = {};
    await Promise.all(names.map(async (n) => {
      const bytes = await get(`${dir}/${n}`);
      if (!bytes) throw new DeployError(`The release is missing ${dir}/${n}: build it again (bun deploy/release.ts).`);
      out[n] = bytes;
    }));
    return out;
  };
  const [modules, assets, migrations] = await Promise.all([read("bundle", toc.modules), read("assets", toc.assets), read("migrations", toc.migrations)]);
  return {
    version: toc.version, built: toc.built, worker: toc.worker, mainModule: toc.mainModule, modules,
    assets: Object.fromEntries(Object.entries(assets).map(([p, b]) => [`/${p}`, b])),
    migrations: Object.fromEntries(Object.entries(migrations).map(([n, b]) => [n, new TextDecoder().decode(b)])),
  };
}

// ------------------------------------------------------------------ the plan

/** Where the new server answers and where documents' pages run. */
export interface DeployPlan {
  accountId: string;
  /** The Worker's name ("erga"): also its workers.dev address, <name>.<subdomain>.workers.dev. */
  workerName: string;
  /** The account's workers.dev subdomain. */
  subdomain: string;
  /** The account has none yet: make `subdomain`. */
  createSubdomain?: boolean;
  /** The app's address: <name>.<subdomain>.workers.dev, or a hostname on one of the account's zones (a custom domain). */
  app: { kind: "workers.dev" } | { kind: "domain"; zoneId: string; zoneName: string; hostname: string };
  /**
   * Documents' pages: on a zone of their own, one origin per document
   * (<id>-<owner>.<zone>, a wildcard route and DNS record), as erga.dev does
   * on erga-pages.dev; or "shared", one origin for every document's pages at
   * <name>-pages.<subdomain>.workers.dev (workers.dev has no wildcards),
   * which keeps pages away from the app but not from each other.
   */
  pages: { kind: "shared" } | { kind: "zone"; zoneId: string; zoneName: string };
  /** The GitHub login deploying it: the new server's bootstrap admin (ADMINS). */
  admin: string;
  adminName?: string;
  /** The new server's GitHub OAuth app, for signing in. */
  githubClientId: string;
  githubClientSecret: string;
  /** Turns the agent on; optional. */
  anthropicKey?: string;
}

/** The database a /deploy server gets. */
const DB_NAME = "erga";

export const appHost = (p: Pick<DeployPlan, "app" | "workerName" | "subdomain">) =>
  p.app.kind == "domain" ? p.app.hostname : `${p.workerName}.${p.subdomain}.workers.dev`;
/** The shared pages host on workers.dev (pages: "shared"). */
export const sharedPagesHost = (p: Pick<DeployPlan, "workerName" | "subdomain">) => `${p.workerName}-pages.${p.subdomain}.workers.dev`;
/** How the pages address reads on the page: a wildcard, or the shared host. */
export const pagesShown = (p: Pick<DeployPlan, "pages" | "workerName" | "subdomain">) =>
  p.pages.kind == "zone" ? `*.${p.pages.zoneName}` : sharedPagesHost(p);

/** What's wrong with a plan, for the person filling it in; null if nothing. */
export function checkPlan(p: DeployPlan): string | null {
  if (!/^[a-f0-9]{32}$/.test(p.accountId)) return "Choose a Cloudflare account.";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(p.workerName)) return "The Worker's name is lowercase letters, digits and dashes.";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(p.subdomain)) return "Your workers.dev subdomain is lowercase letters, digits and dashes.";
  if (p.app.kind == "domain") {
    const h = p.app.hostname.toLowerCase();
    if (!(h == p.app.zoneName || h.endsWith(`.${p.app.zoneName}`)) || !/^[a-z0-9.-]+$/.test(h)) return `The app's address must be ${p.app.zoneName} or a name under it.`;
  }
  if (p.pages.kind == "zone" && p.app.kind == "domain" && p.pages.zoneId == p.app.zoneId) {
    return `Documents' pages need a different domain from the app's (${p.app.zoneName}): a page's scripts mustn't share the app's site. Pick another domain, or the shared pages address.`;
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(p.admin)) return "Sign in to Erga with GitHub first.";
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(p.githubClientId.trim())) return "Paste your GitHub OAuth app's Client ID.";
  if (p.githubClientSecret.trim().length < 20) return "Paste your GitHub OAuth app's client secret (generate one on the app's page).";
  if (p.anthropicKey && !p.anthropicKey.trim().startsWith("sk-")) return "An Anthropic API key starts with sk-; leave it empty to deploy without the agent.";
  return null;
}

/** The deploy page's steps, in order, as the page lists them (a /deploy target's: no copying of data). */
export const STEPS = [
  { id: "account", title: "Check your Cloudflare account" },
  { id: "database", title: "Make the database (D1)" },
  { id: "migrations", title: "Set up the database's tables" },
  { id: "assets", title: "Upload the editor's files" },
  { id: "worker", title: "Upload the Worker, with its settings and secrets" },
  { id: "address", title: "Give it its address" },
  { id: "pages", title: "Give documents' pages their own address" },
  { id: "live", title: "Wait for it to answer" },
] as const;

/** Every step the pipeline knows, in order: a target that copies another's data (staging) has all of them. */
export const ALL_STEPS = [
  STEPS[0], STEPS[1],
  { id: "data", title: "Copy production's database into it" },
  STEPS[2], STEPS[3], STEPS[4], STEPS[5], STEPS[6], STEPS[7],
  { id: "documents", title: "Copy production's documents into it" },
] as const;
export type StepId = (typeof ALL_STEPS)[number]["id"];

/** A target's steps: the deploy page's, and the two copying steps for one with a snapshot. */
export const stepsFor = (t: Pick<Target, "snapshot">) => ALL_STEPS.filter((s) => t.snapshot || (s.id != "data" && s.id != "documents"));

export type Report = (step: StepId, status: "running" | "done" | "skipped", detail?: string) => void;

/** What the deploy made: where the server is, and where its pages run. */
export interface Deployed { url: string; pages: string; database: string; worker: string }

/** The tag the deploy puts on the Workers it makes, so a second run knows them as its own. */
export const WORKER_TAG = "erga-deploy";

// ------------------------------------------------------------------ the pipeline

/**
 * Where a deploy goes: everything the pipeline needs to know about it, in
 * any account. /deploy makes one from the page's plan (targetOfPlan); the
 * branch deploys make production's and staging's from deploy/targets.ts
 * (deploy/branches.ts, targetOf).
 */
export interface Target {
  /** What to call it in the log ("staging", or the account's name). */
  label: string;
  accountId: string;
  /** The Worker's name: also its workers.dev address, <name>.<subdomain>.workers.dev. */
  workerName: string;
  /** The D1 database bound as DB: found by name, made if missing. */
  databaseName: string;
  /** The account's workers.dev subdomain: needed for a workers.dev app or shared pages host, checked (and made, with createSubdomain) when set. */
  subdomain?: string;
  createSubdomain?: boolean;
  /** The app's address: <name>.<subdomain>.workers.dev, or a hostname on one of the account's zones (a custom domain; the zone's id is looked up by name if not given). */
  app: { kind: "workers.dev" } | { kind: "domain"; zoneId?: string; zoneName: string; hostname: string };
  /**
   * Documents' pages: one origin per document under `domain` (default the
   * zone itself), with a wildcard route and DNS record on the zone; or
   * "shared", one origin for every document's pages at
   * <name>-pages.<subdomain>.workers.dev (workers.dev has no wildcards).
   */
  pages: { kind: "shared" } | { kind: "zone"; zoneId?: string; zoneName: string; domain?: string };
  /** Text bindings over the build's (cloudflare.config.ts as `cf build` wrote it). */
  vars: Record<string, string>;
  /** Secrets set with this upload. */
  secrets: Record<string, string>;
  /** Keep the Worker's other secrets from its last version (set once, deploy/setup.ts), as `cf deploy` does. */
  keepSecrets?: boolean;
  /** Service bindings, by binding name (BUILDER → erga-builder). */
  services?: Record<string, string>;
  /** Wait for this release's version to answer (GET /api/deploys/version), not only for the server to answer. */
  checkVersion?: boolean;
  /**
   * Copy another server's data in, on every deploy (staging: production's).
   * The target's database is made afresh from the source database's D1
   * export (read-only on the source), and each document's Durable Object
   * from the source server's snapshot endpoint (deploy/snapshot.ts),
   * authorized with `token`. Nothing is ever written to the source.
   */
  snapshot?: { databaseName: string; origin: string; token: string };
  /** This is production (erga.dev): only then may the target use production's names. */
  production?: boolean;
  /** Production's names (deploy/targets.ts PRODUCTION): a target that isn't production and uses one stops before it starts. */
  guard?: { worker: string; database: string; host: string; pages: string; accountId?: string };
}

/** What runs on from one step to the next (and across a restart, deploy/branches.ts keeps it): the database, the version, and the documents staging had before. */
export interface Carry { dbId?: string; version?: string; oldDocs?: string[] }

export const targetHost = (t: Pick<Target, "app" | "workerName" | "subdomain">) => (t.app.kind == "domain" ? t.app.hostname : `${t.workerName}.${t.subdomain}.workers.dev`);
export const targetSharedPagesHost = (t: Pick<Target, "workerName" | "subdomain">) => `${t.workerName}-pages.${t.subdomain}.workers.dev`;
export const targetPagesShown = (t: Pick<Target, "pages" | "workerName" | "subdomain">) =>
  t.pages.kind == "zone" ? `*.${t.pages.domain ?? t.pages.zoneName}` : targetSharedPagesHost(t);

/** The /deploy page's plan as a pipeline target: a new server in someone's own account, them its admin, its own secrets. */
export function targetOfPlan(plan: DeployPlan, sessionSecret: string): Target {
  return {
    label: plan.accountId, accountId: plan.accountId, workerName: plan.workerName, databaseName: DB_NAME,
    subdomain: plan.subdomain, createSubdomain: plan.createSubdomain, app: plan.app, pages: plan.pages,
    vars: {
      ADMINS: plan.admin.toLowerCase(),
      GITHUB_CLIENT_ID: plan.githubClientId.trim(),
      SERVER_CONFIG: "{}",
      // erga.dev's own deploy page needs erga.dev's OAuth client; the new server has none (the token link still works).
      CLOUDFLARE_OAUTH_CLIENT_ID: "",
      // Not one of Erga's own branch-deploy targets.
      DEPLOY_TARGET: "",
    },
    secrets: { SESSION_SECRET: sessionSecret, GITHUB_CLIENT_SECRET: plan.githubClientSecret.trim(), ...(plan.anthropicKey?.trim() ? { ANTHROPIC_API_KEY: plan.anthropicKey.trim() } : {}) },
  };
}

/** Why a target mustn't be deployed, or null: one that isn't production may not touch production's names, and a snapshot never goes into its own source. */
export function guardTarget(t: Target): string | null {
  const g = t.guard;
  const host = t.app.kind == "domain" ? t.app.hostname.toLowerCase() : null;
  const pages = t.pages.kind == "zone" ? (t.pages.domain ?? t.pages.zoneName).toLowerCase() : null;
  if (g && !t.production) {
    if (host == g.host || pages == g.pages) return `This deploy (${t.label}) would put a server on production's address (${host == g.host ? g.host : `*.${g.pages}`}). It stops here: production is deployed only as production.`;
    const sameAccount = !g.accountId || g.accountId == t.accountId;
    if (sameAccount && t.workerName == g.worker) return `This deploy (${t.label}) would replace production's Worker (${g.worker}). It stops here.`;
    if (sameAccount && t.databaseName == g.database) return `This deploy (${t.label}) would use production's database (${g.database}). It stops here.`;
  }
  if (t.snapshot) {
    if (t.production) return "Production never takes a copy of another server's data.";
    if (t.snapshot.databaseName == t.databaseName) return `A snapshot can't go into the database it's copied from (${t.databaseName}).`;
    if (g && (t.databaseName == g.database || t.workerName == g.worker)) return `A snapshot is made afresh in the target's database, which is deleted first: never production's (${g.database}).`;
  }
  return null;
}

/**
 * The deploy pipeline: puts `release` on `target`, step by step, reporting
 * each as it starts and ends. The one pipeline for every deploy: /deploy's
 * (another person's account), production's and staging's (deploy/branches.ts,
 * from inside the server itself, or deploy/run.ts from a machine). Every step
 * is safe to run again.
 *
 * `from` starts at a later step (after a restart: a server that deploys
 * itself is restarted by its own new version, deploy/branches.ts), with the
 * `carry` the earlier steps left; `checkpoint` hears of each finished step,
 * to keep that. `release` is needed only up to the Worker's upload.
 */
export async function runPipeline(cf: Cloudflare, release: Release | null, target: Target, opts: {
  report: Report; site?: Fetch; sleep?: (ms: number) => Promise<void>; waitMs?: number;
  from?: StepId; carry?: Carry; checkpoint?: (done: StepId, carry: Carry) => Promise<void> | void;
}): Promise<Deployed> {
  const { report } = opts;
  const site = opts.site ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const carry: Carry = opts.carry ?? {};
  const acc = `/accounts/${target.accountId}`;
  const host = targetHost(target);
  const pagesHost = target.pages.kind == "shared" ? targetSharedPagesHost(target) : null;
  const wrong = guardTarget(target);
  if (wrong) throw new DeployError(wrong);
  const steps = stepsFor(target).map((s) => s.id);
  const start = opts.from ? steps.indexOf(opts.from) : 0;
  if (start < 0) throw new DeployError(`This deploy has no step "${opts.from}".`);
  const needRelease = () => {
    if (!release) throw new DeployError("This step needs the build, which is gone (the server restarted part way): deploy again.");
    return release;
  };
  if (release) carry.version = release.version;
  let existing = false;

  const run: Record<StepId, () => Promise<string | undefined>> = {
    // The account, its workers.dev subdomain (made if it has none and the target names one), and whether the Worker is Erga's.
    async account() {
      const account = await cf.call<{ id: string; name: string }>("GET", acc, "read your account");
      if (target.subdomain) {
        let sub = (await cf.call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read your workers.dev subdomain", undefined, { allow404: true }).catch(() => null))?.subdomain ?? null;
        if (!sub) {
          if (!target.createSubdomain) throw new DeployError("Your account has no workers.dev subdomain yet. Go back, choose one, and deploy again.");
          sub = (await cf.call<{ subdomain: string }>("PUT", `${acc}/workers/subdomain`, `make your workers.dev subdomain (${target.subdomain})`, { subdomain: target.subdomain }))?.subdomain ?? target.subdomain;
        } else if (sub != target.subdomain) throw new DeployError(`Your workers.dev subdomain is ${sub}, not ${target.subdomain}: reload the page and deploy again.`);
      }
      const scripts = (await cf.call<{ id: string; tags?: string[]; named_handlers?: { name?: string }[] }[]>("GET", `${acc}/workers/scripts`, "list your Workers")) ?? [];
      const found = scripts.find((s) => s.id == target.workerName);
      // Ours: tagged by an earlier run (or, failing that, Erga's own Durable Object among its exports).
      const ours = (s: (typeof scripts)[number]) => !!s.tags?.includes(WORKER_TAG) || !!s.named_handlers?.some((h) => h.name == "DocHost");
      if (found && !ours(found)) {
        throw new DeployError(`Your account already has a Worker called ${target.workerName} that isn't Erga. So it isn't overwritten, the deploy stops here: delete or rename that Worker, then deploy again.`);
      }
      existing = !!found;
      return `${account?.name ?? target.accountId}${found ? `; ${target.workerName} is already there and will be replaced${target.keepSecrets ? "" : " (everyone signs in again)"}` : ""}`;
    },

    // The database: the one by this name if it's Erga's, else a new one. With a snapshot, always a new one (the old one, staging's, deleted first).
    async database() {
      const found = await findDatabase(cf, acc, target.databaseName);
      if (target.snapshot) {
        if (found) {
          // Which documents it had, so their Durable Objects are emptied too (the documents step), then gone.
          const old = await d1(cf, acc, found, "SELECT id FROM documents", [], `read which documents ${target.databaseName} had`).catch(() => []);
          carry.oldDocs = [...new Set([...(carry.oldDocs ?? []), ...(old ?? []).map((r) => String(r.id))])];
          await opts.checkpoint?.("account", carry);
          await cf.call("DELETE", `${acc}/d1/database/${found}`, `delete ${target.databaseName}'s old copy`);
        }
        const made = await cf.call<{ uuid: string }>("POST", `${acc}/d1/database`, "make the database", { name: target.databaseName });
        if (!made?.uuid) throw new DeployError("Cloudflare made the database but didn't say its id. Deploy again: the next run will find it.");
        carry.dbId = made.uuid;
        return `"${target.databaseName}" (${carry.dbId}), made afresh${found ? " (the old copy deleted)" : ""}`;
      }
      if (found) {
        // Erga's if it has Erga's first migration; usable if it's empty (made by a run that stopped before its tables).
        const tables = ((await d1(cf, acc, found, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", [], "look inside the database")) ?? []).map((r) => String(r.name));
        const applied = tables.includes("d1_migrations") ? await d1(cf, acc, found, "SELECT name FROM d1_migrations", [], "read the database's migrations") : [];
        const first = release ? Object.keys(release.migrations).sort()[0] : "0001_erga.sql";
        const ours = !!applied?.some((r) => r.name == first) || tables.every((t) => t == "d1_migrations");
        if (!ours) throw new DeployError(`Your account already has a D1 database called "${target.databaseName}" that isn't Erga's. So nothing of yours is lost, the deploy stops here: rename or delete that database, then deploy again.`);
        carry.dbId = found;
        return `using Erga's database from before (${found})`;
      }
      const made = await cf.call<{ uuid: string }>("POST", `${acc}/d1/database`, "make the database", { name: target.databaseName });
      if (!made?.uuid) throw new DeployError("Cloudflare made the database but didn't say its id. Deploy again: the next run will find it.");
      carry.dbId = made.uuid;
      return `"${target.databaseName}" (${carry.dbId})`;
    },

    // Production's database, exported (D1's export: read-only on it) and loaded into the new one (D1's import).
    async data() {
      const snap = target.snapshot!;
      const source = await findDatabase(cf, acc, snap.databaseName);
      if (!source) throw new DeployError(`There's no database called ${snap.databaseName} to copy.`);
      if (source == carry.dbId) throw new DeployError("The snapshot's source and target are the same database: stopped.");
      const sql = await exportD1(cf, acc, source, snap.databaseName, site, sleep);
      await importD1(cf, acc, carry.dbId!, target.databaseName, sql, site, sleep);
      return `${snap.databaseName} (${source}) → ${target.databaseName}: ${sql.length} bytes of SQL`;
    },

    // migrations/, each once, recorded in d1_migrations as the cf CLI does (on a copy, the ones production hasn't had yet).
    async migrations() {
      const rel = needRelease();
      const db = carry.dbId!;
      await d1(cf, acc, db, "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)", [], "set up the database");
      const done = new Set(((await d1(cf, acc, db, "SELECT name FROM d1_migrations", [], "read the database's migrations")) ?? []).map((r) => String(r.name)));
      const pending = Object.keys(rel.migrations).sort().filter((n) => !done.has(n));
      for (const name of pending) {
        // The file and its record in d1_migrations, in one /query call (statements run as one batch, so all or nothing), as wrangler's `d1 migrations apply --remote` sends it.
        const sql = rel.migrations[name].trim();
        await d1(cf, acc, db, `${sql}${sql.endsWith(";") ? "" : ";"}\nINSERT INTO d1_migrations (name) VALUES ('${name.replace(/'/g, "''")}');`, [], `apply the database migration ${name}`);
      }
      return pending.length ? `applied ${pending.join(", ")}` : "already up to date";
    },

    // The static assets: the manifest, then each bucket Cloudflare asks for.
    async assets() {
      const rel = needRelease();
      (carry as Carry & { assetsJwt?: string }).assetsJwt = await uploadAssets(cf, acc, target.workerName, rel.assets);
      return `${Object.keys(rel.assets).length} files`;
    },

    // The Worker: modules, bindings (from the build's config, made the target's own), secrets, its Durable Objects.
    async worker() {
      const rel = needRelease();
      const assetsJwt = (carry as Carry & { assetsJwt?: string }).assetsJwt;
      if (!assetsJwt) throw new DeployError("The editor's files weren't uploaded first: deploy again.");
      const metadata = workerMetadata(rel, target, { dbId: carry.dbId!, assetsJwt, pagesHost, existing });
      const form = new FormData();
      form.set("metadata", JSON.stringify(metadata));
      for (const [name, bytes] of Object.entries(rel.modules)) form.append(name, new File([new Uint8Array(bytes)], name, { type: "application/javascript+module" }));
      await cf.call("PUT", `${acc}/workers/scripts/${target.workerName}`, "upload the Worker", form);
      delete (carry as Carry & { assetsJwt?: string }).assetsJwt;
      return `${target.workerName}, release ${rel.version}`;
    },

    // Its address.
    async address() {
      if (target.app.kind == "workers.dev") {
        await cf.call("POST", `${acc}/workers/scripts/${target.workerName}/subdomain`, "turn on its workers.dev address", { enabled: true, previews_enabled: false });
      } else {
        const zoneId = target.app.zoneId ?? (await zoneIdOf(cf, target.accountId, target.app.zoneName));
        await cf.call("PUT", `${acc}/workers/domains`, `put it on ${target.app.hostname} (a custom domain)`, { hostname: target.app.hostname, service: target.workerName, zone_id: zoneId });
      }
      return `https://${host}`;
    },

    // Documents' pages: a wildcard on their own zone, or the shared workers.dev host (a small Worker handing every request to the app).
    async pages() {
      if (target.pages.kind == "zone") {
        const zoneId = target.pages.zoneId ?? (await zoneIdOf(cf, target.accountId, target.pages.zoneName));
        const zone = `/zones/${zoneId}`, name = target.pages.domain ?? target.pages.zoneName, pattern = `*.${name}/*`;
        const records = (await cf.call<{ id: string }[]>("GET", `${zone}/dns_records?type=AAAA&name=${encodeURIComponent(`*.${name}`)}`, `read ${target.pages.zoneName}'s DNS records`)) ?? [];
        if (!records.length) await cf.call("POST", `${zone}/dns_records`, `add the wildcard DNS record *.${name}`, { type: "AAAA", name: `*.${name}`, content: "100::", proxied: true, comment: "Erga: documents' pages" });
        const routes = (await cf.call<{ pattern: string; script?: string }[]>("GET", `${zone}/workers/routes`, `read ${target.pages.zoneName}'s Worker routes`)) ?? [];
        const route = routes.find((r) => r.pattern == pattern);
        if (route && route.script != target.workerName) throw new DeployError(`${pattern} already sends requests to another Worker (${route.script ?? "none"}). Remove that route, or pick another domain for pages.`);
        if (!route) await cf.call("POST", `${zone}/workers/routes`, `route ${pattern} to the Worker`, { pattern, script: target.workerName });
        return `https://<document>.${name}`;
      }
      const rel = needRelease();
      const proxy = new FormData();
      const name = `${target.workerName}-pages`;
      proxy.set("metadata", JSON.stringify({
        main_module: "pages.js", compatibility_date: rel.worker.compatibilityDate, tags: [WORKER_TAG],
        bindings: [{ type: "service", name: "APP", service: target.workerName }],
      }));
      proxy.append("pages.js", new File([PAGES_PROXY], "pages.js", { type: "application/javascript+module" }));
      await cf.call("PUT", `${acc}/workers/scripts/${name}`, "upload the pages Worker", proxy);
      await cf.call("POST", `${acc}/workers/scripts/${name}/subdomain`, "turn on the pages address", { enabled: true, previews_enabled: false });
      return `https://${pagesHost} (shared by every document)`;
    },

    // Up: a new workers.dev address or certificate can take a minute or two. With checkVersion, until this release is the one answering.
    async live() {
      const until = Date.now() + (opts.waitMs ?? 180_000);
      const want = carry.version;
      let seen = "";
      for (let tries = 0; ; tries++) {
        if (target.checkVersion && want) {
          const r = await site(`https://${host}/api/deploys/version`).catch(() => null);
          const v = r?.ok ? ((await r.json().catch(() => null)) as { version?: string } | null)?.version ?? "" : "";
          if (v == want) break;
          if (v) seen = v;
        } else {
          const r = await site(`https://${host}/style.css`).catch(() => null);
          if (r?.ok) break;
        }
        if (Date.now() > until) throw new DeployError(`The Worker is deployed, but https://${host} hasn't answered${seen ? ` with release ${want} yet (it still says ${seen})` : " yet"} (a new address can take a few minutes). Open it in a little while; if it still doesn't answer, deploy again.`);
        await sleep(Math.min(5000, 1000 + tries * 500));
      }
      return `https://${host}${target.checkVersion && want ? `, release ${want}` : ""}`;
    },

    // Each document's Durable Object: production's storage, read through its snapshot endpoint, written into the new server's.
    async documents() {
      const snap = target.snapshot!;
      const ids = ((await d1(cf, acc, carry.dbId!, "SELECT id FROM documents", [], "list the documents in the copy")) ?? []).map((r) => String(r.id));
      const result = await copyDocuments({ ids, wipe: (carry.oldDocs ?? []).filter((id) => !ids.includes(id)), from: snap.origin, to: `https://${host}`, token: snap.token, fetch: site });
      if (result.unsupported) return `skipped: ${snap.origin} doesn't serve snapshots yet (it needs this version, and SNAPSHOT_TOKEN set); the documents are listed but empty`;
      carry.oldDocs = [];
      return `${result.copied} documents copied${result.missing ? `, ${result.missing} gone from production since the database's copy` : ""}${result.wiped ? `, ${result.wiped} old ones emptied` : ""}`;
    },
  };

  for (const id of steps.slice(start)) {
    report(id, "running");
    const detail = await run[id]();
    const skipped = id == "documents" && detail?.startsWith("skipped");
    report(id, skipped ? "skipped" : "done", detail);
    await opts.checkpoint?.(id, carry);
  }
  return { url: `https://${host}`, pages: targetPagesShown(target), database: carry.dbId ?? "", worker: target.workerName };
}

/**
 * The deploy page's deploy: `release` by `plan` with `cf` (a target in the
 * person's own account, through the same pipeline). `sessionSecret`: the new
 * server's SESSION_SECRET (made by the caller, new for each deploy). Throws a
 * DeployError saying what went wrong.
 */
export async function deploy(cf: Cloudflare, release: Release, plan: DeployPlan, opts: { sessionSecret: string; report: Report; site?: Fetch; sleep?: (ms: number) => Promise<void>; waitMs?: number }): Promise<Deployed> {
  const { sessionSecret, ...rest } = opts;
  return runPipeline(cf, release, targetOfPlan(plan, sessionSecret), rest);
}

/** The shared pages host's Worker: every request to the app, as it came (the app tells pages requests by their host, PAGES_HOST). */
export const PAGES_PROXY = `export default { fetch: (request, env) => env.APP.fetch(request) };\n`;

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
    else if (b.type == "service" && b.name && target.services?.[name]) bindings.push({ type: "service", name, service: target.services[name] });
    else throw new DeployError(`This release has a binding this page doesn't know how to make (${name}, ${b.type}): it needs a newer deploy page.`);
  }
  // Settings and secrets the build doesn't declare (the version, the account, the branch deploys' own secrets), and services.
  for (const [name, value] of Object.entries(text)) if (!named.has(name)) { bindings.push({ type: "plain_text", name, text: value }); named.add(name); }
  for (const [name, value] of Object.entries(secrets)) if (!named.has(name)) { bindings.push({ type: "secret_text", name, text: value }); named.add(name); }
  for (const [name, service] of Object.entries(target.services ?? {})) if (!named.has(name)) { bindings.push({ type: "service", name, service }); named.add(name); }
  // Where documents' pages run (front.ts, pagesOrigin): a domain of their own, or the shared host.
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
    // Secrets set once on the Worker (deploy/setup.ts) stay from version to version, as with `cf deploy`.
    ...(target.keepSecrets ? { keep_bindings: ["secret_text", "secret_key"] } : {}),
    assets: {
      jwt: o.assetsJwt,
      config: { html_handling: w.assets?.htmlHandling ?? "auto-trailing-slash", not_found_handling: w.assets?.notFoundHandling ?? "none", run_worker_first: w.assets?.runWorkerFirst ?? false },
    },
    observability: { enabled: !!w.observability?.enabled, logs: { enabled: !!w.observability?.logs?.enabled, invocation_logs: !!w.observability?.logs?.invocationLogs } },
    ...(Object.keys(exports).length ? { exports } : {}),
    tags: [WORKER_TAG],
  };
}

/** The release a Worker runs, by its ERGA_VERSION setting (the pipeline sets it), or null. */
export async function workerVersion(cf: Cloudflare, accountId: string, worker: string): Promise<string | null> {
  const settings = await cf.call<{ bindings?: { name: string; type: string; text?: string }[] }>("GET", `/accounts/${accountId}/workers/scripts/${worker}/settings`, `read ${worker}'s settings`, undefined, { allow404: true });
  return settings?.bindings?.find((b) => b.name == "ERGA_VERSION" && b.type == "plain_text")?.text ?? null;
}

/** A D1 database's id by name, or null. */
async function findDatabase(cf: Cloudflare, acc: string, name: string): Promise<string | null> {
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
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b64(bytes) + ext)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

const TYPES: Record<string, string> = { html: "text/html", js: "application/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", woff2: "font/woff2", woff: "font/woff", png: "image/png", ico: "image/x-icon", txt: "text/plain", md: "text/markdown" };
const typeOf = (path: string) => TYPES[/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";

/**
 * Uploads the assets Cloudflare doesn't have yet; the completion token for
 * the Worker's upload. As workers-sdk's deploy does it: the manifest opens a
 * session (its JWT, and buckets of hashes still needed), then each bucket goes
 * up as base64 multipart, or, when the JWT says so
 * (wrangler_single_asset_uploads), each file on its own as its raw bytes.
 * Each upload is tried up to four times.
 */
async function uploadAssets(cf: Cloudflare, acc: string, worker: string, assets: Record<string, Uint8Array>): Promise<string> {
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, string>();
  for (const [path, bytes] of Object.entries(assets)) {
    const hash = await assetHash(path, bytes);
    manifest[path] = { hash, size: bytes.byteLength };
    byHash.set(hash, path);
  }
  const session = await cf.call<{ jwt: string; buckets?: string[][] }>("POST", `${acc}/workers/scripts/${worker}/assets-upload-session`, "start uploading the editor's files", { manifest });
  if (!session?.jwt) throw new DeployError("Cloudflare didn't start the upload of the editor's files (no upload token came back). Deploy again.");
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
          for (const hash of bucket) { const path = pathOf(hash); form.append(hash, new File([b64(assets[path])], hash, { type: typeOf(path) })); }
          done = await cf.call<{ jwt?: string }>("POST", `${acc}/workers/assets/upload?base64=true`, "upload the editor's files", form, { bearer: session.jwt });
        }
        if (done?.jwt) jwt = done.jwt;
        break;
      } catch (e) {
        if (attempt >= 4 || (e instanceof DeployError && e.status >= 400 && e.status < 500 && e.status != 429)) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  if (!jwt) throw new DeployError("Cloudflare took the editor's files but didn't say the upload was complete (no completion token). Deploy again: files already up aren't sent twice.");
  return jwt;
}

/** A JWT's claims, unchecked (only to read how Cloudflare wants the files sent). */
function jwtClaims(jwt: string): Record<string, unknown> {
  try { return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}

/** One statement (or a few, separated by semicolons) on a D1 database, through the API: the first statement's rows. */
async function d1(cf: Cloudflare, acc: string, db: string, sql: string, params: (string | number | null)[], what: string): Promise<Record<string, unknown>[] | null> {
  const answer = await cf.call<{ results?: Record<string, unknown>[]; success?: boolean }[]>("POST", `${acc}/d1/database/${db}/query`, what, { sql, ...(params.length ? { params } : {}) });
  return answer?.[0]?.results ?? [];
}

export const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// ------------------------------------------------------------------ authorizing

/**
 * The permissions the deploy needs, as the "Create API token" template link
 * takes them (developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template).
 * `registrar` adds buying a domain.
 */
export function tokenPermissions(registrar: boolean) {
  return [
    { key: "account_settings", type: "read", why: "read your account and its workers.dev subdomain" },
    { key: "workers_scripts", type: "edit", why: "upload the Worker and its files" },
    { key: "d1", type: "edit", why: "make the database and set up its tables" },
    { key: "workers_routes", type: "edit", why: "route a domain of yours to the Worker" },
    { key: "zone", type: "read", why: "list your domains" },
    { key: "dns", type: "edit", why: "add the DNS record for documents' pages" },
    ...(registrar ? [{ key: "registrar_domains", type: "edit", why: "only with “Include buying a domain”: search for and register a new domain, after you confirm the price" }] : []),
  ];
}

/** The dashboard's "Create API token" page, filled in with exactly what the deploy needs. */
export function tokenTemplateUrl(registrar: boolean): string {
  const keys = tokenPermissions(registrar).map(({ key, type }) => ({ key, type }));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&accountId=*&zoneId=all&name=${encodeURIComponent("Erga deploy")}`;
}

/** Cloudflare's OAuth endpoints (developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare). */
export const OAUTH = {
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
};

/**
 * The scopes Erga's OAuth client asks for: Cloudflare's OAuth scope ids (GET
 * /oauth/scopes; the cf CLI asks for the same names), one for each
 * permission the token link gives. The client must have been made with these
 * (Registrar's optional); CLOUDFLARE_OAUTH_SCOPES overrides them.
 */
export const DEFAULT_OAUTH_SCOPES = "account-settings.read workers-scripts.write d1.write workers-routes.write zone.read dns.write registrar-domains.admin";

// ------------------------------------------------------------------ domains

export interface DomainOffer {
  name: string;
  registrable: boolean;
  /** Why it can't be registered (Cloudflare's reason, in words). */
  reason?: string;
  currency?: string;
  /** What registering costs now, and each renewal. */
  price?: string;
  renewal?: string;
  premium?: boolean;
}

const REASONS: Record<string, string> = {
  domain_unavailable: "already taken",
  extension_not_supported_via_api: "this ending can't be registered through the API yet: use the Registrar page",
  extension_not_supported: "Cloudflare doesn't sell this ending",
  extension_disallows_registration: "this ending doesn't allow registration",
  domain_premium: "a premium domain: register it on Cloudflare's Registrar page",
};

/** Cloudflare Registrar's search: candidate names, each checked for availability and price (search alone isn't the source of truth). */
export async function searchDomains(cf: Cloudflare, accountId: string, q: string): Promise<DomainOffer[]> {
  const query = q.trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,63}$/.test(query)) throw new DeployError("Search with letters, digits, dashes and dots only.");
  const found = (await cf.call<{ domains?: { name: string }[] } | { name: string }[]>("GET", `/accounts/${accountId}/registrar/domain-search?q=${encodeURIComponent(query)}&limit=8`, "search for domains")) ?? [];
  const names = (Array.isArray(found) ? found : found.domains ?? []).map((d) => d.name).slice(0, 8);
  if (query.includes(".") && !names.includes(query)) names.unshift(query);
  return names.length ? checkDomains(cf, accountId, names.slice(0, 20)) : [];
}

/** Real-time availability and pricing (Registrar's check), for up to 20 names. */
export async function checkDomains(cf: Cloudflare, accountId: string, names: string[]): Promise<DomainOffer[]> {
  const answer = (await cf.call<{ domains?: RawCheck[] } | RawCheck[]>("POST", `/accounts/${accountId}/registrar/domain-check`, "check whether a domain is free", { domains: names })) ?? [];
  return (Array.isArray(answer) ? answer : answer.domains ?? []).map((d) => ({
    name: d.name, registrable: !!d.registrable, ...(d.reason ? { reason: REASONS[d.reason] ?? d.reason.replace(/_/g, " ") } : {}),
    ...(d.pricing ? { currency: d.pricing.currency, price: d.pricing.registration_cost, renewal: d.pricing.renewal_cost } : {}),
    ...(d.tier && d.tier != "standard" ? { premium: true } : {}),
  }));
}
interface RawCheck { name: string; registrable?: boolean; reason?: string; tier?: string; pricing?: { currency: string; registration_cost: string; renewal_cost: string } }

/**
 * Registers `name`, if it still costs exactly what the person confirmed
 * (`confirmed`: the price and currency they saw). Checks again first, as
 * Registrar asks, and refuses premium names (they need a fee acknowledgement
 * the API doesn't take yet). Answers the registration's state.
 */
export async function registerDomain(cf: Cloudflare, accountId: string, name: string, confirmed: { price: string; currency: string }): Promise<{ state: string; completed: boolean; error?: string }> {
  const [offer] = await checkDomains(cf, accountId, [name]);
  if (!offer?.registrable) throw new DeployError(`${name} can't be registered now${offer?.reason ? `: ${offer.reason}` : ""}.`);
  if (offer.premium) throw new DeployError(`${name} is a premium domain: register it on Cloudflare's Registrar page instead.`);
  if (offer.price != confirmed.price || offer.currency != confirmed.currency) {
    throw new DeployError(`${name} now costs ${offer.price} ${offer.currency}, not the ${confirmed.price} ${confirmed.currency} you confirmed. Nothing was bought: check the new price and confirm again.`);
  }
  // One year, at the price shown (registration_cost is the first year's); auto-renew and WHOIS privacy keep Registrar's defaults (off, redaction).
  const r = await cf.call<Workflow>("POST", `/accounts/${accountId}/registrar/registrations`, `register ${name}`, { domain_name: name, years: 1 });
  return workflow(r);
}
interface Workflow { state: string; completed: boolean; error?: { code: string; message: string } }
const workflow = (r: Workflow | null) => ({ state: r?.state ?? "in_progress", completed: !!r?.completed, ...(r?.error ? { error: `${r.error.message} [${r.error.code}]` } : {}) });

/** Where a registration has got to. */
export async function registrationStatus(cf: Cloudflare, accountId: string, name: string): Promise<{ state: string; completed: boolean; error?: string }> {
  return workflow(await cf.call<Workflow>("GET", `/accounts/${accountId}/registrar/registrations/${encodeURIComponent(name)}/registration-status`, `check on ${name}'s registration`));
}

/** MD5, as hex: the checksum D1's import takes (etag). */
const md5hex = (text: string) => createHash("md5").update(text).digest("hex");
