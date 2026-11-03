// The homepage the server makes for itself: on a
// fresh database the first request makes the homepage project from the
// repo's assets/landing/ once, however many ask at once, even from separate
// isolates (two Directory objects over one database); a deleted one is made
// again; one an admin chose, or one the deploy locks, is left alone. A server's
// homepage from before the project becomes the project, once (adoptLanding).

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Param, type Route, type Sql } from "../server/directory/index.ts";
import { landingDocument } from "../server/documents/index.ts";
import { HOME_OWNER } from "../document/names.ts";
import type { Platform } from "../server/platform";

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
function platformOn(
  sql: Sql,
  hosts: Map<string, Record<string, string | Uint8Array>>,
  opts: { locked?: Record<string, unknown>; owner?: string | null; made?: () => Promise<void>; asked?: string[] } = {}
): Platform {
  const directory = new Directory(sql, { admins: ["root", "second"], locked: opts.locked });
  return {
    directory,
    landing: { files: LANDING, owner: opts.owner === undefined ? "root" : opts.owner },
    templates: { doc: { "index.html": "<h1>Untitled</h1>" } },
    docs: {
      create: async (doc: Route, files: Record<string, string | Uint8Array>) => { if (hosts.has(doc.id)) return false; hosts.set(doc.id, files); await opts.made?.(); return true; },
      index: async (doc: Route) => (hosts.has(doc.id) ? "index.html" : null),
      delete: async (doc: Route) => {
        if (!hosts.delete(doc.id)) return false;
        await directory.remove(doc.id);
        return true;
      },
      treeOp: async (_doc: Route, op: { op: string }) => {
        opts.asked?.push(op.op);
        return { ok: true };
      },
      rename: async (doc: Route, _by: unknown, patch: { title: string }) => {
        opts.asked?.push(`title ${patch.title}`);
        await directory.rename(doc.id, patch, null);
        return { ok: true };
      },
    },
    home: {
      deploy: async () => {
        opts.asked?.push("deploy");
      },
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
  expect(doc).toMatchObject({ owner: HOME_OWNER, slug: "home", title: "Erga Homepage", kind: "project" });
  // Losers deleted theirs: one document, one host.
  expect((await sql.all<{ id: string }>("SELECT id FROM documents")).map((r) => r.id)).toEqual([doc.id]);
  expect([...hosts.keys()]).toEqual([doc.id]);
  expect(hosts.get(doc.id)).toEqual(LANDING);
  const p = isolates[0];
  expect(await p.directory.config.get("landing_document")).toBe(doc.id);
  // Nobody owns it: every admin may edit it, and nobody may delete or share it; anyone else signed in views it.
  expect(await p.directory.may({ login: "root", admin: true }, "edit", doc)).toBe(true);
  expect(await p.directory.may({ login: "second", admin: true }, "edit", doc)).toBe(true);
  expect(await p.directory.may({ login: "root", admin: true }, "delete", doc)).toBe(false);
  expect(await p.directory.may({ login: "root", admin: true }, "share", doc)).toBe(false);
  // Only with admin power (not through a documents token): the homepage's scripts run on the site itself.
  expect(await p.directory.may({ login: "second" }, "edit", doc)).toBe(false);
  expect(await p.directory.may({ login: "second" }, "open", doc)).toBe(true);
  expect(await p.directory.may({ login: "ada" }, "edit", doc)).toBe(false);
  expect(await p.directory.may({ login: "ada" }, "open", doc)).toBe(true);
  // It's on every admin's list, and only theirs; its address is /_home and stays so.
  expect((await p.directory.list("second")).map((d) => d.id)).toEqual([doc.id]);
  expect(await p.directory.list("ada")).toEqual([]);
  expect(await p.directory.rename(doc.id, { slug: "other" }, null).catch((e) => e.message)).toContain("/_home");
  // Asked again, it's the same one.
  expect((await landingDocument(platformOn(sql, hosts)))?.id).toBe(doc.id);
});

test("two seeds at once: the winner is at /_home even when the loser made its document first", async () => {
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
  expect(b.slug).toBe("home");
  expect(await sql.all<{ id: string; slug: string }>("SELECT id, slug FROM documents")).toEqual([{ id: b.id, slug: "home" }]);
  expect([...hosts.keys()]).toEqual([b.id]);
});

test("a homepage from before the project becomes the project: nobody's, at /_home, its old address kept", async () => {
  const sql = memory(), hosts = new Map();
  const asked: string[] = [];
  const p = platformOn(sql, hosts, { asked });
  await p.directory.add({ id: "theirs01", owner: "root", title: "Erga", slug: "landing", slugSet: true, created: 1 });
  hosts.set("theirs01", { "index.html": "<h1>Erga</h1>" });
  await p.directory.config.set({ login: "root", admin: true }, "landing_document", "/root/landing");
  const doc = (await landingDocument(p))!;
  expect(doc).toMatchObject({ id: "theirs01", owner: HOME_OWNER, slug: "home" });
  expect(asked).toEqual(["make_project", "title Erga Homepage", "deploy"]);
  expect((await p.directory.locate("root", "landing"))?.doc.id).toBe("theirs01");
  expect(await p.directory.may({ login: "root" }, "delete", doc)).toBe(false);
  expect(await p.directory.may({ login: "second", admin: true }, "edit", doc)).toBe(true);
  expect(hosts.size).toBe(1);
});

test("a document an admin chose as the homepage stays theirs: only the homepage the server made before is adopted", async () => {
  const sql = memory(),
    hosts = new Map();
  const asked: string[] = [];
  const p = platformOn(sql, hosts, { asked });
  await p.directory.add({ id: "chosen01", owner: "root", title: "Mine", slug: "mine", slugSet: true, created: 1 });
  hosts.set("chosen01", { "index.html": "<h1>Mine</h1>" });
  await p.directory.config.set({ login: "root", admin: true }, "landing_document", "/root/mine");
  expect(await landingDocument(p)).toMatchObject({ id: "chosen01", owner: "root", slug: "mine" });
  expect(asked).toEqual([]);
});

test("a deleted landing document is made again; an admin's choice stays", async () => {
  const sql = memory(), hosts = new Map();
  const p = platformOn(sql, hosts);
  const first = (await landingDocument(p))!;
  await p.docs.delete(first);
  const second = (await landingDocument(platformOn(sql, hosts)))!;
  expect(second.id).not.toBe(first.id);
  expect(second.slug).toBe("home");
  expect(await platformOn(sql, hosts).directory.config.get("landing_document")).toBe(second.id);

  // root chooses another of theirs: it's the homepage, and nothing is made.
  await p.directory.add({ id: "chosen01", owner: "root", title: "Mine", created: 1 });
  hosts.set("chosen01", { "index.html": "<h1>Mine</h1>" });
  await p.directory.config.set({ login: "root", admin: true }, "landing_document", "/root/mine");
  const q = platformOn(sql, hosts);
  expect((await landingDocument(q))?.id).toBe("chosen01");
  expect(hosts.size).toBe(2);

  // Reset (unset), it's made again: a fresh copy of assets/landing/, at /_home. The one before is root's now, at its id.
  await q.directory.config.reset({ login: "root", admin: true }, "landing_document");
  const third = (await landingDocument(platformOn(sql, hosts)))!;
  expect(third.id).not.toBe(second.id);
  expect(third).toMatchObject({ owner: HOME_OWNER, slug: "home" });
  expect(hosts.get(third.id)).toEqual(LANDING);
  expect(await q.directory.get(second.id)).toMatchObject({ owner: "root", slug: second.id });
});

test("a locked setting, or nobody to own it, makes nothing", async () => {
  const sql = memory(), hosts = new Map();
  expect(await landingDocument(platformOn(sql, hosts, { locked: { landing_document: "/root/elsewhere" } }))).toBeNull();
  expect(await landingDocument(platformOn(sql, hosts, { owner: null }))).toBeNull();
  expect(hosts.size).toBe(0);
});
