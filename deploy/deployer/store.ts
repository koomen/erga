// The deployer's store (worker.ts): its own Durable Object, with two values. `state`: what a run keeps for the next
// one, and the lock that one run holds. `token`: the token for the instance's Worker, sealed (token.ts). A run writes
// the state whole, so the token is a value of its own: a token that comes while a run goes on is not lost.

import type { Env, State, Store } from "./worker";

/** How long a run's lock holds when the run stopped with no end. A run lasts about a minute at most. */
export const LOCK_MS = 3 * 60_000;

export const storeOf = (env: Pick<Env, "STATE">): Store => {
  const stub = env.STATE.get(env.STATE.idFromName("state"));
  const ask = (body: object) => stub.fetch("https://state/", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  return {
    take: (now) => ask({ take: now }) as Promise<State | null>,
    put: (state) => ask({ put: state }).then(() => undefined),
    token: (sealed) => ask({ token: sealed ?? null }) as ReturnType<Store["token"]>,
  };
};

/** The deployer's store. Cloudflare runs one request of it at a time, so one run only takes the lock. */
export class DeployerState {
  constructor(private ctx: { storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> } }) {}
  async fetch(request: Request): Promise<Response> {
    const ask = (await request.json()) as { take?: number; put?: State; token?: string | null };
    let state = ((await this.ctx.storage.get("state")) ?? {}) as State;
    if ("token" in ask) {
      if (ask.token) await this.ctx.storage.put("token", ask.token);
      return Response.json({ token: (await this.ctx.storage.get("token")) ?? null, head: state.head ?? null });
    }
    if (ask.put) state = ask.put;
    else if (state.lock && ask.take! - state.lock < LOCK_MS) return Response.json(null);
    else state.lock = ask.take;
    await this.ctx.storage.put("state", state);
    return Response.json(state);
  }
}
