// Installing Erga in another Cloudflare account, from erga.dev's control
// Worker (/deploy on ops.erga.dev: cloudflare/deploy-routes.ts, the session
// in cloudflare/deploy-session.ts). An install makes two Workers there, from
// a release of the store (deploy/releases.ts; stable's latest):
//
//   the app, erga          as /deploy always made it (the same pipeline, deploy/pipeline.ts): its database,
//                          migrations, files, Worker, address and pages
//   its control Worker,    erga.dev's control Worker (control/), without the parts an install can't have: no
//   erga-control           repository (Artifacts), no build container, no release store of its own. It reads the
//                          app's database (who is an admin), signs admins in with the same GitHub App, and
//                          upgrades the app from erga.dev's store once an admin consents at its /install
//                          (cloudflare/pipeline.ts, the UPSTREAM and INSTALL settings).
//
// The order: the account, the database and its migrations (the pipeline's
// first steps), then the control Worker (the app's CONTROL service binding
// needs it there), then the app's files, Worker, address, pages and health
// check, then the control Worker's health check. Every step is safe to run
// again (Try again on the page).
//
// Addresses: the app's as chosen; the control Worker's beside it: on
// workers.dev, erga-control.<subdomain>.workers.dev; on a domain,
// ops.<zone> for an app at the zone's apex, else <first label>-ops.<rest>
// (one level under the zone, which the zone's own certificate covers).

import { Cloudflare, DeployError, checkHealth, runPipeline, STEPS, targetHost, targetOfPlan, WORKER_TAG, type Carry, type DeployPlan, type Fetch, type Release, type Report, type Target } from "./pipeline";
import { CONTROL_ENTRYPOINT } from "./targets";

/** The install's steps, as the page lists them: the pipeline's, with the control Worker's two among them. */
export const INSTALL_STEPS = [
  STEPS[0], STEPS[1], STEPS[2],
  { id: "control", title: "Upload the control Worker, which keeps it up to date" },
  STEPS[3], STEPS[4], STEPS[5], STEPS[6], STEPS[7],
  { id: "control-live", title: "Wait for the control Worker to answer" },
] as const;
export type InstallStepId = (typeof INSTALL_STEPS)[number]["id"];

/** The control Worker's name in an install, and the app's. */
export const INSTALL_CONTROL_WORKER = "erga-control";
/** The deploy page's cookie while Cloudflare's consent is out (cloudflare/deploy-routes.ts): the control Worker's callback tells the page's return by it. */
export const DEPLOY_OAUTH_COOKIE = "erga_deploy_oauth";

/** The control Worker's hostname beside the app's. */
export function controlHostOf(plan: Pick<DeployPlan, "app" | "subdomain">): string {
  if (plan.app.kind == "workers.dev") return `${INSTALL_CONTROL_WORKER}.${plan.subdomain}.workers.dev`;
  const host = plan.app.hostname.toLowerCase(), zone = plan.app.zoneName.toLowerCase();
  if (host == zone) return `ops.${zone}`;
  const [first, ...rest] = host.split(".");
  return `${first}-ops.${rest.join(".")}`;
}

/** What an install's control Worker is told about itself (its INSTALL setting, JSON): its one target, to upgrade. */
export interface InstallSpec {
  accountId: string;
  worker: string;
  database: string;
  subdomain?: string;
  app: DeployPlan["app"];
  pages: DeployPlan["pages"];
  control: { worker: string; host: string };
}

export interface Upstream {
  /** erga.dev's control Worker (https://ops.erga.dev): the release store, and the consent relay. */
  origin: string;
  /** Erga's OAuth client, which the install's control Worker consents through (the relay). */
  clientId: string;
}

export interface Installed { url: string; pages: string; database: string; worker: string; control: string }

/** The app's target: /deploy's, plus the control Worker beside it (its service binding and address). */
export function installAppTarget(plan: DeployPlan, sessionSecret: string, controlHost: string): Target {
  const t = targetOfPlan(plan, sessionSecret);
  return { ...t, vars: { ...t.vars, CONTROL_URL: `https://${controlHost}` }, services: { CONTROL: { service: INSTALL_CONTROL_WORKER, entrypoint: CONTROL_ENTRYPOINT } } };
}

/**
 * The control Worker's upload metadata for an install: the release's control
 * part (control/wrangler.jsonc as the release has it), with only what an
 * install has. Its Durable Objects are declared as exports (a new Worker has
 * no namespaces; wrangler made erga.dev's), so a second install run matches
 * them. No container, no Artifacts, no bucket.
 */
export function installControlMetadata(release: Release, o: { accountId: string; dbId: string; vars: Record<string, string>; secrets: Record<string, string> }) {
  const c = release.control;
  if (!c) throw new DeployError(`This release (${release.version}) has no control Worker in it: pick a newer one.`);
  const cfg = c.config;
  const bindings: Record<string, unknown>[] = [];
  const classes = cfg.durableObjects.filter((d) => d.name != "BUILDS");
  for (const d of classes) bindings.push({ type: "durable_object_namespace", name: d.name, class_name: d.className });
  for (const d of cfg.d1) bindings.push({ type: "d1", name: d.name, database_id: o.dbId, id: o.dbId });
  if (cfg.versionMetadata) bindings.push({ type: "version_metadata", name: cfg.versionMetadata });
  for (const [name, value] of Object.entries({ ERGA_VERSION: release.version, ...o.vars })) bindings.push({ type: "plain_text", name, text: value });
  for (const [name, value] of Object.entries(o.secrets)) bindings.push({ type: "secret_text", name, text: value });
  return {
    main_module: c.mainModule,
    compatibility_date: cfg.compatibilityDate,
    compatibility_flags: cfg.compatibilityFlags,
    bindings,
    keep_bindings: ["secret_text", "secret_key"],
    exports: Object.fromEntries(classes.map((d) => [d.className, { type: "durable-object", storage: "sqlite" }])),
    observability: { enabled: cfg.observability.enabled, logs: { enabled: cfg.observability.logs.enabled, invocation_logs: cfg.observability.logs.invocationLogs } },
    tags: [WORKER_TAG],
  };
}

/** The install: both Workers, in order, reporting each step; what it made. */
export async function runInstall(cf: Cloudflare, release: Release, plan: DeployPlan, o: {
  /** The new app's SESSION_SECRET, and the control Worker's (each new for this install). */
  sessionSecret: string; controlSecret: string;
  upstream: Upstream;
  report: (step: InstallStepId, status: "running" | "done" | "skipped", detail?: string) => void;
  site?: Fetch; sleep?: (ms: number) => Promise<void>; waitMs?: number;
}): Promise<Installed> {
  const site = o.site ?? globalThis.fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const controlHost = controlHostOf(plan);
  const app = installAppTarget(plan, o.sessionSecret, controlHost);
  const appHost = targetHost(app);
  const acc = `/accounts/${plan.accountId}`;
  const carry: Carry = {};
  const report = o.report as Report;
  const pipelineOpts = { report, site, sleep: o.sleep, waitMs: o.waitMs, carry };

  // The account, the database, its migrations.
  await runPipeline(cf, release, app, { ...pipelineOpts, until: "migrations" });

  // The control Worker: must be Erga's if it's there; its settings; its address.
  o.report("control", "running");
  const settings = await cf.call<{ tags?: string[] }>("GET", `${acc}/workers/scripts/${INSTALL_CONTROL_WORKER}/settings`, `read ${INSTALL_CONTROL_WORKER}'s settings`, undefined, { allow404: true });
  if (settings && !settings.tags?.includes(WORKER_TAG)) throw new DeployError(`Your account already has a Worker called ${INSTALL_CONTROL_WORKER} that isn't Erga's. So it isn't overwritten, the install stops here: delete or rename that Worker, then try again.`);
  const spec: InstallSpec = { accountId: plan.accountId, worker: plan.workerName, database: app.databaseName, ...(plan.subdomain ? { subdomain: plan.subdomain } : {}), app: plan.app, pages: plan.pages, control: { worker: INSTALL_CONTROL_WORKER, host: controlHost } };
  const vars = {
    ADMINS: plan.admin.toLowerCase(), CLOUDFLARE_ACCOUNT_ID: plan.accountId, APP_URL: `https://${appHost}`,
    GITHUB_CLIENT_ID: plan.githubClientId.trim(), CLOUDFLARE_OAUTH_CLIENT_ID: o.upstream.clientId,
    UPSTREAM: o.upstream.origin, INSTALL: JSON.stringify(spec),
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(installControlMetadata(release, { accountId: plan.accountId, dbId: carry.dbId!, vars, secrets: { SESSION_SECRET: o.controlSecret, GITHUB_CLIENT_SECRET: plan.githubClientSecret.trim() } })));
  for (const [name, bytes] of Object.entries(release.control!.modules)) form.append(name, new File([new Uint8Array(bytes)], name, { type: "application/javascript+module" }));
  await cf.call("PUT", `${acc}/workers/scripts/${INSTALL_CONTROL_WORKER}`, "upload the control Worker", form);
  if (plan.app.kind == "workers.dev") {
    await cf.call("POST", `${acc}/workers/scripts/${INSTALL_CONTROL_WORKER}/subdomain`, "turn on the control Worker's workers.dev address", { enabled: true, previews_enabled: false });
  } else {
    const there = await cf.call<{ hostname: string; service: string }[]>("GET", `${acc}/workers/domains?hostname=${encodeURIComponent(controlHost)}`, `read ${controlHost}'s custom domain`).catch(() => null);
    const mine = there?.find((d) => d.hostname == controlHost);
    if (mine && mine.service != INSTALL_CONTROL_WORKER) throw new DeployError(`${controlHost} is already the address of another Worker (${mine.service}). Remove it there, or pick another address for the app.`);
    if (!mine) await cf.call("PUT", `${acc}/workers/domains`, `put the control Worker on ${controlHost}`, { hostname: controlHost, service: INSTALL_CONTROL_WORKER, zone_id: plan.app.zoneId });
  }
  o.report("control", "done", `${INSTALL_CONTROL_WORKER}, release ${release.version}, at https://${controlHost}`);

  // The app's files, Worker, address, pages and health.
  const made = await runPipeline(cf, release, app, { ...pipelineOpts, from: "assets" });

  // The control Worker answers, healthy.
  o.report("control-live", "running");
  const until = Date.now() + (o.waitMs ?? 180_000);
  for (let tries = 0; ; tries++) {
    const h = await checkHealth(site, controlHost, release.version).catch(() => null);
    if (h?.ok) { o.report("control-live", "done", `https://${controlHost}, release ${release.version} (${h.summary})`); break; }
    if (Date.now() > until) throw new DeployError(`The control Worker is uploaded, but https://${controlHost} hasn't answered yet${h?.why ? ` (${h.why})` : ""}. Open it in a little while; if it still doesn't answer, try again.`);
    await sleep(Math.min(5000, 1000 + tries * 500));
  }
  return { ...made, control: `https://${controlHost}` };
}
