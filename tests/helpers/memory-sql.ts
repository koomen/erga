// In-memory SQLite for the tests: a database with the migrations D1 gets, for the tests that need the server's tables,
// and the stand-in for a Durable Object's SQLite, for the tests of an object's own tables.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { Param, Sql } from "../../server/directory/index.ts";

const MIGRATIONS = new URL("../../server/migrations/", import.meta.url).pathname;

/** A fresh in-memory database, its tables made by server/migrations/ (`before`: runs before the given migration); `db` for raw reads. */
export function memory(before?: { at: string; run: (db: Database) => void }): Sql & { db: Database } {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    if (before && name.startsWith(before.at)) before.run(db);
    db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  }
  const bind = (params: Param[]) => params as (string | number | null)[];
  return {
    db,
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
}

/** A stand-in for a Durable Object's SQLite (`exec` and `transaction`), empty: the object's code makes its tables. */
export function objectSql() {
  const db = new Database(":memory:", { strict: true });
  return {
    exec: <T>(q: string, ...p: (string | number | null | ArrayBuffer)[]) =>
      db.query(q).all(...p.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v))) as T[],
    transaction: <T>(f: () => T) => db.transaction(f)(),
  };
}
