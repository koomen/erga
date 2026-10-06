// The fixes from the audit of how secrets are stored and handled (docs/secrets.md): each test
// stands for one way a secret could leak or be used where it shouldn't.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import type { Param, Sql } from "../directory";
import { Tokens } from "../tokens";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

function memory(): Sql {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  return {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
}

test("an agent token works only on the server whose secret made it, not on a copy of its database (staging's)", async () => {
  const sql = memory();
  const production = new Tokens(sql, "production-secret-".repeat(3)), staging = new Tokens(sql, "staging-secret-".repeat(3));
  const { token } = await production.mint({ login: "ada", name: "Ada" }, "Claude Code");
  expect((await production.verify(token))?.login).toBe("ada");
  // Staging holds the same rows (its database is a copy of production's), but not production's secret.
  expect(await staging.verify(token)).toBeNull();
  // Its own tokens still work there.
  const own = await staging.mint({ login: "ada", name: "Ada" }, "Claude Code");
  expect((await staging.verify(own.token))?.login).toBe("ada");
  expect(await production.verify(own.token)).toBeNull();
});
