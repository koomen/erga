// Where Erga's own branches deploy: the one list of them. cloudflare.config.ts
// reads production's names from targets.json (its Worker, database, domain and pages
// route), and the deploy pipeline turns
// each into a target to deploy to.
//
//   production   branch main      erga.dev           Worker erga          D1 erga           pages *.erga-pages.dev
//   staging      branch staging   staging.erga.dev   Worker erga-staging  D1 erga-staging   pages *.erga-pages-staging.dev
//
// Both are deployed by the control Worker (`control`: erga-control, at
// ops.erga.dev, control/), which holds Erga's repository, the pipeline, the
// Ops page and the build container, apart from the app, so a broken app
// never takes the way to fix it down with it. It is the one Worker in the
// account that deploys, with the one credential: an admin's OAuth grant (deploy/credential.ts).
//
// Both targets are in the same Cloudflare account (its id is the Worker's
// CLOUDFLARE_ACCOUNT_ID, or the environment's for deploy/run.ts). Staging
// shares nothing writable with production: its own Worker, so its own
// Durable Object namespaces, its own database, its own secrets
// (SESSION_SECRET, its own GitHub OAuth app) and its own pages origin. It
// runs on a copy of production's data (`snapshotFrom`), frozen: a deploy
// keeps it, and only a Redeploy with a fresh copy (or a first deploy, with no
// copy yet) copies again: the database through D1's export (read-only on
// production) and every document's Durable Object through production's
// read-only snapshot endpoint.
//
// Everything here is public (names, hostnames, OAuth client ids). Secrets are
// set on each Worker once and kept by every deploy after.
//
// The names themselves are in targets.json: cloudflare.config.ts reads that
// file (the dev server can't load a module the config imports into the
// Worker), and this module gives them their types.

export type TargetName = "production" | "staging";

export interface TargetSpec {
  name: TargetName;
  /** The branch of the source repo (Cloudflare Artifacts) whose head this target runs. */
  branch: "main" | "staging";
  /** The Worker, and the D1 database bound to it as DB (found by name, made if missing). */
  worker: string;
  database: string;
  /** The app's hostname (a Workers custom domain), and the zone it's on. */
  host: string;
  zone: string;
  /**
   * Documents' pages, one origin each: <id>-<owner>.<domain>, through a
   * wildcard route (*.<domain>/*) and a proxied wildcard DNS record
   * (* AAAA 100::) on `zone`. Each target's pages have a zone of their own
   * (erga-pages.dev, erga-pages-staging.dev), with `domain` the zone itself:
   * the zone's free Universal SSL certificate covers *.<zone>, one level
   * down only. A domain deeper in a zone would need an advanced certificate,
   * which is paid (deploy/setup.ts --certificate).
   */
  pages: { zone: string; domain: string };
  /** Text bindings this target sets over the build's (cloudflare.config.ts). */
  vars: Record<string, string>;
  /** Copy another target's data in (staging: production's): on a first deploy, and on a Redeploy with a fresh copy. */
  snapshotFrom?: TargetName;
  /**
   * Only Erga's admins may use this target's server (staging, which runs on a copy of production's data): every request
   * needs an admin's session or admin-scope token, with the few exemptions server/identity/admins-only.ts lists. The server
   * knows from DEPLOY_TARGET, which the pipeline sets on each deploy, so no setting turns it off.
   */
  adminsOnly?: boolean;
}

/**
 * The control Worker: Erga's repository, the pipeline, the Ops page and
 * the build container, on its own hostname. It deploys itself too, from
 * `branch` (main), after production: the release carries its bundle
 * (deploy/release.ts), and the pipeline uploads it with the same health
 * check and rollback as the app's targets (deploy/control.ts). Its
 * container image, and a new Durable Object class, still need wrangler
 * (deploy/setup.ts --control).
 */
export interface ControlSpec {
  branch: "main";
  worker: string;
  /** Its hostname (a Workers custom domain), and the zone it's on. */
  host: string;
  zone: string;
}

import data from "./targets.json";

/** The bootstrap admins: the same on every target. */
export const ADMINS: string = data.admins;

/** The source: one Artifacts repo (task #39 hosts it, with branches main and staging). */
export const SOURCE: { namespace: string; repo: string } = data.source;

/** The control Worker (control/): it deploys every target, and holds the build container. */
export const CONTROL: ControlSpec = data.control as ControlSpec;
/** The entrypoint of the control Worker that the app's CONTROL service binding reaches (control/index.ts, class App). */
export const CONTROL_ENTRYPOINT = "App";

/**
 * The targets themselves are in targets.json (staging's GITHUB_CLIENT_ID is
 * its own GitHub OAuth app's: homepage https://staging.erga.dev, callback
 * https://staging.erga.dev/auth/github/callback; deploy/setup.ts).
 * Staging is for admins only (`adminsOnly`), and its admins sign in with that
 * app, not production's: until someone makes it (on GitHub, by hand: GitHub
 * has no API for OAuth apps), puts its Client ID here and sets its secret
 * (`bunx cf workers secrets update GITHUB_CLIENT_SECRET --name erga-staging`),
 * or pastes both on production's Authentication page (/admin/auth, which
 * sets staging's through staging's server: cloudflare/auth-settings.ts),
 * /auth/github on staging shows a page saying so.
 * Every target gets ADMINS.
 */
export const TARGETS = Object.fromEntries(Object.entries(data.targets).map(([name, t]) => [name, { ...t, vars: { ADMINS, ...t.vars } }])) as unknown as Record<TargetName, TargetSpec>;

export const targetNames = Object.keys(TARGETS) as TargetName[];
export const isTargetName = (s: string): s is TargetName => s in TARGETS;

/** Everything a control Worker deploys: Erga's own targets and the control Worker itself (last: after production, on main); an install's app ("app") and its control Worker (deploy/fleet.ts). */
export type DeployName = TargetName | "control" | "app";
/** Erga's own deploys: what deploy/run.ts and the setup deploy from a machine. */
export type OwnDeployName = TargetName | "control";
export const deployNames: DeployName[] = [...targetNames, "control"];
export const isDeployName = (s: string): s is OwnDeployName => isTargetName(s) || s == "control";
/** What a deploy of `name` is: its branch, its Worker, its hostname, and (an app target) whose data it copies. */
export const specOf = (name: OwnDeployName): { name: DeployName; branch: "main" | "staging"; worker: string; host: string; snapshotFrom?: TargetName; control: boolean } =>
  name == "control" ? { name, branch: CONTROL.branch, worker: CONTROL.worker, host: CONTROL.host, control: true } : { ...TARGETS[name], control: false };

/** Whether a server whose DEPLOY_TARGET is this is for Erga's admins only (`adminsOnly`: staging; server/identity/admins-only.ts). */
export const isAdminsOnly = (deployTarget: string | undefined): boolean => {
  const name = deployTarget?.trim() ?? "";
  return Object.prototype.hasOwnProperty.call(TARGETS, name) && TARGETS[name as TargetName].adminsOnly == true;
};

/**
 * Names nothing but production may use: a deploy to another target that
 * would touch one of these stops before it starts.
 */
export const PRODUCTION = { worker: TARGETS.production.worker, database: TARGETS.production.database, host: TARGETS.production.host, pages: TARGETS.production.pages.domain };
