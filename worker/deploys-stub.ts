// A stand-in for the deploy pipeline's API (task #40), until the pipeline
// lands and replaces this file: the Source page (/source) shows deploys
// from these routes, in the shape #40 answers them.
//
//   GET  /api/deploys                 { targets: [...] } (admins): none, unless local development set some
//   GET  /api/deploys/<name>/log      { deployId, commit, state, lines: [{ at, text, step? }] }, or 404
//   POST /__erga/deploys              local development only (the dev server's secret): sets the targets
//                                     ({ targets }), a log ({ log: { target, ... } }) or appends lines to one
//                                     ({ append: { target, lines, quiet? } }); publishes { type: "deploys" } and
//                                     { type: "deploy-log", target, deployId, lines } as #40 does
//
// It keeps what it's given in the events hub's storage (worker/events.ts).

import type { Env } from "./env";
import { publishEvent } from "./events";

interface Line { at: number; text: string; step?: string }
interface Log { deployId: string; commit: string | null; state: string; lines: Line[] }

const hub = (env: Env) => env.EVENTS.getByName("app");
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** GET /api/deploys and /api/deploys/<name>/log (the caller checked it's an admin). */
export async function deploysStub(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method != "GET") return json({ error: "Deploys aren't set up on this server yet." }, 404);
  if (url.pathname == "/api/deploys") return json({ targets: (await hub(env).stored("deploys:targets")) ?? [], stub: true });
  const [, name] = /^\/api\/deploys\/([a-z]+)\/log$/.exec(url.pathname) ?? [];
  const log = name ? ((await hub(env).stored(`deploys:log:${name}`)) as Log | null) : null;
  return log ? json(log) : json({ error: "No deploy log yet." }, 404);
}

/** POST /__erga/deploys: local development's tests set what the stand-in answers. */
export async function setDeploysStub(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { targets?: unknown[]; log?: Log & { target: string }; append?: { target: string; lines: Line[]; quiet?: boolean } };
  if (body.targets) { await hub(env).store("deploys:targets", body.targets); await publishEvent(env, { type: "deploys" }); }
  if (body.log) {
    const { target, ...log } = body.log;
    await hub(env).store(`deploys:log:${target}`, log);
    await publishEvent(env, { type: "deploy-log", target, deployId: log.deployId, lines: log.lines });
  }
  if (body.append) {
    const key = `deploys:log:${body.append.target}`;
    const log = ((await hub(env).stored(key)) as Log | null) ?? { deployId: "stub", commit: null, state: "building", lines: [] };
    log.lines.push(...body.append.lines);
    await hub(env).store(key, log);
    // quiet: no event, as when the deploy runs on another server (the page polls the log then).
    if (!body.append.quiet) await publishEvent(env, { type: "deploy-log", target: body.append.target, deployId: log.deployId, lines: body.append.lines });
  }
  return json({ ok: true });
}
