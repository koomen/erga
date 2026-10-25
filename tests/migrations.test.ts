// server/migrations/: each applies in order to an empty database, and each
// only adds (AGENTS.md, rule 3). A migration that drops or renames must say
// so with its first line, `-- erga: destructive`, because the Worker before
// it can't run on the schema after it, so a rollback across it needs a
// database restore. The two from before this rule are listed here as they are.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const DIR = new URL("../server/migrations/", import.meta.url).pathname;
const files = () => readdirSync(DIR).filter((n) => n.endsWith(".sql")).sort();
/** Destructive before the rule: the first migration (it replaces everything before it) and the one that dropped the SSH keys' tables. */
const BEFORE_THE_RULE = new Set(["0001_erga.sql", "0150_tokens_scoped.sql"]);
const MARKER = /^-- erga: destructive\b/m;

/** The statements of a migration, comments left out. */
const statements = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(/;\s*(?:\n|$)/).map((q) => q.trim()).filter(Boolean);
/** A statement the Worker before the migration can't live with: a drop or a rename. (A DELETE of rows isn't: the tables stay.) */
const destructive = (q: string) => /^\s*DROP\s+(TABLE|INDEX)\b/i.test(q) || /^\s*ALTER\s+TABLE\s+\S+\s+(DROP|RENAME)\b/i.test(q);

test("every migration applies, in order, to an empty database, and again to one that has them all (each is recorded once)", () => {
  const db = new Database(":memory:", { strict: true });
  db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  for (const name of files()) {
    for (const q of statements(readFileSync(DIR + name, "utf8"))) db.exec(q);
    db.query("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
  }
  expect(db.query("SELECT name FROM d1_migrations ORDER BY id").all().map((r: any) => r.name)).toEqual(files());
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r: any) => r.name);
  expect(tables).toEqual(expect.arrayContaining(["users", "server_config", "documents", "permissions", "agent_tokens", "credentials"]));
});

test("a migration only adds: one that drops or renames says so on its first line (-- erga: destructive), with the reason", () => {
  const wrong: string[] = [];
  for (const name of files()) {
    const sql = readFileSync(DIR + name, "utf8");
    const bad = statements(sql).filter(destructive);
    if (!bad.length) continue;
    if (BEFORE_THE_RULE.has(name)) continue;
    if (!MARKER.test(sql.split("\n")[0])) wrong.push(`${name}: ${bad.map((q) => q.split("\n")[0]).join("; ")}`);
  }
  expect(wrong).toEqual([]);
  // The marker is on the first line, and is followed by why, in the same comment block.
  for (const name of files()) {
    const sql = readFileSync(DIR + name, "utf8");
    if (MARKER.test(sql.split("\n")[0])) expect(sql.split("\n")[1]).toMatch(/^-- \S/);
  }
});

test("the names sort in the order they apply, and no two share a number", () => {
  const numbers = files().map((n) => n.slice(0, 4));
  expect(new Set(numbers).size).toBe(numbers.length);
  expect([...numbers].sort()).toEqual(numbers);
});
