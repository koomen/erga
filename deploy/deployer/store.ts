// The deployer's store (worker.ts): its own Durable Object, with three values. `state`: what a run keeps for the next
// one, and the lock that one run holds. `token`: the token for the instance's Worker, sealed (token.ts). `renewed`:
// how the last update of the deployer's own code went. A run writes the state whole, so the other two are values of
// their own: a token that comes while a run goes on is not lost.

import type { Env, State } from "./worker";

/** How long a run's lock holds when the run stopped with no end. A run lasts about a minute at most. */
export const LOCK_MS = 3 * 60_000;

/** The last update of the deployer's own code (worker.ts, renew): when, to which release's code, and why not (null: done). */
export interface Renewed {
  at: number;
  version: string;
  why: string | null;
}

export interface Store {
  /** The state, with the lock taken at `now`. null: another run holds it. */
  take(now: number): Promise<State | null>;
  put(state: State): Promise<void>;
  /** Keeps what `set` has. The answer: the sealed token, the last update of the code, and the head at the last look. */
  says(set?: { token?: string; renewed?: Renewed }): Promise<{ token: string | null; renewed: Renewed | null; head: string | null }>;
}

export const storeOf = (env: Pick<Env, "STATE">): Store => {
  const stub = env.STATE.get(env.STATE.idFromName("state"));
  const ask = (body: object) => stub.fetch("https://state/", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  return {
    take: (now) => ask({ take: now }) as Promise<State | null>,
    put: (state) => ask({ put: state }).then(() => undefined),
    says: (set = {}) => ask({ set }) as ReturnType<Store["says"]>,
  };
};

/** The deployer's store. Cloudflare runs one request of it at a time, so one run only takes the lock. */
export class DeployerState {
  constructor(private ctx: { storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> } }) {}
  async fetch(request: Request): Promise<Response> {
    const ask = (await request.json()) as { take?: number; put?: State; set?: Parameters<Store["says"]>[0] };
    const { storage } = this.ctx;
    let state = ((await storage.get("state")) ?? {}) as State;
    if (ask.set) {
      if (ask.set.token) await storage.put("token", ask.set.token);
      if (ask.set.renewed) await storage.put("renewed", ask.set.renewed);
      const [token, renewed] = [await storage.get("token"), await storage.get("renewed")];
      return Response.json({ token: token ?? null, renewed: renewed ?? null, head: state.head ?? null });
    }
    if (ask.put) state = ask.put;
    else if (state.lock && ask.take! - state.lock < LOCK_MS) return Response.json(null);
    else state.lock = ask.take;
    await storage.put("state", state);
    return Response.json(state);
  }
}
