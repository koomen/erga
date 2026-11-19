// The deploy pipeline: the one way any Erga server is deployed, through the
// Cloudflare API, with no CLI and no container. Each step below is a few
// plain API calls, so a page can show them one at a time, and the tests run
// every one against a mock Cloudflare.
//
// Two sorts of steps. The shape steps are here: the account, the database, the addresses. A person's own login does
// them. The code steps (migrations, assets, worker, live) are the deployer's (deploy/deployer/cloudflare.ts): the
// pipeline runs the same ones, between its own.
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
import { bindingsProblem } from "../deployer/bindings";
import {
  CLOUDFLARE_STEPS,
  type Carry,
  type CloudflareRun,
  WORKER_TAG,
  boundDatabase,
  d1,
  deployFacts,
  sharedPagesHost,
} from "../deployer/cloudflare";
import { Cloudflare, DeployError } from "../deployer/cloudflare-api";
import type { Release } from "../deployer/release-format";
import type { CloudflareTarget } from "../deployer/spec";
import { PAGES_PROXY, certificateOf, ensureBuckets, findDatabase, listScripts, zoneIdOf } from "./account";

const [MIGRATIONS, ASSETS, WORKER, LIVE] = CLOUDFLARE_STEPS;

/** The steps of a deploy, in order: the shape steps, and the deployer's code steps between them. */
export const STEPS = [
  { id: "account", title: "Check your Cloudflare account" },
  { id: "database", title: "Make the database (D1)" },
  { id: MIGRATIONS.id, title: MIGRATIONS.title },
  { id: ASSETS.id, title: ASSETS.title },
  { id: WORKER.id, title: WORKER.title },
  { id: "address", title: "Give it its address" },
  { id: "pages", title: "Give documents' pages their own address" },
  { id: LIVE.id, title: LIVE.title },
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

export const targetHost = (t: Pick<Target, "app" | "workerName" | "subdomain">) =>
  t.app.kind == "domain" ? t.app.hostname : `${t.workerName}.${t.subdomain}.workers.dev`;
export const targetSharedPagesHost = (t: Pick<Target, "workerName" | "subdomain">) =>
  sharedPagesHost({ worker: t.workerName, subdomain: t.subdomain });

/** A target's deploy facts (deploy/deployer/cloudflare.ts, deployFacts): its names and its plain settings. */
export const targetFacts = (t: Target) => deployFacts(specTarget(t), t.vars);

/** A target as the deployer's steps name it: the target of the instance's spec (deploy/deployer/). */
export const specTarget = (t: Target): CloudflareTarget => ({
  kind: "cloudflare",
  account: t.accountId,
  worker: t.workerName,
  database: t.databaseName,
  ...(t.subdomain ? { subdomain: t.subdomain } : {}),
  app: t.app,
  pages: t.pages,
  ...(t.domains?.length ? { domains: t.domains } : {}),
});
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
  // The deployer's code steps, on this target: the first deploy's secrets go with the Worker's upload.
  const code: CloudflareRun = {
    cf,
    spec: { target: specTarget(target), settings: target.vars },
    release,
    carry,
    secrets: target.secrets,
    waitMs: opts.waitMs,
  };
  const wrong = guardTarget(target);
  if (wrong) throw new DeployError({ message: wrong });
  // A binding this pipeline can't make stops the deploy here, before any step changes the target.
  const unknown = bindingsProblem(release);
  if (unknown) throw new DeployError({ message: unknown });
  // Behind a gate's Worker, the hosts are the gate's: neither step that gives an address runs.
  const steps = STEPS.map((s) => s.id).filter((id) => !(target.gate && (id == "address" || id == "pages")));

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

    // The deployer's: the database's migrations, after the restore point (a rollback goes back to it).
    migrations: () => runWith(opts.sleep, MIGRATIONS.run(code)),

    // The deployer's: the static assets.
    assets: () => runWith(opts.sleep, ASSETS.run(code)),

    // The buckets that the release binds (shape: made here if they aren't there), then the deployer's upload of the Worker.
    async worker() {
      await ensureBuckets(cf, acc, release, target);
      const detail = await runWith(opts.sleep, WORKER.run(code));
      // Behind a gate, nothing but the gate reaches it: a request to an address of its own would go around the gate.
      if (target.gate)
        await cf.call("POST", `${acc}/workers/scripts/${target.workerName}/subdomain`, "turn off its workers.dev address", {
          enabled: false,
          previews_enabled: false,
        });
      return `${detail}${target.gate ? "; no address of its own (a gate has its hosts)" : ""}`;
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

    // The deployer's: the wait for the release's own health row.
    live: () => runWith(opts.sleep, LIVE.run(code)),
  };

  for (const id of steps) {
    report(id, "running");
    report(id, "done", await run[id]());
  }
  return { url: `https://${host}`, pages: targetPagesShown(target), database: carry.dbId ?? "", worker: target.workerName };
}
