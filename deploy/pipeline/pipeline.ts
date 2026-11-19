// The deploy pipeline: the one way any Erga server is deployed, through the
// Cloudflare API, with no CLI and no container. Each step below is a few
// plain API calls, so a page can show them one at a time, and the tests run
// every one against a mock Cloudflare.
//
// Its input is a target (Target: an account, a Worker, a database, its
// addresses, settings and secrets) and a
// release (deploy/release.ts: the Worker exactly as `cf build` builds it from
// cloudflare.config.ts, its static assets and the migrations). Its output is
// a live server, each step reported as it goes. Its callers:
//
//   - a deploy from a machine: a registered instance (`bun erga deploy` and `bun erga setup`, deploy/cli/deploy.ts).
//
// Every instance takes the same steps (STEPS): check the account, find or make the D1 database, apply
// server/migrations/ to it (recorded in d1_migrations, as `cf d1 migrations apply`
// does), upload the static assets (direct upload), upload the Worker with its
// bindings, secrets and Durable Objects, give it its address (workers.dev,
// or a custom domain) and its Cron Trigger, give documents' pages theirs, and wait for its health row. No step asks
// the deployed server: the server's scheduled run (each minute: server/health.ts, tick) writes its health into its
// database, where the live step reads it through D1's API, and makes the default homepage when the server has none.

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Cloudflare, DeployError, Unhealthy } from "./cloudflare-api";
import type { Release } from "./release-format";
import { bindingsProblem } from "./bindings";
import {
  PAGES_PROXY,
  WORKER_TAG,
  certificateOf,
  d1,
  ensureBuckets,
  findDatabase,
  listScripts,
  healthRow,
  readHealth,
  restorePoint,
  servedAssets,
  setSchedule,
  settledHealth,
  uploadAssets,
  workerMetadata,
  zoneIdOf,
} from "./account";

/** The steps of a deploy, in order. */
export const STEPS = [
  { id: "account", title: "Check your Cloudflare account" },
  { id: "database", title: "Make the database (D1)" },
  { id: "migrations", title: "Set up the database's tables" },
  { id: "assets", title: "Upload the editor's files" },
  { id: "worker", title: "Upload the Worker, with its settings and secrets" },
  { id: "address", title: "Give it its address" },
  { id: "pages", title: "Give documents' pages their own address" },
  { id: "live", title: "Wait for its health" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export type Report = (step: StepId, status: "running" | "done", detail?: string) => void;

/** What the deploy made: where the server is, and where its pages run. */
export interface Deployed { url: string; pages: string; database: string; worker: string }

// ------------------------------------------------------------------ the pipeline

/**
 * Where a deploy goes: everything the pipeline needs to know about it, in
 * any account. `bun erga deploy` and `bun erga setup` make every instance's from its entry in .erga/config.json
 * (deploy/cli/deploy.ts, entryTarget); setup makes a new instance's entry from its answers (deploy/own/plan.ts, setupEntry).
 */
export interface Target {
  /** What to call it in the log: its host. */
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
  /**
   * A gate's own Worker has this server's hosts (gate/mounts/worker.ts), and reaches it by a service binding. So the
   * server gets no address of its own: no custom domain, no route, no DNS record, and its workers.dev address is off.
   * `app` and `pages` still say the hosts, for its settings (PAGES_DOMAIN).
   */
  gate?: boolean;
  /**
   * The custom domains for publishing (server/sites/domains.ts), each a hostname on one of the account's zones: the same
   * Worker serves the document published to each there, and nothing else.
   */
  domains?: readonly string[];
  /** Text bindings over the build's (cloudflare.config.ts as `cf build` wrote it). */
  vars: Record<string, string>;
  /**
   * Secrets set with this upload (`bun erga setup`'s first deploy gives them). The Worker's other secrets stay from its
   * last version, as `cf deploy` keeps them: no later deploy sends one.
   */
  secrets: Record<string, string>;
}

/** What runs on from one step to the next: the database, the version, and whether the Worker was there. */
export interface Carry {
  dbId?: string;
  version?: string;
  existing?: boolean;
  /** What the target ran before this deploy changed anything (the migrations step records it): a rollback goes back to it. */
  restore?: RestorePoint;
  /** The server wrote a health row in the minutes before the upload: its Cron Trigger runs (the live step's wait). */
  ticking?: boolean;
}

/**
 * Where a target was before a deploy: the Worker version that served (a
 * deployment of it again is a rollback, in seconds, with no build), the release it
 * ran, and the database's D1 Time Travel bookmark from before the deploy's
 * migrations (a restore to it loses everything written since: for a person
 * to decide, never automatic). Null where there was none to record (a new
 * Worker, a token that may not read it).
 */
export interface RestorePoint { versionId: string | null; version: string | null; bookmark: string | null; at: number }

/** The database a Worker's DB binding names now, or null (no Worker, no binding). */
export async function boundDatabase(cf: Cloudflare, acc: string, worker: string): Promise<string | null> {
  const settings = await cf.call<{ bindings?: { name: string; type: string; id?: string; database_id?: string }[] }>("GET", `${acc}/workers/scripts/${worker}/settings`, `read ${worker}'s settings`, undefined, { allow404: true });
  const b = settings?.bindings?.find((x) => x.type == "d1" && x.name == "DB");
  return b?.database_id ?? b?.id ?? null;
}

/**
 * The name of the database that a Worker is bound to now, or null (no Worker, no binding, or a database that the
 * account no longer has). A Worker that runs keeps its database: a deploy takes its entry's database from here.
 */
export async function boundDatabaseName(cf: Cloudflare, acc: string, worker: string): Promise<string | null> {
  const bound = await boundDatabase(cf, acc, worker);
  if (!bound) return null;
  const all = (await cf.call<{ uuid: string; name: string }[]>("GET", `${acc}/d1/database?per_page=1000`, "list your D1 databases")) ?? [];
  return all.find((d) => d.uuid == bound)?.name ?? null;
}

export const targetHost = (t: Pick<Target, "app" | "workerName" | "subdomain">) => (t.app.kind == "domain" ? t.app.hostname : `${t.workerName}.${t.subdomain}.workers.dev`);
export const targetSharedPagesHost = (t: Pick<Target, "workerName" | "subdomain">) => `${t.workerName}-pages.${t.subdomain}.workers.dev`;
export const targetPagesShown = (t: Pick<Target, "pages" | "workerName" | "subdomain">) =>
  t.pages.kind == "zone" ? `*.${t.pages.domain ?? t.pages.zoneName}` : targetSharedPagesHost(t);

/** Why a target mustn't be deployed, or null: a custom domain that is the app's own address, or under its documents' pages. */
export function guardTarget(t: Target): string | null {
  const host = t.app.kind == "domain" ? t.app.hostname.toLowerCase() : null;
  const pages = t.pages.kind == "zone" ? (t.pages.domain ?? t.pages.zoneName).toLowerCase() : null;
  for (const domain of (t.domains ?? []).map((d) => d.toLowerCase()))
    if (domain == host || domain == pages || (pages && domain.endsWith(`.${pages}`)))
      return `The custom domain ${domain} is the app's address or under its documents' pages: give it a domain of its own.`;
  return null;
}

/** How a caller waits: by default, the real time. */
type Sleep = (ms: number) => Promise<void>;

/**
 * The Clock that tells the real time and sleeps with `sleep`. The pipeline's waits (polls, retries, a deploy's wait for
 * its new version) are Effect Schedules, and they wait on Effect's Clock. A test, and the mock Cloudflare, give a sleep
 * of their own so the waits go by at once.
 */
function clockOf(sleep: Sleep): Clock.Clock {
  const real = Clock.Clock.defaultValue();
  return {
    currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe(),
    currentTimeMillis: real.currentTimeMillis,
    currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe(),
    currentTimeNanos: real.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: real.monotonicTimeNanos,
    sleep: (d) => Effect.promise(() => sleep(Duration.toMillis(d))),
  };
}

/** Runs `effect` as a promise; with `sleep`, on the Clock that sleeps with it. */
export const runWith = <A, E>(sleep: Sleep | undefined, effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(sleep ? Effect.provideService(effect, Clock.Clock, clockOf(sleep)) : effect);

/**
 * The deploy pipeline: puts `release` on `target`, step by step, reporting
 * each as it starts and ends. The one pipeline for every deploy, each from a machine
 * (`bun erga deploy`, `bun erga setup`).
 * Every step is safe to run again. `carry` gets what each step leaves (the restore point: a rollback goes back to it).
 */
export async function runPipeline(
  cf: Cloudflare,
  release: Release,
  target: Target,
  opts: {
    report: Report;
    sleep?: Sleep;
    waitMs?: number;
    carry?: Carry;
  }
): Promise<Deployed> {
  const { report } = opts;
  const carry: Carry = opts.carry ?? {};
  const acc = `/accounts/${target.accountId}`;
  const host = targetHost(target);
  const pagesHost = target.pages.kind == "shared" ? targetSharedPagesHost(target) : null;
  const wrong = guardTarget(target);
  if (wrong) throw new DeployError({ message: wrong });
  // A binding this pipeline can't make stops the deploy here, before any step changes the target.
  const unknown = bindingsProblem(release);
  if (unknown) throw new DeployError({ message: unknown });
  // Behind a gate's Worker, the hosts are the gate's: neither step that gives an address runs.
  const steps = STEPS.map((s) => s.id).filter((id) => !(target.gate && (id == "address" || id == "pages")));
  carry.version = release.version;

  /** The Worker's upload: its modules, and its metadata. */
  const uploadWorker = async (assetsJwt: string) => {
    // Whether the Worker was there: the account step's answer, kept in the carry.
    await ensureBuckets(cf, acc, release, target);
    const metadata = workerMetadata(release, target, { dbId: carry.dbId!, assetsJwt, pagesHost });
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    for (const [name, bytes] of Object.entries(release.modules))
      form.append(name, new File([new Uint8Array(bytes)], name, { type: "application/javascript+module" }));
    await cf.call("PUT", `${acc}/workers/scripts/${target.workerName}`, "upload the Worker", form);
  };

  const run: Record<StepId, () => Promise<string | undefined>> = {
    // The account, its workers.dev subdomain (made if it has none and the target names one), and whether the Worker is Erga's.
    async account() {
      // A narrow credential (a token without Account Settings: Read) may not read the account itself: its id is enough.
      const account = await cf.call<{ id: string; name: string }>("GET", acc, "read your account").catch((e) => {
        if (e instanceof DeployError && e.status == 403) return null;
        throw e;
      });
      if (target.subdomain) {
        let sub = (await cf.call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read your workers.dev subdomain", undefined, { allow404: true }).catch(() => null))?.subdomain ?? null;
        if (!sub) {
          if (!target.createSubdomain)
            throw new DeployError({ message: "Your account has no workers.dev subdomain yet. Go back, choose one, and deploy again." });
          sub =
            (
              await cf.call<{ subdomain: string }>(
                "PUT",
                `${acc}/workers/subdomain`,
                `make your workers.dev subdomain (${target.subdomain})`,
                { subdomain: target.subdomain }
              )
            )?.subdomain ?? target.subdomain;
        } else if (sub != target.subdomain)
          throw new DeployError({
            message: `Your workers.dev subdomain is ${sub}, not ${target.subdomain}: reload the page and deploy again.`,
          });
      }
      const scripts = await listScripts(cf, acc, target);
      const found = scripts.find((s) => s.id == target.workerName);
      // Ours: tagged by an earlier run (or, failing that, Erga's own Durable Object among its exports).
      const ours = (s: (typeof scripts)[number]) => !!s.tags?.includes(WORKER_TAG) || !!s.named_handlers?.some((h) => h.name == "DocumentObject");
      if (found && !ours(found)) {
        throw new DeployError({
          message: `Your account already has a Worker called ${target.workerName} that isn't Erga. So it isn't overwritten, the deploy stops here: delete or rename that Worker, then deploy again.`,
        });
      }
      carry.existing = !!found;
      return `${account?.name ?? target.accountId}${found ? `; ${target.workerName} is already there and will be replaced` : ""}`;
    },

    // The database: the one by this name if it's Erga's, else a new one.
    async database() {
      const found = await findDatabase(cf, acc, target.databaseName);
      if (found) {
        // Erga's if it has Erga's first migration; usable if it's empty (made by a run that stopped before its tables).
        const tables = ((await d1(cf, acc, found, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", [], "look inside the database")) ?? []).map((r) => String(r.name));
        const applied = tables.includes("d1_migrations") ? await d1(cf, acc, found, "SELECT name FROM d1_migrations", [], "read the database's migrations") : [];
        const first = Object.keys(release.migrations).sort()[0];
        const ours = !!applied?.some((r) => r.name == first) || tables.every((t) => t == "d1_migrations");
        if (!ours)
          throw new DeployError({
            message: `Your account already has a D1 database called "${target.databaseName}" that isn't Erga's. So nothing of yours is lost, the deploy stops here: rename or delete that database, then deploy again.`,
          });
        carry.dbId = found;
        return `using Erga's database from before (${found})`;
      }
      const made = await cf.call<{ uuid: string }>("POST", `${acc}/d1/database`, "make the database", { name: target.databaseName });
      if (!made?.uuid)
        throw new DeployError({ message: "Cloudflare made the database but didn't say its id. Deploy again: the next run will find it." });
      carry.dbId = made.uuid;
      return `"${target.databaseName}" (${carry.dbId})`;
    },

    // server/migrations/, each once, recorded in d1_migrations as the cf CLI does.
    // First, the restore point: the last thing before the deploy changes what the target runs on.
    async migrations() {
      const db = carry.dbId!;
      const restore = await restorePoint(cf, target, { dbId: db, existing: !!carry.existing });
      carry.restore = restore.point;
      const noted =
        restore.point.versionId || restore.point.bookmark
          ? `restore point: ${restore.point.versionId ? `version ${restore.point.versionId.slice(0, 8)}${restore.point.version ? ` (release ${restore.point.version})` : ""}` : "no version"}, ${restore.point.bookmark ? `database bookmark ${restore.point.bookmark}` : "no database bookmark"}`
          : `no restore point (${restore.why})`;
      await d1(
        cf,
        acc,
        db,
        "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
        [],
        "set up the database"
      );
      const done = new Set(
        ((await d1(cf, acc, db, "SELECT name FROM d1_migrations", [], "read the database's migrations")) ?? []).map((r) => String(r.name))
      );
      const pending = Object.keys(release.migrations)
        .sort()
        .filter((n) => !done.has(n));
      for (const name of pending) {
        // The file and its record in d1_migrations, in one /query call (statements run as one batch, so all or nothing), as wrangler's `d1 migrations apply --remote` sends it.
        const sql = release.migrations[name].trim();
        await d1(cf, acc, db, `${sql}${sql.endsWith(";") ? "" : ";"}\nINSERT INTO d1_migrations (name) VALUES ('${name.replace(/'/g, "''")}');`, [], `apply the database migration ${name}`);
      }
      return `${pending.length ? `applied ${pending.join(", ")}` : "already up to date"}; ${noted}`;
    },

    // The static assets: the manifest, then each bucket Cloudflare asks for.
    async assets() {
      const files = servedAssets(release);
      (carry as Carry & { assetsJwt?: string }).assetsJwt = await runWith(opts.sleep, uploadAssets(cf, acc, target.workerName, files));
      return `${Object.keys(files).length} files`;
    },

    // The Worker: modules, bindings (from the build's config, made the target's own), secrets, its Durable Objects.
    async worker() {
      const assetsJwt = (carry as Carry & { assetsJwt?: string }).assetsJwt;
      if (!assetsJwt) throw new DeployError({ message: "The editor's files weren't uploaded first: deploy again." });
      // Whether the server's scheduled run runs already (a row of the last minutes): the live step waits by it.
      carry.ticking = readHealth(await healthRow(cf, acc, carry.dbId!).catch(() => null), null, Date.now()).healthy != null;
      await uploadWorker(assetsJwt);
      delete (carry as Carry & { assetsJwt?: string }).assetsJwt;
      // Its Cron Trigger, each minute: the server's own health into its database, and the default homepage.
      await setSchedule(cf, acc, target.workerName);
      // Behind a gate, nothing but the gate reaches it: a request to an address of its own would go around the gate.
      if (target.gate)
        await cf.call("POST", `${acc}/workers/scripts/${target.workerName}/subdomain`, "turn off its workers.dev address", {
          enabled: false,
          previews_enabled: false,
        });
      return `${target.workerName}, release ${release.version}; its Cron Trigger runs each minute${target.gate ? "; no address of its own (a gate has its hosts)" : ""}`;
    },

    // Its address, and its custom domains.
    async address() {
      /** Puts the Worker on `hostname` (a custom domain on one of the account's zones), unless it's there already. */
      const put = async (hostname: string, zoneId: string) => {
        const there = await cf
          .call<{ hostname: string; service: string }[]>(
            "GET",
            `${acc}/workers/domains?hostname=${encodeURIComponent(hostname)}`,
            `read ${hostname}'s custom domain`
          )
          .catch(() => null);
        const mine = there?.find((d) => d.hostname == hostname);
        if (mine && mine.service != target.workerName)
          throw new DeployError({
            message: `${hostname} is already the address of another Worker (${mine.service}). Remove it there, or pick another address.`,
          });
        if (!mine)
          await cf.call("PUT", `${acc}/workers/domains`, `put it on ${hostname} (a custom domain)`, {
            hostname,
            service: target.workerName,
            zone_id: zoneId,
          });
        return mine ? "already its address" : "new";
      };
      let said = `https://${host}`;
      if (target.app.kind == "workers.dev") {
        await cf.call("POST", `${acc}/workers/scripts/${target.workerName}/subdomain`, "turn on its workers.dev address", { enabled: true, previews_enabled: false });
      } else {
        const app = target.app;
        const zoneId = app.zoneId ?? (await zoneIdOf(cf, target.accountId, app.zoneName));
        if ((await put(app.hostname, zoneId)) == "already its address") said += " (already its address)";
        // Nothing asks the address from outside: Cloudflare says whether its certificate is there.
        const certificate = await certificateOf(cf, zoneId, app.hostname);
        if (certificate)
          said +=
            certificate == "active"
              ? "; its certificate is active"
              : `; its certificate is ${certificate}: the address answers when it is active`;
      }
      const domains = (target.domains ?? []).map((d) => d.toLowerCase());
      const zones = domains.length
        ? ((await cf.call<{ id: string; name: string }[]>("GET", `/zones?account.id=${target.accountId}&per_page=50`, "list your zones")) ??
          [])
        : [];
      for (const domain of domains) {
        const zone = zones
          .filter((z) => domain == z.name || domain.endsWith(`.${z.name}`))
          .sort((x, y) => y.name.length - x.name.length)[0];
        if (!zone)
          throw new DeployError({
            message: `${domain} is on none of this Cloudflare account's zones (${zones.map((z) => z.name).join(", ") || "none"}). A custom domain must be: add its zone to the account first.`,
          });
        said += `; the custom domain https://${domain}${(await put(domain, zone.id)) == "new" ? "" : " (already its address)"}`;
      }
      return said;
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
        if (route && route.script != target.workerName)
          throw new DeployError({
            message: `${pattern} already sends requests to another Worker (${route.script ?? "none"}). Remove that route, or pick another domain for pages.`,
          });
        if (!route)
          await cf.call("POST", `${zone}/workers/routes`, `route ${pattern} to the Worker`, { pattern, script: target.workerName });
        return `https://<document>.${name}`;
      }
      const proxy = new FormData();
      const name = `${target.workerName}-pages`;
      proxy.set(
        "metadata",
        JSON.stringify({
          main_module: "pages.js",
          compatibility_date: release.worker.compatibilityDate,
          tags: [WORKER_TAG],
        bindings: [{ type: "service", name: "APP", service: target.workerName }],
      }));
      proxy.append("pages.js", new File([PAGES_PROXY], "pages.js", { type: "application/javascript+module" }));
      await cf.call("PUT", `${acc}/workers/scripts/${name}`, "upload the pages Worker", proxy);
      await cf.call("POST", `${acc}/workers/scripts/${name}/subdomain`, "turn on the pages address", { enabled: true, previews_enabled: false });
      return `https://${pagesHost} (shared by every document)`;
    },

    // Healthy: the release's own health row, which its scheduled run writes into its database each minute (the database,
    // a document), read through D1's API. A server whose Cron Trigger ran before the deploy writes the new release's
    // row in about a minute: three minutes without a healthy one is an unhealthy release, which the caller rolls back.
    // A new Cron Trigger (the first deploy with one) can take up to 15 minutes to start, by Cloudflare's own words:
    // the step waits that long, and then stops with no rollback.
    live: () =>
      runWith(
        opts.sleep,
        Effect.gen(function* () {
          const want = carry.version!;
          const ticking = !!carry.ticking;
          const h = yield* settledHealth(cf, acc, carry.dbId!, want, opts.waitMs ?? (ticking ? 180_000 : 900_000));
          if (h.healthy) return `release ${want}, healthy (${h.summary})`;
          if (h.healthy === false)
            return yield* Effect.fail(
              new Unhealthy(`Release ${want} is deployed to ${target.workerName}, but its health check fails: ${h.why}`, h.why)
            );
          if (ticking)
            return yield* Effect.fail(
              new Unhealthy(
                `Release ${want} is deployed to ${target.workerName}, but it wrote no health row in 3 minutes (${h.why}): its scheduled run fails.`,
                h.why
              )
            );
          return yield* new DeployError({
            message: `Release ${want} is deployed to ${target.workerName}, but its first health row has not come yet (${h.why}). Cloudflare can take up to 15 minutes to start a new Cron Trigger. Look again in a few minutes: bun erga status`,
          });
        })
      ),

  };

  for (const id of steps) {
    report(id, "running");
    report(id, "done", await run[id]());
  }
  return { url: `https://${host}`, pages: targetPagesShown(target), database: carry.dbId ?? "", worker: target.workerName };
}
