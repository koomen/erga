// The front page the server makes for itself (front.ts, seedLanding): on a
// fresh database the first request makes the landing document from the
// repo's landing/ once, however many ask at once, even from separate
// isolates (two Directory objects over one database); a deleted one is made
// again; one an admin chose, or one the deploy locks, is left alone.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Param, type Route, type Sql } from "../server/directory";
import { landingDocument, type Platform } from "../server/routes";

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;
const LANDING = { "index.html": "<!doctype html><title>Erga</title><h1>Erga</h1>" };

function memory(): Sql {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  // Each call yields first, so requests at once interleave as they would against D1.
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
  return {
    all: async <T>(q: string, ...params: Param[]) => { await tick(); return db.query(q).all(...bind(params)) as T[]; },
    run: async (q, ...params) => { await tick(); db.query(q).run(...bind(params)); },
    batch: async (statements) => { await tick(); db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
}

/** A platform on `sql`: its own Directory (as an isolate has), document hosts in `hosts`. */
function platformOn(sql: Sql, hosts: Map<string, Record<string, string | Uint8Array>>, opts: { locked?: Record<string, unknown>; owner?: string | null; made?: () => Promise<void> } = {}): Platform {
  const directory = new Directory(sql, { admins: ["root", "second"], locked: opts.locked });
  return {
    directory,
    landing: { files: LANDING, owner: opts.owner === undefined ? "root" : opts.owner, editors: ["second"] },
    templates: { doc: { "index.html": "<h1>Untitled</h1>" } },
    docs: {
      create: async (doc: Route, files: Record<string, string | Uint8Array>) => { if (hosts.has(doc.id)) return false; hosts.set(doc.id, files); await opts.made?.(); return true; },
      exists: async (doc: Route) => hosts.has(doc.id),
      index: async (doc: Route) => (hosts.has(doc.id) ? "index.html" : null),
      delete: async (doc: Route) => { if (!hosts.delete(doc.id)) return false; await directory.remove(doc.id); return true; },
    },
  } as unknown as Platform;
}

test("a fresh database: the first requests make one landing document, even from separate isolates", async () => {
  const sql = memory(), hosts = new Map();
  const isolates = [platformOn(sql, hosts), platformOn(sql, hosts), platformOn(sql, hosts)];
  const docs = await Promise.all(isolates.flatMap((p) => [landingDocument(p), landingDocument(p), landingDocument(p)]));
  const ids = new Set(docs.map((d) => d?.id));
  expect(ids.size).toBe(1);
  const doc = docs[0]!;
  expect(doc).toMatchObject({ owner: "root", slug: "landing", title: "Erga" });
  // Losers deleted theirs: one document, one host.
  expect((await sql.all<{ id: string }>("SELECT id FROM documents")).map((r) => r.id)).toEqual([doc.id]);
  expect([...hosts.keys()]).toEqual([doc.id]);
  expect(hosts.get(doc.id)).toEqual(LANDING);
  const p = isolates[0];
  expect(await p.directory.config.get("landing_document")).toBe(doc.id);
  // Its owner may edit it, and so may the other bootstrap admins; anyone else only sees it on /.
  expect(await p.directory.may({ login: "root", admin: true }, "edit", doc)).toBe(true);
  expect(await p.directory.may({ login: "second", admin: true }, "edit", doc)).toBe(true);
  // Only with admin power (not through a documents token): the front page's scripts run on the site itself.
  expect(await p.directory.may({ login: "second" }, "edit", doc)).toBe(false);
  expect(await p.directory.may({ login: "second" }, "open", doc)).toBe(true);
  expect(await p.directory.may({ login: "ada" }, "edit", doc)).toBe(false);
  // Asked again, it's the same one.
  expect((await landingDocument(platformOn(sql, hosts)))?.id).toBe(doc.id);
});

test("two seeds at once: the winner is at /<owner>/landing even when the loser made its document first", async () => {
  // The ordering that gave the winner "landing-2": A makes its document, then B makes its own and claims the setting
  // while A still holds its document; A loses the claim and deletes its document.
  const sql = memory(), hosts = new Map();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const a = landingDocument(platformOn(sql, hosts, { made: () => held }));
  while (hosts.size == 0) await new Promise((r) => setTimeout(r, 1));
  const b = (await landingDocument(platformOn(sql, hosts)))!;
  release();
  expect((await a)?.id).toBe(b.id);
  expect(b.slug).toBe("landing");
  expect((await sql.all<{ id: string; slug: string }>("SELECT id, slug FROM documents"))).toEqual([{ id: b.id, slug: "landing" }]);
  expect([...hosts.keys()]).toEqual([b.id]);
});

test("a document of the owner's already at landing: the made one is at landing-2", async () => {
  const sql = memory(), hosts = new Map();
  const p = platformOn(sql, hosts);
  await p.directory.add({ id: "theirs01", owner: "root", title: "Mine", slug: "landing", slugSet: true, created: 1 });
  hosts.set("theirs01", { "index.html": "<h1>Mine</h1>" });
  expect((await landingDocument(p))?.slug).toBe("landing-2");
});

test("a deleted landing document is made again; an admin's choice stays", async () => {
  const sql = memory(), hosts = new Map();
  const p = platformOn(sql, hosts);
  const first = (await landingDocument(p))!;
  await p.docs.delete(first);
  const second = (await landingDocument(platformOn(sql, hosts)))!;
  expect(second.id).not.toBe(first.id);
  expect(second.slug).toBe("landing");
  expect(await platformOn(sql, hosts).directory.config.get("landing_document")).toBe(second.id);

  // root chooses another of theirs: it's the front page, and nothing is made.
  await p.directory.add({ id: "chosen01", owner: "root", title: "Mine", created: 1 });
  hosts.set("chosen01", { "index.html": "<h1>Mine</h1>" });
  await p.directory.config.set({ login: "root", admin: true }, "landing_document", "/root/mine");
  const q = platformOn(sql, hosts);
  expect((await landingDocument(q))?.id).toBe("chosen01");
  expect(hosts.size).toBe(2);

  // Reset (unset), it's made again: a fresh copy of landing/.
  await q.directory.config.reset({ login: "root", admin: true }, "landing_document");
  const third = (await landingDocument(platformOn(sql, hosts)))!;
  expect(third.id).not.toBe(second.id);
  expect(hosts.get(third.id)).toEqual(LANDING);
});

test("a locked setting, or nobody to own it, makes nothing", async () => {
  const sql = memory(), hosts = new Map();
  expect(await landingDocument(platformOn(sql, hosts, { locked: { landing_document: "/root/elsewhere" } }))).toBeNull();
  expect(await landingDocument(platformOn(sql, hosts, { owner: null }))).toBeNull();
  expect(hosts.size).toBe(0);
});
