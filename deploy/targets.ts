// Where Erga's own branches deploy: the one list of them. cloudflare.config.ts
// reads production's names from here (its Worker, database, domain and pages
// route), and the deploy pipeline (deploy/cloudflare.ts, runPipeline) turns
// each into a target to deploy to (deploy/branches.ts, deploy/run.ts).
//
//   production   branch main      erga.dev           Worker erga          D1 erga           pages *.erga-pages.dev
//   staging      branch staging   staging.erga.dev   Worker erga-staging  D1 erga-staging   pages *.staging.erga-pages.dev
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
// This file is loaded by cloudflare.config.ts under Node's type stripping:
// plain types and values only, imports with their .ts extension.

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
   * (* AAAA 100::) on `zone`. A wildcard one level down (staging's) needs a
   * certificate that covers it: Universal SSL covers *.erga-pages.dev only
   * (deploy/setup.ts orders an advanced certificate, after asking).
   */
  pages: { zone: string; domain: string };
  /** Text bindings this target sets over the build's (cloudflare.config.ts). */
  vars: Record<string, string>;
  /** Copy another target's data in on each deploy (staging: production's). */
  snapshotFrom?: TargetName;
  /** Branch moves this target's server hears of for other targets go on to them (production tells staging). */
  notifies?: TargetName[];
}

/** The bootstrap admins (users.ts): the same on every target. */
export const ADMINS = "koomen,dsiroker";

/** The source: one Artifacts repo (task #39 hosts it, with branches main and staging). */
export const SOURCE = { namespace: "erga", repo: "erga" };

/** The Worker that builds a commit (deploy/builder/): a container with bun and git, reached over a service binding. */
export const BUILDER = "erga-builder";

export const TARGETS: Record<TargetName, TargetSpec> = {
  production: {
    name: "production",
    branch: "main",
    worker: "erga",
    database: "erga",
    host: "erga.dev",
    zone: "erga.dev",
    pages: { zone: "erga-pages.dev", domain: "erga-pages.dev" },
    vars: {
      ADMINS,
      GITHUB_CLIENT_ID: "Ov23ctkY7oLarHcPA97b",
    },
    notifies: ["staging"],
  },
  staging: {
    name: "staging",
    branch: "staging",
    worker: "erga-staging",
    database: "erga-staging",
    host: "staging.erga.dev",
    zone: "erga.dev",
    pages: { zone: "erga-pages.dev", domain: "staging.erga-pages.dev" },
    vars: {
      ADMINS,
      // Staging's own GitHub OAuth app (homepage https://staging.erga.dev, callback
      // https://staging.erga.dev/auth/github/callback): its Client ID goes here (README, the runbook).
      GITHUB_CLIENT_ID: "",
      // Staging has no /deploy OAuth client; the token link still works.
      CLOUDFLARE_OAUTH_CLIENT_ID: "",
    },
    snapshotFrom: "production",
  },
};

export const targetNames = Object.keys(TARGETS) as TargetName[];
export const isTargetName = (s: string): s is TargetName => s in TARGETS;

/**
 * Names nothing but production may use: a deploy to another target that
 * would touch one of these stops before it starts (deploy/cloudflare.ts).
 */
export const PRODUCTION = { worker: TARGETS.production.worker, database: TARGETS.production.database, host: TARGETS.production.host, pages: TARGETS.production.pages.domain };
