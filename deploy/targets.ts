// Where Erga's own branches deploy: the one list of them. cloudflare.config.ts
// reads production's names from targets.json (its Worker, database, domain and pages
// route), and the deploy pipeline (deploy/cloudflare.ts, runPipeline) turns
// each into a target to deploy to (deploy/branches.ts, deploy/run.ts).
//
//   production   branch main      erga.dev           Worker erga          D1 erga           pages *.erga-pages.dev
//   staging      branch staging   staging.erga.dev   Worker erga-staging  D1 erga-staging   pages *.erga-pages-staging.dev
//
// Both are in the same Cloudflare account (its id is the Worker's
// CLOUDFLARE_ACCOUNT_ID, or the environment's for deploy/run.ts). Staging
// shares nothing writable with production: its own Worker, so its own
// Durable Object namespaces, its own database, its own secrets
// (SESSION_SECRET, its own GitHub OAuth app) and its own pages origin. On each
// deploy it gets a fresh copy of production's data (`snapshotFrom`): the
// database through D1's export (read-only on production) and every document's
// Durable Object through production's read-only snapshot endpoint
// (deploy/snapshot.ts).
//
// Everything here is public (names, hostnames, OAuth client ids). Secrets are
// set on each Worker once (deploy/setup.ts) and kept by every deploy after.
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
  /** Copy another target's data in on each deploy (staging: production's). */
  snapshotFrom?: TargetName;
  /**
   * Branch moves this target's server hears of for other targets go on to
   * them (production tells staging of staging's, staging tells production of
   * main's). Production deploys main's head as its own repository has it,
   * never the commit another server names (deploy/branches.ts, remoteHook).
   */
  notifies?: TargetName[];
  /**
   * The targets this server's own Cloudflare token may deploy (deploy/tokens.ts
   * makes the token so: Editor on these Workers only). Production's may deploy
   * staging and production; staging's, staging only. Production deploys staging
   * itself only when staging's server doesn't take a move passed on to it (it's
   * down, or can't deploy itself): deploy/branches.ts.
   */
  deploys: TargetName[];
  /**
   * The factory runs here with VMs (README, The factory): Cloudflare Containers from the factory's image (FACTORY,
   * below), with previews on <vm>.<pages.domain>: the pages' wildcard route, DNS record and Universal SSL certificate
   * already cover one label under it, so the previews need nothing new.
   */
  factory?: boolean;
}

import data from "./targets.json";

/** The bootstrap admins (users.ts): the same on every target. */
export const ADMINS: string = data.admins;

/** The source: one Artifacts repo (task #39 hosts it, with branches main and staging). */
export const SOURCE: { namespace: string; repo: string } = data.source;

/** The Worker that builds a commit (deploy/builder/): a container with bun and git, reached over a service binding. */
export const BUILDER: string = data.builder;

/**
 * The factory's VM image (factory/vm/Dockerfile): its name in the account's container registry,
 * erga-factory:<tag>, with the tag factory/vm/build.ts gives it (tests/factory.test.ts checks they're equal).
 * A new Dockerfile or agent needs a new image pushed (bun factory/vm/push.ts, or a deploy from a machine).
 */
export const FACTORY: { image: string } = data.factory;

/**
 * The targets themselves are in targets.json (staging's GITHUB_CLIENT_ID is
 * its own GitHub OAuth app's: homepage https://staging.erga.dev, callback
 * https://staging.erga.dev/auth/github/callback; the runbook in the README).
 * Every target gets ADMINS.
 */
export const TARGETS = Object.fromEntries(Object.entries(data.targets).map(([name, t]) => [name, { ...t, vars: { ADMINS, ...t.vars } }])) as unknown as Record<TargetName, TargetSpec>;

export const targetNames = Object.keys(TARGETS) as TargetName[];
export const isTargetName = (s: string): s is TargetName => s in TARGETS;

/**
 * Names nothing but production may use: a deploy to another target that
 * would touch one of these stops before it starts (deploy/cloudflare.ts).
 */
export const PRODUCTION = { worker: TARGETS.production.worker, database: TARGETS.production.database, host: TARGETS.production.host, pages: TARGETS.production.pages.domain };
