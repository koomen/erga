// The app's health check: whether this server works. The server runs it itself each minute (tick: the Worker's Cron
// Trigger) and writes the result into its database (the one row of `health`), where `bun erga` reads it through the
// platform's database API: the deploy's live step (deploy/pipeline/pipeline.ts: a release whose row says it fails is
// rolled back), `bun erga status` and the ops page. The ops tool never asks the server. GET /api/health answers the
// same report to anyone who wants to know (on AWS: the load balancer, and the machine's own deploy script). It says
// the release and a few checks, each timed:
//
//   db          one read of the server's settings (D1 answers)
//   documents   the Erga domain's document, opened in its own object (a Durable Object answers), when there is one
//   secrets     a server that stores API keys has the key that opens them (SECRETS_KEY)
//
// {ok, version, upload, checks: {<name>: {ok, ms, error?}}}: 200 when every
// check passes, 503 when one fails. It holds no data and needs no sign-in.

import { makeHome } from "./documents/index.ts";
import type { Platform } from "./platform.ts";
import { ERGA, unpublishRemoved } from "./sites/index.ts";

export interface HealthCheck {
  ok: boolean;
  ms: number;
  error?: string;
  note?: string;
}
export interface HealthReport {
  ok: boolean;
  version: string | null;
  /** Which upload of the server's code answers: the name that the deploy gave it (Cloudflare: ERGA_UPLOAD), or null. */
  upload: string | null;
  checks: Record<string, HealthCheck>;
}

/**
 * The health report: every check runs, so the answer says all that's wrong. `upload`: the name of this upload of the
 * code, where the deploy gave it one: a deployer reads it to know that the answer is its own upload's.
 */
export async function health(p: Platform, upload: string | null = null): Promise<HealthReport> {
  const checks: Record<string, HealthCheck> = {
    db: await timed(async () => {
      await p.directory.config.get("public_sharing");
    }),
    documents: await timed(async () => {
      const id = (await p.site(ERGA).status()).doc;
      if (!id) return "no document is linked to the Erga domain: nothing to open";
      const route = await p.directory.route(id);
      if (!route) return `the Erga domain's document ${id} isn't in the directory: nothing to open`;
      if ((await p.docs.index(route)) == null) throw new Error(`the Erga domain's document ${id} has no host`);
    }),
    secrets: await timed(async () => {
      if (await p.directory.credentials.locked())
        throw new Error("the server stores API keys, and it has no SECRETS_KEY to open them: the deploy did not give it the key");
    }),
  };
  return { ok: Object.values(checks).every((c) => c.ok), version: p.deploy.version, upload, checks };
}

/** One check, timed; a string it answers is a note (the check passed, with nothing to do); a throw fails it. */
async function timed(check: () => Promise<string | void>): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const note = await check();
    return { ok: true, ms: Date.now() - started, ...(note ? { note } : {}) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: (e as Error)?.message ?? String(e) };
  }
}

/**
 * The server's scheduled run, each minute: its health into the database, for the ops tool to read there; then the
 * default homepage, when the server has none (documents/landing.ts: a server that has it does nothing); then the
 * documents of the custom domains that a deploy removed are unpublished (sites/domains.ts). A new release runs it
 * within a minute of its deploy: nothing asks the server for any of them.
 */
export async function tick(p: Platform, now = Date.now()): Promise<HealthReport> {
  const report = await health(p);
  await p.directory.keepHealth(report, now);
  await makeHome(p);
  await unpublishRemoved(p);
  return report;
}
