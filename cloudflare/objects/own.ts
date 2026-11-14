// The server's own small storage, as a Durable Object (one, named "own"):
// what server/platform.ts calls `own`. It holds the sign-in values an admin
// sets on /admin/auth (server/identity/apps.ts, keys "auth:<provider>", the
// secret in them encrypted). Its own object, apart from the database (a copy
// of a primary's data replaces a staging instance's database, and must not replace
// its sign-in).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export class OwnStorage extends DurableObject<Env> {
  get(key: string): Promise<unknown> { return this.ctx.storage.get(key); }
  put(key: string, value: unknown): Promise<void> { return this.ctx.storage.put(key, value); }
  async delete(key: string): Promise<void> { await this.ctx.storage.delete(key); }
}
