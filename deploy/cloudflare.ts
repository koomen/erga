// Deploying Erga to someone's own Cloudflare account, through the Cloudflare
// API, from inside an Erga server (worker/deployer.ts runs it; /deploy is
// the page). No CLI and no container: each step below is a few plain API
// calls, so the page can show them one at a time, and the tests run every
// one against a mock Cloudflare (deploy/mock.ts).
//
// What it deploys is a release (deploy/release.ts): the Worker exactly as
// `cf build` builds it for erga.dev (its modules, its static assets, its
// bindings and Durable Objects from cloudflare.config.ts) and the migrations. "The same settings as erga.dev" are that build's
// config; only what's the new server's own changes: its database, its
// admins (whoever deploys it), its GitHub sign-in, its secrets and its
// addresses.
//
// The steps (STEPS): check the account, find or make the D1 database, apply
// migrations/ to it (recorded in d1_migrations, as `cf d1 migrations apply`
// does), upload the static assets (direct upload), upload the Worker with
// its bindings, secrets and Durable Object migration, give it its address
// (workers.dev, or a custom domain on a zone in the account), give documents'
// pages theirs, and wait for it to answer. The new server makes its own
// front page from the landing project built into it, the first time someone
// opens it (front.ts), owned by its first admin: the person deploying.


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

/** The deploy's steps, in order, as the page lists them. */
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
export type StepId = (typeof STEPS)[number]["id"];

export type Report = (step: StepId, status: "running" | "done" | "skipped", detail?: string) => void;

/** What the deploy made: where the server is, and where its pages run. */
export interface Deployed { url: string; pages: string; database: string; worker: string }

const DB_NAME = "erga";
/** The Durable Object migration tag this deploy writes (and expects on a Worker it deployed before). */
/** The tag the deploy puts on the Workers it makes, so a second run knows them as its own. */
export const WORKER_TAG = "erga-deploy";

/**
 * Deploys `release` by `plan` with `cf`, reporting each step as it starts and
 * ends. `site`: how to reach the new server once it's up (fetch, or a mock's).
 * `sessionSecret`: the new server's SESSION_SECRET (made by the caller, new
 * for each deploy). Throws a DeployError saying what went wrong.
 */
export async function deploy(cf: Cloudflare, release: Release, plan: DeployPlan, opts: { sessionSecret: string; report: Report; site?: Fetch; sleep?: (ms: number) => Promise<void>; waitMs?: number }): Promise<Deployed> {
  const { report } = opts;
  const site = opts.site ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const acc = `/accounts/${plan.accountId}`;
  const host = appHost(plan);
  const pagesHost = plan.pages.kind == "shared" ? sharedPagesHost(plan) : null;

  // The account, and its workers.dev subdomain (made if it has none and the plan names one).
  report("account", "running");
  const account = await cf.call<{ id: string; name: string }>("GET", acc, "read your account");
  let sub = (await cf.call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read your workers.dev subdomain", undefined, { allow404: true }).catch(() => null))?.subdomain ?? null;
  if (!sub) {
    if (!plan.createSubdomain) throw new DeployError("Your account has no workers.dev subdomain yet. Go back, choose one, and deploy again.");
    sub = (await cf.call<{ subdomain: string }>("PUT", `${acc}/workers/subdomain`, `make your workers.dev subdomain (${plan.subdomain})`, { subdomain: plan.subdomain }))?.subdomain ?? plan.subdomain;
  } else if (sub != plan.subdomain) throw new DeployError(`Your workers.dev subdomain is ${sub}, not ${plan.subdomain}: reload the page and deploy again.`);
  const scripts = (await cf.call<{ id: string; tags?: string[]; named_handlers?: { name?: string }[] }[]>("GET", `${acc}/workers/scripts`, "list your Workers")) ?? [];
  const existing = scripts.find((s) => s.id == plan.workerName);
  // Ours: tagged by an earlier run (or, failing that, Erga's own Durable Object among its exports).
  const ours = (s: (typeof scripts)[number]) => !!s.tags?.includes(WORKER_TAG) || !!s.named_handlers?.some((h) => h.name == "DocHost");
  if (existing && !ours(existing)) {
    throw new DeployError(`Your account already has a Worker called ${plan.workerName} that isn't Erga. So it isn't overwritten, the deploy stops here: delete or rename that Worker, then deploy again.`);
  }
  report("account", "done", `${account?.name ?? plan.accountId}${existing ? `; ${plan.workerName} is already there and will be replaced (everyone signs in again)` : ""}`);

  // The database: the one called "erga" if this page made it before, else a new one.
  report("database", "running");
  const found = ((await cf.call<{ uuid: string; name: string }[]>("GET", `${acc}/d1/database?name=${DB_NAME}`, "list your D1 databases")) ?? []).find((d) => d.name == DB_NAME);
  let dbId: string;
  if (found) {
    dbId = found.uuid;
    // Erga's if it has Erga's first migration; usable if it's empty (made by a run that stopped before its tables).
    const tables = ((await d1(cf, acc, dbId, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", [], "look inside the database")) ?? []).map((r) => String(r.name));
    const applied = tables.includes("d1_migrations") ? await d1(cf, acc, dbId, "SELECT name FROM d1_migrations", [], "read the database's migrations") : [];
    const ours = !!applied?.some((r) => r.name == Object.keys(release.migrations).sort()[0]) || tables.every((t) => t == "d1_migrations");
    if (!ours) throw new DeployError(`Your account already has a D1 database called "${DB_NAME}" that isn't Erga's. So nothing of yours is lost, the deploy stops here: rename or delete that database, then deploy again.`);
    report("database", "done", `using Erga's database from before (${dbId})`);
  } else {
    const made = await cf.call<{ uuid: string }>("POST", `${acc}/d1/database`, "make the database", { name: DB_NAME });
    if (!made?.uuid) throw new DeployError("Cloudflare made the database but didn't say its id. Deploy again: the next run will find it.");
    dbId = made.uuid;
    report("database", "done", `"${DB_NAME}" (${dbId})`);
  }

  // migrations/, each once, recorded in d1_migrations as the cf CLI does.
  report("migrations", "running");
  await d1(cf, acc, dbId, "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)", [], "set up the database");
  const done = new Set(((await d1(cf, acc, dbId, "SELECT name FROM d1_migrations", [], "read the database's migrations")) ?? []).map((r) => String(r.name)));
  const pending = Object.keys(release.migrations).sort().filter((n) => !done.has(n));
  for (const name of pending) {
    // The file and its record in d1_migrations, in one /query call (statements run as one batch, so all or nothing), as wrangler's `d1 migrations apply --remote` sends it.
    const sql = release.migrations[name].trim();
    await d1(cf, acc, dbId, `${sql}${sql.endsWith(";") ? "" : ";"}\nINSERT INTO d1_migrations (name) VALUES ('${name.replace(/'/g, "''")}');`, [], `apply the database migration ${name}`);
  }
  report("migrations", "done", pending.length ? `applied ${pending.join(", ")}` : "already up to date");

  // The static assets: the manifest, then each bucket Cloudflare asks for.
  report("assets", "running");
  const assetsJwt = await uploadAssets(cf, acc, plan.workerName, release.assets);
  report("assets", "done", `${Object.keys(release.assets).length} files`);

  // The Worker: modules, bindings (from the build's config), secrets, its Durable Objects.
  report("worker", "running");
  const metadata = workerMetadata(release, plan, { dbId, assetsJwt, sessionSecret: opts.sessionSecret, pagesHost });
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  for (const [name, bytes] of Object.entries(release.modules)) form.append(name, new File([new Uint8Array(bytes)], name, { type: "application/javascript+module" }));
  await cf.call("PUT", `${acc}/workers/scripts/${plan.workerName}`, "upload the Worker", form);
  report("worker", "done", `${plan.workerName}, release ${release.version}`);

  // Its address.
  report("address", "running");
  if (plan.app.kind == "workers.dev") {
    await cf.call("POST", `${acc}/workers/scripts/${plan.workerName}/subdomain`, "turn on its workers.dev address", { enabled: true, previews_enabled: false });
  } else {
    await cf.call("PUT", `${acc}/workers/domains`, `put it on ${plan.app.hostname} (a custom domain)`, { hostname: plan.app.hostname, service: plan.workerName, zone_id: plan.app.zoneId });
  }
  report("address", "done", `https://${host}`);

  // Documents' pages: a wildcard on their own zone, or the shared workers.dev host (a small Worker handing every request to the app).
  report("pages", "running");
  if (plan.pages.kind == "zone") {
    const zone = `/zones/${plan.pages.zoneId}`, name = plan.pages.zoneName, pattern = `*.${name}/*`;
    const records = (await cf.call<{ id: string }[]>("GET", `${zone}/dns_records?type=AAAA&name=${encodeURIComponent(`*.${name}`)}`, `read ${name}'s DNS records`)) ?? [];
    if (!records.length) await cf.call("POST", `${zone}/dns_records`, `add the wildcard DNS record on ${name}`, { type: "AAAA", name: `*.${name}`, content: "100::", proxied: true, comment: "Erga: documents' pages" });
    const routes = (await cf.call<{ pattern: string; script?: string }[]>("GET", `${zone}/workers/routes`, `read ${name}'s Worker routes`)) ?? [];
    const route = routes.find((r) => r.pattern == pattern);
    if (route && route.script != plan.workerName) throw new DeployError(`${pattern} already sends requests to another Worker (${route.script ?? "none"}). Remove that route, or pick another domain for pages.`);
    if (!route) await cf.call("POST", `${zone}/workers/routes`, `route ${pattern} to the Worker`, { pattern, script: plan.workerName });
    report("pages", "done", `https://<document>.${name}`);
  } else {
    const proxy = new FormData();
    const name = `${plan.workerName}-pages`;
    proxy.set("metadata", JSON.stringify({
      main_module: "pages.js", compatibility_date: release.worker.compatibilityDate, tags: [WORKER_TAG],
      bindings: [{ type: "service", name: "APP", service: plan.workerName }],
    }));
    proxy.append("pages.js", new File([PAGES_PROXY], "pages.js", { type: "application/javascript+module" }));
    await cf.call("PUT", `${acc}/workers/scripts/${name}`, "upload the pages Worker", proxy);
    await cf.call("POST", `${acc}/workers/scripts/${name}/subdomain`, "turn on the pages address", { enabled: true, previews_enabled: false });
    report("pages", "done", `https://${pagesHost} (shared by every document)`);
  }

  // Up: a new workers.dev address or certificate can take a minute or two.
  report("live", "running");
  const until = Date.now() + (opts.waitMs ?? 180_000);
  for (let tries = 0; ; tries++) {
    const r = await site(`https://${host}/style.css`).catch(() => null);
    if (r?.ok) break;
    if (Date.now() > until) throw new DeployError(`The Worker is deployed, but https://${host} hasn't answered yet (a new address can take a few minutes). Open it in a little while; if it still doesn't answer, deploy again.`);
    await sleep(Math.min(5000, 1000 + tries * 500));
  }
  report("live", "done", `https://${host}`);

  return { url: `https://${host}`, pages: pagesShown(plan), database: dbId, worker: plan.workerName };
}

/** The shared pages host's Worker: every request to the app, as it came (the app tells pages requests by their host, PAGES_HOST). */
export const PAGES_PROXY = `export default { fetch: (request, env) => env.APP.fetch(request) };\n`;

/**
 * The Worker's upload metadata: the build's bindings (cloudflare.config.ts
 * as `cf build` wrote it), each made the new server's own: its database, its
 * admins, its GitHub app, its secrets and where its pages run.
 */
export function workerMetadata(release: Release, plan: DeployPlan, o: { dbId: string; assetsJwt: string; sessionSecret: string; pagesHost: string | null }) {
  const w = release.worker;
  const text: Record<string, string> = {
    ADMINS: plan.admin.toLowerCase(),
    GITHUB_CLIENT_ID: plan.githubClientId.trim(),
    SERVER_CONFIG: "{}",
    // erga.dev's own deploy page needs erga.dev's OAuth client; the new server has none (the token link still works).
    CLOUDFLARE_OAUTH_CLIENT_ID: "",
  };
  const secrets: Record<string, string> = { SESSION_SECRET: o.sessionSecret, GITHUB_CLIENT_SECRET: plan.githubClientSecret.trim(), ...(plan.anthropicKey?.trim() ? { ANTHROPIC_API_KEY: plan.anthropicKey.trim() } : {}) };
  const bindings: Record<string, unknown>[] = [];
  for (const [name, b] of Object.entries(w.env)) {
    if (b.type == "durable-object") bindings.push({ type: "durable_object_namespace", name, class_name: b.exportName });
    else if (b.type == "d1") bindings.push({ type: "d1", name, database_id: o.dbId, id: o.dbId });
    else if (b.type == "assets") bindings.push({ type: "assets", name });
    else if (b.type == "text") bindings.push({ type: "plain_text", name, text: text[name] ?? b.value ?? "" });
    else if (b.type == "secret") { if (secrets[name] != null) bindings.push({ type: "secret_text", name, text: secrets[name] }); }
    else throw new DeployError(`This release has a binding this page doesn't know how to make (${name}, ${b.type}): it needs a newer deploy page.`);
  }
  // Where documents' pages run (front.ts, pagesOrigin): a zone of their own, or the shared host.
  if (plan.pages.kind == "zone") bindings.push({ type: "plain_text", name: "PAGES_DOMAIN", text: plan.pages.zoneName });
  else bindings.push({ type: "plain_text", name: "PAGES_HOST", text: o.pagesHost });
  // Durable Objects as declarative exports, as `cf deploy` sends them: the platform makes each namespace on the first
  // deploy and matches it after, with no migration tags, so a deploy run again (or retried) is the same deploy.
  // (A "deleted" tombstone is erga.dev's own history: a new account has nothing to delete.)
  const exports = Object.fromEntries(Object.entries(w.exports ?? {}).filter(([, e]) => e.type == "durable-object" && e.state != "deleted").map(([n, e]) => [n, { type: "durable-object", storage: e.storage ?? "sqlite" }]));
  return {
    main_module: release.mainModule,
    compatibility_date: w.compatibilityDate,
    compatibility_flags: w.compatibilityFlags ?? [],
    bindings,
    assets: {
      jwt: o.assetsJwt,
      config: { html_handling: w.assets?.htmlHandling ?? "auto-trailing-slash", not_found_handling: w.assets?.notFoundHandling ?? "none", run_worker_first: w.assets?.runWorkerFirst ?? false },
    },
    observability: { enabled: !!w.observability?.enabled, logs: { enabled: !!w.observability?.logs?.enabled, invocation_logs: !!w.observability?.logs?.invocationLogs } },
    ...(Object.keys(exports).length ? { exports } : {}),
    tags: [WORKER_TAG],
  };
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
    ...(registrar ? [{ key: "registrar_domains", type: "edit", why: "search for and register a new domain (only when you confirm the price)" }] : []),
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
