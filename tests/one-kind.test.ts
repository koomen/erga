// One kind of document (document/model/pages.ts): any document may have more pages, however they come (the tree, a move, an
// upload, an agent's write, a write of many files). Its object counts its pages and tells the directory at each change; the
// documents list shows a chevron only for a document with more than one page (or one not counted yet).

import * as Effect from "effect/Effect";
import { expect, test } from "bun:test";
import { pageCount, type TreeOp } from "../document/model/pages";
import { documentsPage } from "../server/pages/documents";
import type { Listed, Session } from "../server/platform";
import { setup } from "./helpers/files-fixture";
import { until } from "./helpers/until";

test("a document's pages: its .html files", () => {
  expect(pageCount(["index.html", "style.css", "photo.png"])).toBe(1);
  expect(pageCount(["index.html", "about.html", "blog/post.html"])).toBe(3);
});

test("a document takes more pages however they come, and its row in the directory counts them", async () => {
  const { doc, dir, put } = await setup();
  const who = {
    "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }),
    "x-erga-who": JSON.stringify({ login: "ada" }),
    "x-erga-via": JSON.stringify("a shared agent (test)"),
  };
  const tool = async (name: string, args: object) =>
    (await (
      await doc.handle(
        new Request(`http://doc/api/operations/${name}`, {
          method: "POST",
          body: JSON.stringify(args),
          headers: { "content-type": "application/json", ...who },
        })
      )
    ).json()) as { ok?: boolean };
  const treeOp = async (op: TreeOp) => (await Effect.runPromise(doc.self.call((c) => c.treeOp(op, { login: "ada" }))))!.ok;
  const counted = (n: number) => until(async () => (await dir.get("doc12345"))!.pages == n);
  await doc.setPermissions([{ login: "ada", role: "owner" }]);
  expect(await treeOp({ op: "new_folder", path: "scans" })).toBe(true);
  await counted(1);
  expect(await treeOp({ op: "new_page", path: "about" })).toBe(true);
  expect((await put("contact.html", "<h1>Contact</h1>")).status).toBe(200);
  expect((await doc.write({ "blog/post.html": "<h1>Post</h1>" }, [])).refused).toEqual([]);
  expect((await tool("write", { path: "team.html", content: "<h1>Team</h1>" })).ok).toBe(true);
  expect((await put("notes.txt", "some notes")).status).toBe(200);
  expect(await treeOp({ op: "move", from: "notes.txt", to: "notes.html" })).toBe(true);
  await counted(6);
  expect(await treeOp({ op: "delete", path: "blog" })).toBe(true);
  await counted(5);
});

test("the documents list: a chevron only for more than one page, or pages not counted yet; no kind", () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const row = (id: string, title: string, pages: number | null): Listed => ({
    id,
    owner: "ada",
    slug: id,
    title,
    titleSet: false,
    slugSet: false,
    created: 1,
    modified: 1,
    role: "owner",
    pages,
  });
  const html = documentsPage(session, [row("aaaaaaaa", "Taxes", 1), row("bbbbbbbb", "Site", 3), row("cccccccc", "Old", null)], 2, null);
  expect(html).not.toContain('data-id="aaaaaaaa" data-base');
  expect(html).toContain('data-id="bbbbbbbb" data-base');
  expect(html).toContain('data-id="cccccccc" data-base');
  expect(html).not.toContain("note kind");
});
