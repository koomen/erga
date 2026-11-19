// The deployer on Cloudflare: a Worker in the person's own account, with no route and no address: nothing calls it.
// Its schedule runs one look each minute (look.ts): the look reads the instance's spec, looks at GitHub, and with
// auto-deploy on deploys the head of the spec's branch with the core (deploy.ts).
//
// What setup gives it (bindings of this Worker; it has no other):
//   CLOUDFLARE_API_TOKEN   a secret: a token of the account, as narrow as Cloudflare allows, for the instance's Worker
//   ACCOUNT, WORKER        the account's id and the instance's Worker: the one instance that it deploys to
//
// It finds the instance's database through the instance's Worker (its binding), and reads the spec there. A spec that
// names another account or Worker is refused: the token's owner said which instance this deployer is for.
//
// Trap: it has no fetch handler. A handler is an address: a way for a stranger to start, or to slow, a deploy.

import * as Effect from "effect/Effect";
import { d1Sql } from "./cloudflare";
import { Cloudflare, type Fetch } from "./cloudflare-api";
import { look } from "./look";

export interface Env {
  CLOUDFLARE_API_TOKEN: string;
  ACCOUNT: string;
  WORKER: string;
}

/** The Worker, with `fetch` as its way out (a test gives its own). */
export const deployer = (fetch: Fetch) => ({
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const cf = new Cloudflare(env.CLOUDFLARE_API_TOKEN, fetch);
    const line = await Effect.runPromise(
      look({
        sql: d1Sql(cf, { account: env.ACCOUNT, worker: env.WORKER }),
        fetch,
        cloud: { cloudflare: cf },
        mine: (t) => t.kind == "cloudflare" && t.account == env.ACCOUNT && t.worker == env.WORKER,
      })
    );
    console.log(line);
  },
});

// The platform's fetch, called as a function of its own: a Worker refuses it as a method of another object.
export default deployer((input, init) => fetch(input, init));
