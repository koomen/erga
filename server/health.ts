// The app's health check, GET /api/health: whether this server works, for
// the deploy pipeline after each deploy (deploy/pipeline/pipeline.ts, the live step:
// a release that answers its version but fails this is rolled back) and for
// anyone who wants to know. It answers the release (as
// /api/deploys/version does) and a few checks, each timed:
//
//   db          one read of the server's settings (D1 answers)
//   documents   the homepage's document, opened in its own object (a Durable Object answers), when there is one
//
// {ok, version, checks: {<name>: {ok, ms, error?}}}: 200 when every
// check passes, 503 when one fails. It holds no data and needs no sign-in:
// on a staging instance the admins-only guard lets it through (server/identity/admins-only.ts).

import type { Platform } from "./platform.ts";

export interface HealthCheck {
  ok: boolean;
  ms: number;
  error?: string;
  note?: string;
}
export interface HealthReport {
  ok: boolean;
  version: string | null;
  checks: Record<string, HealthCheck>;
}

/** The health report: every check runs, so the answer says all that's wrong. */
export async function health(p: Platform): Promise<HealthReport> {
  const checks: Record<string, HealthCheck> = {
    db: await timed(async () => {
      await p.directory.config.get("public_sharing");
    }),
    documents: await timed(async () => {
      const id = await p.directory.homeId();
      if (!id) return "no homepage document: nothing to open";
      const route = await p.directory.route(id);
      if (!route) return `the homepage document ${id} isn't in the directory: nothing to open`;
      if ((await p.docs.index(route)) == null) throw new Error(`the homepage document ${id} has no host`);
    }),
  };
  return { ok: Object.values(checks).every((c) => c.ok), version: p.deploy.version, checks };
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
