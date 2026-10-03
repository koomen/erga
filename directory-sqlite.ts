// The document directory (directory.ts) on the local host: a SQLite file in
// the data directory (erga.db), with the same migrations D1 gets on erga.dev
// (migrations/), applied in order when the host starts and recorded as
// wrangler and cf record them (d1_migrations).

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Directory, type Param, type Sql } from "./directory";

const MIGRATIONS = new URL("./migrations/", import.meta.url).pathname;

/** Opens (or makes) the directory at `file`, bringing its tables up to date. */
export function openDirectory(file: string): { directory: Directory; close(): void } {
  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  return { directory: new Directory(sql), close: () => db.close() };
}

function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  const done = new Set((db.query("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name));
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
      db.query("INSERT INTO d1_migrations (name) VALUES (?1)").run(name);
    })();
  }
}
