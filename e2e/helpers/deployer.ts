// A deployer's way to a local server's deploy tables: one statement at a time, through the dev server's route
// (cloudflare/dev.ts, /__erga/deploys), as a deployer in the cloud goes through its platform's database API. With it a
// journey runs the deployer's own code (deploy/deployer/instance.ts, control.ts) against the server that it tests.

import * as Effect from "effect/Effect";
import { DeployError } from "../../deploy/deployer/cloudflare-api";
import { NoTable, type Sql } from "../../deploy/deployer/instance";
import type { Server } from "./server";

export const deployerSql =
  (server: Pick<Server, "root" | "secret">): Sql =>
  (sql, params) =>
    Effect.tryPromise({
      try: async () => {
        const r = await fetch(`${server.root}/__erga/deploys?link=${server.secret}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql, params }),
        });
        if (!r.ok) throw new Error(await r.text());
        return ((await r.json()) as { rows: string[] }).rows;
      },
      catch: (e) => (/no such table/.test((e as Error).message) ? new NoTable() : new DeployError({ message: (e as Error).message })),
    });
