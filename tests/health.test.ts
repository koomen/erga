// The app's health check (server/health.ts): what it checks, and how it says what's wrong.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Param, type Sql } from "../server/directory";
import { health } from "../server/health";
import type { Platform } from "../server/platform";

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;

function directory(): Directory {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  return new Directory(sql, { admins: ["ada"] });
}

const platform = (dir: Directory, exists: (id: string) => Promise<boolean>): Platform => ({
  directory: dir, deploy: { target: "staging", version: "abcdef123456", hookSecret: "", originOf: () => "" },
  docs: { exists: async (doc: { id: string }) => exists(doc.id) },
} as unknown as Platform);

test("healthy: the database answers and the homepage's document opens; with no homepage, nothing to open and still healthy", async () => {
  const dir = directory();
  let h = await health(platform(dir, async () => true));
  expect(h).toMatchObject({ ok: true, version: "abcdef123456", target: "staging", checks: { db: { ok: true }, documents: { ok: true, note: "no homepage document: nothing to open" } } });
  expect(h.checks.db.ms).toBeGreaterThanOrEqual(0);
  const { doc } = await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Home", created: 1 });
  await dir.config.set({ login: "ada", admin: true }, "landing_document", doc.id);
  const opened: string[] = [];
  h = await health(platform(dir, async (id) => { opened.push(id); return true; }));
  expect(h.ok).toBe(true);
  expect(h.checks.documents).toMatchObject({ ok: true });
  expect(opened).toEqual([doc.id]);
});

test("unhealthy: a document that doesn't open, or a database that throws, fails its check and the report, with the reason", async () => {
  const dir = directory();
  const { doc } = await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Home", created: 1 });
  await dir.config.set({ login: "ada", admin: true }, "landing_document", doc.id);
  let h = await health(platform(dir, async () => false));
  expect(h).toMatchObject({ ok: false, checks: { db: { ok: true }, documents: { ok: false, error: `the homepage document ${doc.id} has no host` } } });
  h = await health(platform(dir, async () => { throw new Error("Durable Object reset"); }));
  expect(h.checks.documents).toMatchObject({ ok: false, error: "Durable Object reset" });
  const broken = { ...platform(dir, async () => true), directory: { ...dir, config: { get: async () => { throw new Error("D1_ERROR: no such table: server_config"); } }, homeId: () => dir.homeId(), route: (id: string) => dir.route(id) } } as unknown as Platform;
  h = await health(broken);
  expect(h.ok).toBe(false);
  expect(h.checks.db).toMatchObject({ ok: false, error: "D1_ERROR: no such table: server_config" });
});
