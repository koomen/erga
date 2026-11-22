// The pretend Cloudflare's D1 (dev/mock-cloudflare.ts): the few statements the deploy and `bun erga setup` run.


import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { MockState } from "./mock-cloudflare";

/**
 * The instance's record of its deploys (deploy/deployer/instance.ts), for each pretend database that has its tables:
 * a real SQLite with the migration's own tables, because the lock is one statement that only SQLite can answer.
 */
const records = new WeakMap<object, Database>();
function recordOf(db: object): Database {
  let record = records.get(db);
  if (!record) {
    record = new Database(":memory:");
    for (const name of ["0470_deploys.sql", "0480_deploy_control.sql", "0500_removed_domains.sql", "0530_setup.sql"])
      record.exec(readFileSync(new URL(`../server/migrations/${name}`, import.meta.url), "utf8"));
    records.set(db, record);
  }
  return record;
}

/** A statement D1 refuses (SQLite's error). */
export class D1Error extends Error {}

/** The few statements the deploy runs, understood well enough to answer them. */
export function d1Query(
  db: MockState["databases"][number],
  { sql, params }: { sql: string; params?: unknown[] }
): Record<string, unknown>[] {
  db.statements.push(sql.slice(0, 200));
  // (And the domains that a deploy removed, deploy/cli/remove-domain.ts, and the setup page's row,
  // server/identity/setup-link.ts: the same real SQLite.)
  const real = /CREATE TABLE/i.test(sql) ? null : /\b(deploy_(?:spec|jobs|control)|removed_domains|(?:FROM|INTO|UPDATE) setup)\b/.exec(sql);
  if (real) {
    const table = real[1] == "removed_domains" ? real[1] : real[1].endsWith(" setup") ? "setup" : "deploy_jobs";
    if (!db.tables.includes(table)) throw new D1Error(`no such table: ${table}: SQLITE_ERROR`);
    return recordOf(db)
      .query(sql)
      .all(...((params ?? []) as (string | number | null)[])) as Record<string, unknown>[];
  }
  if (/FROM sqlite_master/i.test(sql)) return db.tables.map((name) => ({ name }));
  if (/^SELECT id FROM documents/i.test(sql.trim())) {
    if (!db.tables.includes("documents")) throw new D1Error("no such table: documents: SQLITE_ERROR");
    return (db.rows ?? [])
      .map((r) => /^INSERT INTO documents \(id[^)]*\) VALUES \('([^']+)'/.exec(r)?.[1])
      .filter(Boolean)
      .map((id) => ({ id }));
  }
  if (/^SELECT name FROM d1_migrations/i.test(sql.trim())) {
    if (!db.tables.includes("d1_migrations")) throw new D1Error("no such table: d1_migrations: SQLITE_ERROR");
    return db.migrations.map((name) => ({ name }));
  }
  // The API keys, as the deploy keeps a server's own on a new copy.
  const CRED = /^INSERT INTO credentials \(([^)]+)\) VALUES \((.*)\);?$/;
  if (/^SELECT \* FROM credentials/i.test(sql.trim())) {
    if (!db.tables.includes("credentials")) throw new D1Error("no such table: credentials: SQLITE_ERROR");
    return (db.rows ?? [])
      .map((r) => CRED.exec(r))
      .filter((m) => m != null)
      .map((m) => {
        const values = [...m[2].matchAll(/'((?:[^']|'')*)'|(-?\d+)|NULL/g)].map((v) =>
          v[1] != null ? v[1].replace(/''/g, "'") : v[2] != null ? Number(v[2]) : null
        );
        return Object.fromEntries(m[1].split(",").map((c, i) => [c.trim(), values[i]]));
      });
  }
  if (/^DELETE FROM credentials$/i.test(sql.trim())) {
    db.rows = (db.rows ?? []).filter((r) => !CRED.test(r));
    return [];
  }
  // The first admin, as `bun erga setup` looks for one.
  if (/^SELECT login FROM users WHERE role = 'admin'/i.test(sql.trim()))
    return (db.rows ?? [])
      .map((r) => /^INSERT INTO users \(login, name, role, created\) VALUES \('([^']+)', '[^']*', 'admin'/.exec(r)?.[1])
      .filter(Boolean)
      .map((login) => ({ login }));
  // A row with its values as parameters (?1, ?2, ...: each once, in order), kept as the export writes it.
  const put = /^INSERT INTO (credentials|users|server_config|people|access_rules) \(([^)]+)\) VALUES \(\?/.exec(sql);
  if (put) {
    const lit = (v: unknown) => (v == null ? "NULL" : typeof v == "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
    (db.rows ??= []).push(`INSERT INTO ${put[1]} (${put[2]}) VALUES (${(params ?? []).map(lit).join(", ")});`);
    return [];
  }
  // A statement batch is all or nothing: a CREATE TABLE of one that's there fails the lot, as SQLite would.
  const made = [...sql.matchAll(/CREATE TABLE (IF NOT EXISTS )?(\w+)/gi)];
  const dropped = [...sql.matchAll(/DROP TABLE IF EXISTS (\w+)/gi)].map((m) => m[1]);
  const have = db.tables.filter((t) => !dropped.includes(t));
  for (const m of made) if (!m[1] && have.includes(m[2])) throw new D1Error(`table ${m[2]} already exists: SQLITE_ERROR`);
  db.tables = [...new Set([...have, ...made.map((m) => m[2])])];
  for (const m of sql.matchAll(/INSERT INTO d1_migrations \(name\) VALUES \('([^']+)'\)/g)) db.migrations.push(m[1]);
  return [];
}
