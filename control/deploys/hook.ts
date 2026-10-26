// What the rest of the server calls to deploy: task #39 (the source repo
// in Cloudflare Artifacts) calls deployHook after any push or merge that
// moves "staging" or "main", in the Worker. It hands the move to this
// server's branch deploys, which
// build and deploy it if this server is that branch's target, and answers at
// once: the deploy runs on in the background, and its progress is
// GET /api/deploys and {type: "deploys"} on /api/events.
//
//   import { deployHook, publishEvent } from "./hook";
//   await deployHook("staging", "3f2a…", env, "push by ada");   // env from cloudflare:workers, or pass it; what moved it, for the history
//   publishEvent({ type: "source" });               // an event on /api/events (admins)

import type { Env } from "../../cloudflare/env";

/** The Worker's env: given, or the running Worker's own (cloudflare:workers). */
async function envOf(env?: Env): Promise<Env> {
  if (env) return env;
  const mod = (await import("cloudflare:workers")) as unknown as { env: Env };
  return mod.env;
}

/** The deploys' object: the control Worker's (and the app's in local development); a Worker without it has no deploys. */
async function deploysOf(env?: Env) {
  const e = await envOf(env);
  if (!e.PIPELINE) throw new Error("This Worker has no deploys (no PIPELINE binding): only the control Worker deploys.");
  return e.PIPELINE.getByName("deploys");
}

/** A branch moved to `commit`: deploy it where it goes. Never throws for a deploy that fails (that's in the status). */
export async function deployHook(branch: string, commit: string, env?: Env, trigger?: string): Promise<void> {
  await (await deploysOf(env)).hook(branch, commit, trigger);
}

/** A release was cut (a tag vX.Y.Z on main): the deploys' object puts it on stable once its release is in the store. */
export async function releaseHook(tag: string, commit: string, by: string, env?: Env): Promise<void> {
  await (await deploysOf(env)).tagged({ tag, commit, by, at: Date.now() });
}

/** An event to every admin listening on /api/events ({type: "source"} when a branch moves, for one). */
export async function publishEvent(event: { type: string } & Record<string, unknown>, env?: Env): Promise<void> {
  await (await deploysOf(env)).publish(event);
}
