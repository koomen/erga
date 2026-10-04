// What the rest of the server calls to deploy: task #39 (the source repo
// in Cloudflare Artifacts) calls deployHook after any push or merge that
// moves "staging" or "main", in the Worker. It hands the move to this
// server's branch deploys (worker/pipeline.ts, deploy/branches.ts), which
// build and deploy it if this server is that branch's target, and answers at
// once: the deploy runs on in the background, and its progress is
// GET /api/deploys and {type: "deploys"} on /api/events.
//
//   import { deployHook, publishEvent } from "./deploy";
//   await deployHook("staging", "3f2a…", env, "push by ada");   // env from cloudflare:workers, or pass it; what moved it, for the history
//   publishEvent({ type: "source" });               // an event on /api/events (admins)

import type { Env } from "../worker/env";

/** The Worker's env: given, or the running Worker's own (cloudflare:workers). */
async function envOf(env?: Env): Promise<Env> {
  if (env) return env;
  const mod = (await import("cloudflare:workers")) as unknown as { env: Env };
  return mod.env;
}

/** A branch moved to `commit`: deploy it where it goes. Never throws for a deploy that fails (that's in the status). */
export async function deployHook(branch: string, commit: string, env?: Env, trigger?: string): Promise<void> {
  const e = await envOf(env);
  await e.PIPELINE.getByName("deploys").hook(branch, commit, trigger);
}

/** An event to every admin listening on /api/events ({type: "source"} when a branch moves, for one). */
export async function publishEvent(event: { type: string } & Record<string, unknown>, env?: Env): Promise<void> {
  const e = await envOf(env);
  await e.PIPELINE.getByName("deploys").publish(event);
}
