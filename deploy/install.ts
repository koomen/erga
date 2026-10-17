// Installing Erga in another Cloudflare account, from erga.dev's control
// Worker (/deploy on ops.erga.dev: cloudflare/deploy-routes.ts, the session
// in cloudflare/deploy-session.ts). An install makes two Workers there, from
// a release of the store (deploy/releases.ts; stable's latest), and is a
// downstream of erga.dev from then on:
//
//   production, erga       as /deploy always made it (the same pipeline, deploy/pipeline.ts): its database,
//                          migrations, files, Worker, address and pages
//   its control Worker,    erga.dev's control Worker (control/) in that account: the Ops page, its own
//   erga-control           environments (production, staging, control) and their deploys, and the instance's
//                          repository: a fork of erga.dev's, kept at erga.dev (its Artifacts, one repo per
//                          install, reached with the install's FORK_SECRET: cloudflare/pipeline.ts, the forks)
//                          and built there (erga.dev's build container, over the same secret). It reads the
//                          app's database (who is an admin), signs admins in with Erga's GitHub App (through
//                          erga.dev's callback, the App's one: server/source/github.ts), and
//                          deploys its environments from its own branches, as erga.dev's does, once an admin
//                          consents at its /install (the UPSTREAM, INSTALL and FORK_SECRET settings).
//
// Staging comes after: the control Worker deploys it from the fork's staging
// (the same commit as production, at first) on its first alarm: its own
// Worker and database, a copy of production's data, at staging.<zone> (or
// <first label>-staging.<rest>, or erga-staging.<subdomain>.workers.dev).
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

import { Cloudflare, DB_NAME, DeployError, checkHealth, runPipeline, STEPS, targetHost, targetOfPlan, WORKER_TAG, type Carry, type DeployPlan, type Fetch, type Release, type Report, type Target } from "./pipeline";
import { installControlMetadata } from "./control";
import { CONTROL_ENTRYPOINT } from "./targets";
export { installControlMetadata };

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
export const controlHostOf = (plan: Pick<DeployPlan, "app" | "subdomain">): string => besideApp(plan, INSTALL_CONTROL_WORKER, "ops");
/** Staging's hostname beside the app's: staging.<zone>, <first label>-staging.<rest>, or erga-staging.<subdomain>.workers.dev. */
export const stagingHostOf = (plan: Pick<DeployPlan, "app" | "subdomain" | "workerName">): string => besideApp(plan, `${plan.workerName}-staging`, "staging");
function besideApp(plan: Pick<DeployPlan, "app" | "subdomain">, worker: string, label: string): string {
  if (plan.app.kind == "workers.dev") return `${worker}.${plan.subdomain}.workers.dev`;
  const host = plan.app.hostname.toLowerCase(), zone = plan.app.zoneName.toLowerCase();
  if (host == zone) return `${label}.${zone}`;
  const [first, ...rest] = host.split(".");
  return `${first}-${label}.${rest.join(".")}`;
}

/** One of an install's app environments (production, staging): its Worker, database and addresses. */
export interface InstallEnvironment { worker: string; database: string; app: DeployPlan["app"]; pages: DeployPlan["pages"] }
/** What an install's control Worker is told about itself (its INSTALL setting, JSON): its environments, and its fork at upstream. */
export interface InstallSpec {
  accountId: string;
  subdomain?: string;
  /** The fork's id at upstream: its repository and its builds live there (control/routes.ts, /forks/<id>/...). */
  fork: string;
  production: InstallEnvironment;
  staging: InstallEnvironment;
  control: { worker: string; host: string };
}

/** An install's spec from its plan: production as chosen, staging beside it (its pages on the shared host), the control Worker beside both. */
export function installSpecOf(plan: DeployPlan, fork: string): InstallSpec {
  const stagingHost = stagingHostOf(plan);
  return {
    accountId: plan.accountId, ...(plan.subdomain ? { subdomain: plan.subdomain } : {}), fork,
    production: { worker: plan.workerName, database: DB_NAME, app: plan.app, pages: plan.pages },
    staging: {
      worker: `${plan.workerName}-staging`, database: `${DB_NAME}-staging`,
      app: plan.app.kind == "domain" ? { kind: "domain", zoneId: plan.app.zoneId, zoneName: plan.app.zoneName, hostname: stagingHost } : { kind: "workers.dev" },
      pages: { kind: "shared" },
    },
    control: { worker: INSTALL_CONTROL_WORKER, host: controlHostOf(plan) },
  };
}

export interface Upstream {
  /** erga.dev's control Worker (https://ops.erga.dev): the release store, and the consent relays (Cloudflare's, GitHub's). */
  origin: string;
  /** Erga's OAuth client on Cloudflare, which the install's control Worker consents through (the relay). */
  clientId: string;
  /** Erga's GitHub App (its client id and slug): the install's sign-in and Connect GitHub, through erga.dev. */
  github: { clientId: string; slug: string };
}

export interface Installed { url: string; pages: string; database: string; worker: string; control: string; staging: string }

/** The app's target: /deploy's, plus the control Worker beside it (its service binding and address), and the token staging's copies go through. */
export function installAppTarget(plan: DeployPlan, sessionSecret: string, controlHost: string, upstream: Upstream, snapshotToken?: string): Target {
  const t = targetOfPlan(plan, sessionSecret, { clientId: upstream.github.clientId, relay: upstream.origin });
  return { ...t, vars: { ...t.vars, CONTROL_URL: `https://${controlHost}` }, secrets: { ...t.secrets, ...(snapshotToken ? { SNAPSHOT_TOKEN: snapshotToken } : {}) }, services: { CONTROL: { service: INSTALL_CONTROL_WORKER, entrypoint: CONTROL_ENTRYPOINT } } };
}

/** The install: both Workers, in order, reporting each step; what it made. */
export async function runInstall(cf: Cloudflare, release: Release, plan: DeployPlan, o: {
  /** The new app's SESSION_SECRET, and the control Worker's (each new for this install). */
  sessionSecret: string; controlSecret: string;
  /** The token staging's copies of production's data go through (SNAPSHOT_TOKEN on production, staging and the control Worker). */
  snapshotToken: string;
  /** The install's fork at upstream (made before the install: cloudflare/pipeline.ts makeFork), and the secret its control Worker reaches it with. */
  fork: { id: string; secret: string };
  upstream: Upstream;
  report: (step: InstallStepId, status: "running" | "done" | "skipped", detail?: string) => void;
  site?: Fetch; sleep?: (ms: number) => Promise<void>; waitMs?: number;
}): Promise<Installed> {
  const site = o.site ?? globalThis.fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const controlHost = controlHostOf(plan);
  const app = installAppTarget(plan, o.sessionSecret, controlHost, o.upstream, o.snapshotToken);
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
  const spec = installSpecOf(plan, o.fork.id);
  const vars = {
    ADMINS: plan.admin.toLowerCase(), CLOUDFLARE_ACCOUNT_ID: plan.accountId, APP_URL: `https://${appHost}`,
    GITHUB_APP_CLIENT_ID: o.upstream.github.clientId, GITHUB_APP_SLUG: o.upstream.github.slug, CLOUDFLARE_OAUTH_CLIENT_ID: o.upstream.clientId,
    UPSTREAM: o.upstream.origin, INSTALL: JSON.stringify(spec),
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(installControlMetadata(release, { accountId: plan.accountId, dbId: carry.dbId!, vars, secrets: { SESSION_SECRET: o.controlSecret, SNAPSHOT_TOKEN: o.snapshotToken, FORK_SECRET: o.fork.secret } })));
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
  return { ...made, control: `https://${controlHost}`, staging: `https://${stagingHostOf(plan)}` };
}
