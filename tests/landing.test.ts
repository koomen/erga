// The homepage project, which the deploy makes (server/documents/landing.ts, makeHome: POST /api/deploys/home): on a
// fresh database it is made from the repo's assets/landing/ once, however many ask at once, even from separate
// isolates (two Directory objects over one database), and it is the homepage; asked again, nothing; a deleted one is
// made again; a homepage an admin chose, or one the deploy locks, stays the homepage. No request for a page makes it:
// with no homepage, / is the page in the server's code. A server's homepage from before the project becomes the
// project, once (adoptLanding).

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Param, type Route, type Sql } from "../server/directory/index.ts";
import { makeHome } from "../server/documents/index.ts";
import { HOME_OWNER } from "../document/names.ts";
import type { Platform } from "../server/platform";
import { runTool, server, signedOut, type Server } from "./helpers/app";

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
  opts: { locked?: Record<string, unknown>; files?: false; made?: () => Promise<void>; asked?: string[]; read?: () => void } = {}
): Platform {
  const directory = new Directory(sql, { admins: ["root", "second"], locked: opts.locked });
  return {
    directory,
    ...(opts.files === false ? {} : { landing: { files: async () => (opts.read?.(), LANDING) } }),
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

const home = async (p: Platform) => (await p.directory.locate(HOME_OWNER, "home"))?.doc ?? null;

test("a fresh database: the deploy's step makes one homepage project, even asked many times at once from separate isolates", async () => {
  const sql = memory(), hosts = new Map();
  const isolates = [platformOn(sql, hosts), platformOn(sql, hosts), platformOn(sql, hosts)];
  const said = await Promise.all(isolates.flatMap((p) => [makeHome(p), makeHome(p), makeHome(p)]));
  // Asks at once in one isolate share an answer: one isolate made it, and the others say that it is there.
  expect([...new Set(said)].sort()).toEqual(["made", "there"]);
  expect(isolates.filter((_, i) => said[i * 3] == "made").length).toBe(1);
  const p = isolates[0];
  const doc = (await home(p))!;
  expect(doc).toMatchObject({ owner: HOME_OWNER, slug: "home", title: "Erga Homepage", kind: "project" });
  // The others deleted theirs: one document, one host.
  expect((await sql.all<{ id: string }>("SELECT id FROM documents")).map((r) => r.id)).toEqual([doc.id]);
  expect([...hosts.keys()]).toEqual([doc.id]);
  expect(hosts.get(doc.id)).toEqual(LANDING);
  // It is the homepage: the server's own write, which needs no admin.
  expect(await platformOn(sql, hosts).directory.config.get("landing_document")).toBe(doc.id);
  expect(await sql.all("SELECT updated_by FROM server_config WHERE key = 'landing_document'")).toEqual([{ updated_by: "(system)" }]);
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
  expect((await p.directory.lists.list("second")).map((d) => d.id)).toEqual([doc.id]);
  expect(await p.directory.lists.list("ada")).toEqual([]);
  expect(await p.directory.rename(doc.id, { slug: "other" }, null).catch((e) => e.message)).toContain("/_home");
  // The next deploy asks again: it is there, and the project's files (large: its fonts) aren't read for it.
  let reads = 0;
  expect(await makeHome(platformOn(sql, hosts, { read: () => reads++ }))).toBe("there");
  expect(reads).toBe(0);
});

test("two at once: the one that gets /_home keeps its project, and the other deletes its own", async () => {
  // A makes its document (at its id), and its host is slow; B makes its own meanwhile, and takes /_home.
  const sql = memory(), hosts = new Map();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const a = makeHome(platformOn(sql, hosts, { made: () => held }));
  while (hosts.size == 0) await new Promise((r) => setTimeout(r, 1));
  expect(await makeHome(platformOn(sql, hosts))).toBe("made");
  release();
  expect(await a).toBe("there");
  expect(await sql.all<{ slug: string }>("SELECT slug FROM documents")).toEqual([{ slug: "home" }]);
  expect(hosts.size).toBe(1);
});

test("a homepage from before the project becomes the project: nobody's, at /_home, its old address kept", async () => {
  const sql = memory(), hosts = new Map();
  const asked: string[] = [];
  const p = platformOn(sql, hosts, { asked });
  await p.directory.add({ id: "theirs01", owner: "root", title: "Erga", slug: "landing", slugSet: true, created: 1 });
  hosts.set("theirs01", { "index.html": "<h1>Erga</h1>" });
  await p.directory.config.set({ login: "root", admin: true }, "landing_document", "/root/landing");
  expect(await makeHome(p)).toBe("there");
  const doc = (await home(p))!;
  expect(doc).toMatchObject({ id: "theirs01", owner: HOME_OWNER, slug: "home" });
  expect(asked).toEqual(["make_project", "title Erga Homepage", "deploy"]);
  expect((await p.directory.locate("root", "landing"))?.doc.id).toBe("theirs01");
  expect(await p.directory.may({ login: "root" }, "delete", doc)).toBe(false);
  expect(await p.directory.may({ login: "second", admin: true }, "edit", doc)).toBe(true);
  expect(hosts.size).toBe(1);
});

test("a document an admin chose as the homepage stays theirs, and stays the homepage: the project is made beside it", async () => {
  const sql = memory(),
    hosts = new Map();
  const asked: string[] = [];
  const p = platformOn(sql, hosts, { asked });
  await p.directory.add({ id: "chosen01", owner: "root", title: "Mine", slug: "mine", slugSet: true, created: 1 });
  hosts.set("chosen01", { "index.html": "<h1>Mine</h1>" });
  await p.directory.config.set({ login: "root", admin: true }, "landing_document", "/root/mine");
  expect(await makeHome(p)).toBe("made");
  expect(await p.directory.landing()).toMatchObject({ id: "chosen01", owner: "root", slug: "mine" });
  expect(await home(p)).toMatchObject({ owner: HOME_OWNER });
  expect(asked).toEqual([]);
});

test("a deleted homepage project is made again, and is the homepage again; a reset setting stays reset", async () => {
  const sql = memory(), hosts = new Map();
  const p = platformOn(sql, hosts);
  await makeHome(p);
  const first = (await home(p))!;
  // Gone: no homepage until the next deploy.
  await p.docs.delete(first);
  expect(await platformOn(sql, hosts).directory.landing()).toBeNull();
  expect(await makeHome(platformOn(sql, hosts))).toBe("made");
  const q = platformOn(sql, hosts);
  const second = (await home(q))!;
  expect(second.id).not.toBe(first.id);
  expect(await q.directory.config.get("landing_document")).toBe(second.id);
  expect(hosts.get(second.id)).toEqual(LANDING);

  // An admin resets the setting: no homepage. The project stays where it is, and a deploy changes nothing.
  await q.directory.config.reset({ login: "root", admin: true }, "landing_document");
  const r = platformOn(sql, hosts);
  expect(await makeHome(r)).toBe("there");
  expect(await r.directory.landing()).toBeNull();
  expect((await home(r))?.id).toBe(second.id);
  expect(hosts.size).toBe(1);
});

test("a locked setting stays as the deploy fixed it; a server with no landing files makes nothing", async () => {
  const sql = memory(), hosts = new Map();
  const locked = platformOn(sql, hosts, { locked: { landing_document: "/root/elsewhere" } });
  expect(await makeHome(locked)).toBe("made");
  expect(await locked.directory.config.get("landing_document")).toBe("/root/elsewhere");
  expect(await sql.all("SELECT key FROM server_config")).toEqual([]);
  const bare = memory(),
    none = new Map();
  expect(await makeHome(platformOn(bare, none, { files: false }))).toBe("none");
  expect(none.size).toBe(0);
});

// The ones below run on the whole app in memory (tests/helpers/app.ts): over HTTP, as a deploy asks and as people see it.

/** The deploy's step, over HTTP: what the server says it did. */
const deployHome = async (s: Server) => ((await (await s.fetch("/api/deploys/home", { method: "POST" })).json()) as { home: string }).home;
/** / as someone signed out sees it. */
const front = async (s: Server) => (await s.fetch("/", { headers: signedOut() })).text();
/** The document / shows to someone signed out (the viewer's frame names it). */
const docOnFront = async (s: Server) => /<meta name="erga-doc" content="([a-z0-9]{8})">/.exec(await front(s))?.[1];

test("no request for a page makes a homepage: / is the page in the server's code until the deploy's step, then the homepage project", async () => {
  const s = server();
  const plain = await front(s);
  expect(plain).toContain("<h1>Erga is an AI document editor for people who care about every word</h1>");
  expect(plain).toContain('<a class="go" href="/auth/sign-in?next=%2Fdocs">Sign in</a>');
  expect((await s.fetch("/_home")).status).toBe(404);
  expect(await s.platform.directory.landing()).toBeNull();
  // The deploy asks: made, from the landing project's files. Asked again: it is there.
  expect(await deployHome(s)).toBe("made");
  expect(await deployHome(s)).toBe("there");
  const id = await docOnFront(s);
  expect(id).toBeTruthy();
  expect(await (await s.fetch(`/d/${id}/doc/index.html`)).text()).toBe((await s.platform.landing!.files())["index.html"] as string);
  // Nobody's: an admin can't delete it.
  const del = await runTool(s, "delete_document", { document: "/_home" });
  expect(del.status).toBe(403);
  expect(await docOnFront(s)).toBe(id);
  // The setting reset: no homepage is assigned, so / is the page in the server's code again. The project stays.
  await runTool(s, "set_setting", { key: "landing_document", reset: true });
  expect(await front(s)).toContain('<a class="go" href="/auth/sign-in?next=%2Fdocs">Sign in</a>');
  expect((await s.fetch("/_home")).status).toBe(200);
  // An admin chooses the homepage project again, by its address.
  expect((await runTool(s, "set_setting", { key: "landing_document", value: "/_home" })).error).toBeUndefined();
  expect(await docOnFront(s)).toBe(id);
});

test("rename_document renames the homepage project for an admin, and refuses a new address", async () => {
  const s = server();
  await deployHome(s);
  const id = await docOnFront(s);
  const r = await runTool(s, "rename_document", { document: id, title: "Home, renamed" });
  expect(r.error).toBeUndefined();
  expect(r.result).toMatchObject({ title: "Home, renamed", address: "/_home" });
  const listed = (await runTool(s, "list_documents", { query: "Home, renamed" })).result as { address: string; url?: string }[];
  expect(listed.map((d) => [d.address, d.url && new URL(d.url).pathname])).toEqual([["/_home", "/_home"]]);
  const slug = await runTool(s, "rename_document", { document: id, slug: "other" });
  expect(slug.error).toMatch(/\/_home/);
});
