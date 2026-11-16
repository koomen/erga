// The default homepage, which the deploy makes (server/documents/landing.ts, makeHome: POST /api/deploys/home): on a
// fresh database it is made from the repo's assets/landing/ once, however many ask at once, even from separate
// isolates (two Directory objects over one database), and published to the Erga domain; asked again, nothing; a deleted
// one is made again; a later deploy never changes what is published. No request for a page makes it: with nothing
// published, / answers with nothing.

import { expect, test } from "bun:test";
import { Directory, type Param, type Route, type Sql } from "../server/directory/index.ts";
import { makeHome } from "../server/documents/index.ts";
import { HOME_OWNER } from "../document/model/names.ts";
import type { Platform } from "../server/platform";
import { runTool, server, signedOut, type Server } from "./helpers/app";
import { memory as steady } from "./helpers/memory-sql";
import { until } from "./helpers/until";

const LANDING = { "index.html": "<!doctype html><title>Erga</title><h1>Erga</h1>" };

/**
 * The database, where each call waits a short random time first: requests at once interleave as they would against D1.
 * Without the wait the calls go in one fixed order, and a claim of the setting that does not compare passes the first test.
 */
function memory(): Sql {
  const sql = steady();
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
  return {
    all: async <T>(q: string, ...params: Param[]) => {
      await tick();
      return sql.all<T>(q, ...params);
    },
    run: async (q, ...params) => {
      await tick();
      await sql.run(q, ...params);
    },
    batch: async (statements) => {
      await tick();
      await sql.batch(statements);
    },
  };
}

/** A platform on `sql`: its own Directory (as an isolate has), document hosts in `hosts`. */
function platformOn(
  sql: Sql,
  hosts: Map<string, Record<string, string | Uint8Array>>,
  opts: { files?: false; made?: () => Promise<void>; asked?: string[]; read?: () => void; claimed?: string } = {}
): Platform {
  const directory = new Directory(sql, { admins: ["root", "second"] });
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
    },
    // The Erga domain's site object: `claimed`: another document has the domain.
    site: () => ({
      link: async (o: { doc: string; replace: boolean }) => {
        if (opts.claimed && !o.replace) return { refused: { claimed: opts.claimed } };
        opts.asked?.push(`link ${o.doc}`);
        return {};
      },
      publish: async (doc: string, by: string) => {
        opts.asked?.push(`publish ${doc} by ${by}`);
        return {};
      },
    }),
  } as unknown as Platform;
}

const home = async (p: Platform) => (await p.directory.locate(HOME_OWNER, "home"))?.doc ?? null;

test("a fresh database: the deploy's step makes one default homepage, and publishes it, even asked many times at once from separate isolates", async () => {
  const sql = memory(), hosts = new Map();
  const asked: string[] = [];
  const isolates = [platformOn(sql, hosts, { asked }), platformOn(sql, hosts, { asked }), platformOn(sql, hosts, { asked })];
  const said = await Promise.all(isolates.flatMap((p) => [makeHome(p), makeHome(p), makeHome(p)]));
  // Asks at once in one isolate share an answer: one isolate made it, and the others say that it is there.
  expect([...new Set(said)].sort()).toEqual(["made", "there"]);
  expect(isolates.filter((_, i) => said[i * 3] == "made").length).toBe(1);
  const p = isolates[0];
  const doc = (await home(p))!;
  expect(doc).toMatchObject({ owner: HOME_OWNER, slug: "home", title: "Erga Homepage" });
  // The others deleted theirs: one document, one host.
  expect((await sql.all<{ id: string }>("SELECT id FROM documents")).map((r) => r.id)).toEqual([doc.id]);
  expect([...hosts.keys()]).toEqual([doc.id]);
  expect(hosts.get(doc.id)).toEqual(LANDING);
  // The one that made it links it to the Erga domain and publishes it, as the system: it needs no admin.
  expect(asked).toEqual([`link ${doc.id}`, `publish ${doc.id} by the system`]);
  // Nobody owns it: every admin may edit it, and nobody may delete or share it; anyone else signed in views it.
  expect(await p.directory.may({ login: "root", admin: true }, "edit", doc)).toBe(true);
  expect(await p.directory.may({ login: "second", admin: true }, "edit", doc)).toBe(true);
  expect(await p.directory.may({ login: "root", admin: true }, "delete", doc)).toBe(false);
  expect(await p.directory.may({ login: "root", admin: true }, "share", doc)).toBe(false);
  // Only with admin power (not through a documents token).
  expect(await p.directory.may({ login: "second" }, "edit", doc)).toBe(false);
  expect(await p.directory.may({ login: "second" }, "open", doc)).toBe(true);
  expect(await p.directory.may({ login: "ada" }, "edit", doc)).toBe(false);
  expect(await p.directory.may({ login: "ada" }, "open", doc)).toBe(true);
  // It's on every admin's list, and only theirs; its address is /_home and stays so.
  expect((await p.directory.lists.list("second")).map((d) => d.id)).toEqual([doc.id]);
  expect(await p.directory.lists.list("ada")).toEqual([]);
  expect(await p.directory.rename(doc.id, { slug: "other" }, null).catch((e) => e.message)).toContain("/_home");
  // The next deploy asks again: it is there, nothing is published again, and the project's files (large: its fonts)
  // aren't read for it.
  let reads = 0;
  expect(await makeHome(platformOn(sql, hosts, { asked, read: () => reads++ }))).toBe("there");
  expect(reads).toBe(0);
  expect(asked.length).toBe(2);
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

test("a deleted default homepage is made again; a domain that another document has stays its own; no landing files, nothing", async () => {
  const sql = memory(), hosts = new Map();
  const p = platformOn(sql, hosts);
  await makeHome(p);
  const first = (await home(p))!;
  await p.docs.delete(first);
  // An admin published another document to the Erga domain meanwhile: the new /_home is made, and not published.
  const asked: string[] = [];
  expect(await makeHome(platformOn(sql, hosts, { asked, claimed: "theirs01" }))).toBe("made");
  const second = (await home(platformOn(sql, hosts)))!;
  expect(second.id).not.toBe(first.id);
  expect(hosts.get(second.id)).toEqual(LANDING);
  expect(asked).toEqual([]);
  const bare = memory(),
    none = new Map();
  expect(await makeHome(platformOn(bare, none, { files: false }))).toBe("none");
  expect(none.size).toBe(0);
});

// The ones below run on the whole app in memory (tests/helpers/app.ts): over HTTP, as a deploy asks and as people see it.

/** The deploy's step, over HTTP: what the server says it did. */
const deployHome = async (s: Server) => ((await (await s.fetch("/api/deploys/home", { method: "POST" })).json()) as { home: string }).home;
/** / as someone signed out gets it: its status and its text. */
const front = async (s: Server) => {
  const r = await s.fetch("/", { headers: signedOut() });
  return [r.status, await r.text()] as const;
};
/** The Erga domain's state. */
const erga = (s: Server) => s.platform.site("").status();

test("no request for a page makes a homepage: / answers with nothing until the deploy's step, then the default homepage; a later deploy changes nothing", async () => {
  const s = server();
  expect(await front(s)).toEqual([404, ""]);
  expect((await s.fetch("/_home")).status).toBe(404);
  // Someone signed out who goes to /documents is sent to sign in.
  const docs = await s.fetch("/documents", { headers: signedOut() });
  expect([docs.status, docs.headers.get("location")]).toEqual([302, "/auth/sign-in?next=%2Fdocuments"]);
  // The deploy asks: made, from the landing project's files, and published. Asked again: it is there.
  expect(await deployHome(s)).toBe("made");
  await until(async () => (await erga(s)).state == "published");
  expect(await deployHome(s)).toBe("there");
  const id = (await erga(s)).doc!;
  const [status, html] = await front(s);
  expect(status).toBe(200);
  expect(html).toContain("<h1>Erga</h1>");
  // The header bar is on at first: Erga's controls are on the page.
  expect(html).toContain("<erga-controls");
  expect(await (await s.fetch(`/d/${id}/doc/index.html`)).text()).toBe((await s.platform.landing!.files())["index.html"] as string);
  // Nobody's: an admin can't delete it.
  expect((await runTool(s, "delete_document", { document: "/_home" })).status).toBe(403);
  // An admin sets it to "Not published": / answers with nothing at once, the project stays, and the next deploy leaves it so.
  expect((await runTool(s, "set_publishing", { document: "/_home", domain: "" })).error).toBeUndefined();
  expect(await front(s)).toEqual([404, ""]);
  expect((await s.fetch("/_home")).status).toBe(200);
  expect(await deployHome(s)).toBe("there");
  expect((await erga(s)).state).toBe("free");
  expect(await front(s)).toEqual([404, ""]);
});

test("rename_document renames the default homepage for an admin, and refuses a new address", async () => {
  const s = server();
  await deployHome(s);
  const id = (await erga(s)).doc!;
  const r = await runTool(s, "rename_document", { document: id, title: "Home, renamed" });
  expect(r.error).toBeUndefined();
  expect(r.result).toMatchObject({ title: "Home, renamed", address: "/_home" });
  const listed = (
    (await runTool(s, "list_documents", { query: "Home, renamed" })).result as { documents: { address: string; url?: string }[] }
  ).documents;
  expect(listed.map((d) => [d.address, d.url && new URL(d.url).pathname])).toEqual([["/_home", "/_home"]]);
  const slug = await runTool(s, "rename_document", { document: id, slug: "other" });
  expect(slug.error).toMatch(/\/_home/);
});
