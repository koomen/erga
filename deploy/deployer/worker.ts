// The deployer on Cloudflare: a Worker in the person's own account, with no route and no address: nothing calls it.
// Its schedule runs one look each minute (look.ts): the look reads the instance's spec, looks at GitHub, and with
// auto-deploy on deploys the head of the spec's branch with the core (deploy.ts).
//
// What setup gives it (bindings of this Worker; it has no other):
//   CLOUDFLARE_API_TOKEN   a secret: a token of the account for the instance's Worker only (Cloudflare's scope
//                          "Specified Workers", the role Editor). It holds no permission for D1: Cloudflare has none
//                          for one database.
//   DB                     the instance's database, as a D1 binding: the spec, the job log, the migrations and the
//                          health row all go through it (d1-binding.ts)
//   ACCOUNT, WORKER        the account's id and the instance's Worker: the one instance that it deploys to
//
// A spec that names another account or Worker is refused: the token's owner said which instance this deployer is for.
//
// Trap: it has no fetch handler. A handler is an address: a way for a stranger to start, or to slow, a deploy.

import * as Effect from "effect/Effect";
import { Cloudflare, type Fetch } from "./cloudflare-api";
import { bindingDatabase, bindingSql, type D1 } from "./d1-binding";
import { look } from "./look";

export interface Env {
  CLOUDFLARE_API_TOKEN: string;
  DB: D1;
  ACCOUNT: string;
  WORKER: string;
}

/** The Worker, with `fetch` as its way out (a test gives its own). */
export const deployer = (fetch: Fetch) => ({
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const cf = new Cloudflare(env.CLOUDFLARE_API_TOKEN, fetch);
    const line = await Effect.runPromise(
      look({
        sql: bindingSql(env.DB),
        fetch,
        cloud: { cloudflare: cf, database: bindingDatabase(env.DB) },
        mine: (t) => t.kind == "cloudflare" && t.account == env.ACCOUNT && t.worker == env.WORKER,
      })
    );
    console.log(line);
  },
});

// The platform's fetch, called as a function of its own: a Worker refuses it as a method of another object.
export default deployer((input, init) => fetch(input, init));
