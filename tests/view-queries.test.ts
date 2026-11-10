// How many times a document's view asks the database (server/documents/view.ts): a reader's options come with the
// document's row, a view kept a moment ago asks nothing (a public document's too), and the session and the row are
// asked for at the same time.

import { expect, test } from "bun:test";
import { Directory, type Param, type Sql } from "../server/directory/index.ts";
import { documentRoutes, forgetDecisions } from "../server/documents/index.ts";
import { respond } from "../server/http.ts";
import type { Platform, Session } from "../server/platform.ts";
import { memory } from "./helpers/memory-sql";

/** A server with a quiet document of ada's (`id`, its own address in each test: the views kept are the module's), which bo views; its database counts its reads. */
async function server(id: string) {
  const sql = memory();
  const seen = { reads: 0, queries: [] as string[] };
  const counted: Sql = { ...sql, all: <T>(q: string, ...p: Param[]) => (seen.reads++, seen.queries.push(q), sql.all<T>(q, ...p)) };
  const dir = new Directory(counted, { admins: ["root"], defaults: { public_sharing: true } });
  const root = { login: "root", admin: true };
  for (const login of ["ada", "bo"]) await dir.users.add(root, login);
  const { doc } = await dir.add({ id, owner: "ada", title: `Plan ${id}`, created: 1, expires: null });
  await dir.share({ login: "ada" }, doc.id, "bo", "viewer");
  let session: (request: Request) => Promise<Session | null> = async (request) => {
    const login = new URL(request.url).searchParams.get("user");
    return login && (await dir.users.signedIn(login)) ? { login, name: login } : null;
  };
  const platform = {
    sessionOf: (request: Request) => session(request),
    directory: dir,
    secret: "secret-".repeat(6),
    dev: () => false,
    pagesDomain: () => "erga-pages.test",
    edge: { cache: null, background: (work: Promise<unknown>) => void work.catch(() => {}) },
    docs: {
      // The document's host decides on its own copy of the permissions: no question to the database.
      view: async (_id: string, who: { login: string } | null) => ({
        role: !who || who.login == "bo" ? "viewer" : null,
        name: null,
        test: false,
        ver: "v1",
        file: "index.html",
        canonical: "",
        quiet: true,
      }),
    },
  } as unknown as Platform;
  const view = (path: string) => respond(documentRoutes, new Request(`https://erga.test${path}`), platform);
  return {
    seen,
    dir,
    doc,
    view,
    root,
    sessionIs: (f: typeof session) => {
      session = f;
    },
  };
}

test("a reader's view asks for the document one time, and a second view a moment later asks nothing", async () => {
  const { seen, dir, doc, view } = await server("viewone1");
  await dir.setReaderOption(doc.id, "bars", false);
  // bo's account and the settings are remembered from another page.
  await dir.users.signedIn("bo");
  seen.reads = 0;
  const first = await view(`/ada/${doc.slug}?user=bo`);
  expect([first.status, seen.reads]).toEqual([200, 1]);
  // The owner's options for readers came with the row: no bars.
  expect((await first.text()).includes("--band-h: 0px")).toBe(true);
  seen.reads = 0;
  expect([(await view(`/ada/${doc.slug}?user=bo`)).status, seen.reads]).toEqual([200, 0]);
});

test("a public document's view is kept a moment: the second one asks nothing, until its sharing changes", async () => {
  const { seen, dir, doc, view, root } = await server("viewtwo2");
  expect((await view(`/ada/${doc.slug}`)).status).toBe(302);
  await dir.share({ login: "ada" }, doc.id, "*", "viewer");
  forgetDecisions(doc.id);
  expect((await view(`/ada/${doc.slug}`)).status).toBe(200);
  seen.reads = 0;
  expect([(await view(`/ada/${doc.slug}`)).status, seen.reads]).toEqual([200, 0]);
  // The server stops public sharing: this isolate forgets every view it kept for people signed out.
  await dir.config.set(root, "public_sharing", false);
  forgetDecisions();
  expect((await view(`/ada/${doc.slug}`)).status).toBe(302);
});

test("the session and the document's row are asked for at the same time", async () => {
  const { seen, doc, view, sessionIs } = await server("viewthr3");
  // The session answers only after the row was asked for: in sequence, it never would.
  sessionIs(async () => {
    for (let i = 0; i < 50 && !seen.queries.some((q) => q.includes("slug_history")); i++) await new Promise((r) => setTimeout(r, 1));
    return seen.queries.some((q) => q.includes("slug_history")) ? { login: "bo", name: "bo" } : null;
  });
  expect((await view(`/ada/${doc.slug}`)).status).toBe(200);
});
