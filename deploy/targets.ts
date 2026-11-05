// Where Erga's own branches deploy: the one list of them. cloudflare.config.ts
// reads production's names from targets.json (its Worker, database, domain and pages
// route), and the deploy pipeline turns each into a target to deploy to
// (deploy/run.ts, targetFor). A new instance is set up with `bun erga setup <host>` instead (`bun erga setup skill`).
//
//   production   branch main      erga.dev           Worker erga          D1 erga           pages *.erga-pages.dev
//   staging      branch staging   staging.erga.dev   Worker erga-staging  D1 erga-staging   pages *.erga-pages-staging.dev
//
// Each deploy runs on a machine (`bun erga deploy`, deploy/cli/deploy.ts): a
// push deploys nothing.
//
// Both targets are in the same Cloudflare account (targets.json `account`;
// CLOUDFLARE_ACCOUNT_ID in the environment overrides it for deploy/run.ts).
// Staging shares nothing writable with production: its own Worker, so its own
// Durable Object namespaces, its own database, its own secrets
// (SESSION_SECRET, its own GitHub OAuth app) and its own pages origin. It
// runs on a copy of production's data (`snapshotFrom`), frozen: a deploy
// keeps it, and only a deploy with a fresh copy (deploy/run.ts staging --fresh,
// or a first deploy, with no copy yet) copies again: the database through D1's
// export (read-only on production) and every document's Durable Object through
// production's read-only snapshot endpoint.
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
  /** The branch of the GitHub repository whose pushes deploy this target. */
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
   * which is paid.
   */
  pages: { zone: string; domain: string };
  /** Text bindings this target sets over the build's (cloudflare.config.ts). */
  vars: Record<string, string>;
  /** Copy another target's data in (staging: production's): on a first deploy, and on a deploy with a fresh copy. */
  snapshotFrom?: TargetName;
}


import data from "./targets.json";

/** The Cloudflare account every target is in (32 hex digits). */
export const ACCOUNT: string = data.account;

/**
 * The targets themselves are in targets.json (staging's GITHUB_CLIENT_ID is
 * its own GitHub OAuth app's: homepage https://staging.erga.dev, callback
 * https://staging.erga.dev/auth/github/callback).
 * Staging is for admins only (DEPLOY_TARGET=staging: server/identity/admins-only.ts), and its admins sign in with that
 * app, not production's: until someone makes it (on GitHub, by hand: GitHub
 * has no API for OAuth apps), puts its Client ID here and sets its secret
 * (`bunx cf workers secrets update GITHUB_CLIENT_SECRET --name erga-staging`),
 * or pastes both on staging's own Authentication page (/admin/auth),
 * /auth/github on staging shows a page saying so.
 * No target names an admin: each server's admins are rows in its database.
 */
export const TARGETS = data.targets as unknown as Record<TargetName, TargetSpec>;

export const isTargetName = (s: string): s is TargetName => s in TARGETS;

/**
 * Names nothing but production may use: a deploy to another target that
 * would touch one of these stops before it starts.
 */
export const PRODUCTION = { worker: TARGETS.production.worker, database: TARGETS.production.database, host: TARGETS.production.host, pages: TARGETS.production.pages.domain };
