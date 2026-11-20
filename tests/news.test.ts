// Live pages: the keys each change of the directory sends, to whom, and the hub's versions and catch-up
// (server/news/hub.ts). The browser's side is e2e/documents/list.e2e.ts.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Directory, type News } from "../server/directory/index.ts";
import { Grants } from "../server/identity/grants.ts";
import { Hub, KEEP_MS, type Listener } from "../server/news/index.ts";
import { memory } from "./helpers/memory-sql.ts";

const doc = (id: string, owner = "ada") => ({ id, owner, title: "Plan", created: 1 });
const ada = { login: "ada", test: false };

/** A directory whose news is kept, as "key>logins" lines. */
function directory() {
  const heard: string[] = [];
  const sql = memory();
  const dir = new Directory(sql, {
    admins: ["ada", "bo", "cy"],
    news: async (news: News[]) => {
      for (const n of news) heard.push(`${n.key}>${n.to == "admins" ? "admins" : [...n.to].sort().join(",")}`);
    },
  });
  return { dir, sql, take: () => heard.splice(0) };
}

test("each change of a document's row sends its key to everyone whose list shows it, and to who just lost it", async () => {
  const { dir, take } = directory();
  await dir.add(doc("aaaaaaaa"));
  expect(take()).toEqual(["doc:aaaaaaaa>ada"]);
  await dir.share(ada, "aaaaaaaa", "bo", "viewer");
  expect(take()).toEqual(["doc:aaaaaaaa>ada,bo"]);
  await dir.share(ada, "aaaaaaaa", "*", null);
  expect(take()).toEqual(["doc:aaaaaaaa>ada,bo"]);
  await dir.rename("aaaaaaaa", { title: "Q3" }, null);
  expect(take()).toEqual(["doc:aaaaaaaa>ada,bo"]);
  // An edit: its time, and its title while the title follows the page.
  await dir.edited("aaaaaaaa", { modified: 5, pageTitle: "Q3" });
  expect(take()).toEqual(["doc:aaaaaaaa>ada,bo"]);
  await dir.edited("aaaaaaaa", { modified: 5, pageTitle: "Q3" });
  expect(take()).toEqual([]);
  await dir.setPages("aaaaaaaa", 2);
  expect(take()).toEqual(["doc:aaaaaaaa>ada,bo"]);
  await dir.setPages("aaaaaaaa", 2);
  expect(take()).toEqual([]);
  await dir.share(ada, "aaaaaaaa", "bo", null);
  expect(take()).toEqual(["doc:aaaaaaaa>ada,bo"]);
  await dir.share(ada, "aaaaaaaa", "cy", "editor");
  take();
  await dir.remove("aaaaaaaa");
  expect(take()).toEqual(["doc:aaaaaaaa>ada,cy"]);
});

test("each change on the admin pages sends its row's key to the admins, with the changelog's new line; a user's change, every admin's row", async () => {
  const { dir, take } = directory();
  const admin = { login: "ada", admin: true };
  const log = async () => (await dir.config.history(admin, { limit: 1 })).versions[0].n;
  await dir.users.add(admin, "dee");
  expect(take()).toEqual(["user:dee>admins", `change:${await log()}>admins`]);
  await dir.rules.add(admin, { kind: "github_org", value: "acme", access: "read" });
  expect(take()).toEqual(["rule:github_org:acme>admins", `change:${await log()}>admins`]);
  await dir.config.set(admin, "public_sharing", true);
  expect(take()).toEqual(["setting:public_sharing>admins", `change:${await log()}>admins`]);
  await dir.users.setUserRole(admin, "dee", "admin");
  expect(take()).toEqual(["user:dee>admins", `change:${await log()}>admins`]);
  // Dee is an admin now: a change to any user sends Dee's row too, which says whether Dee is the last admin.
  await dir.users.add(admin, "eve");
  expect(take()).toEqual(["user:eve>admins", "user:dee>admins", `change:${await log()}>admins`]);
});

test("a token's key goes to its person's open /settings as its grant is made or revoked", async () => {
  const { dir, sql, take } = directory();
  const grants = new Grants(sql, dir);
  const grant = await grants.make({ ...ada, provider: "github", subject: "1001" }, "Laptop", { scope: "documents" });
  expect(take()).toEqual([`token:${grant.id}>ada`]);
  await grants.revoke("ada", grant.id);
  expect(take().slice(0, 1)).toEqual([`token:${grant.id}>ada`]);
});

/** A hub on SQLite, its clock in the test's hands, and two open pages: Ada's and an admin's. */
function hub() {
  const db = new Database(":memory:");
  let now = 1_000_000;
  const said: Record<string, string[]> = { ada: [], root: [] };
  const pages: Listener[] = [
    { login: "ada", admin: false, send: (t) => said.ada.push(t) },
    { login: "root", admin: true, send: (t) => said.root.push(t) },
  ];
  const h = new Hub(
    { exec: (q, ...p) => db.query(q).all(...p) as never },
    () => pages,
    () => now
  );
  return { h, said, tick: (ms: number) => (now += ms) };
}

test("the hub tells each page only its person's keys, an admin's the admins' too; a page back from away hears what changed since", () => {
  const { h, said, tick } = hub();
  const v1 = h.publish([
    { key: "doc:aaaaaaaa", to: ["ada"] },
    { key: "user:bo", to: "admins" },
  ]);
  expect(said.ada.map((t) => JSON.parse(t))).toEqual([{ changed: [{ key: "doc:aaaaaaaa", v: v1 }] }]);
  expect(said.root.map((t) => JSON.parse(t))).toEqual([{ changed: [{ key: "user:bo", v: v1 }] }]);
  // Two changes in the same millisecond still get two versions, in order.
  const v2 = h.publish([{ key: "doc:bbbbbbbb", to: ["Ada"] }]);
  expect(v2).toBeGreaterThan(v1);
  expect(h.since({ login: "ada", admin: false }, v1)).toEqual({ changed: [{ key: "doc:bbbbbbbb", v: v2 }] });
  expect(h.since({ login: "ada", admin: false }, 0 + 1_000_000 - 1)).toEqual({
    changed: [
      { key: "doc:aaaaaaaa", v: v1 },
      { key: "doc:bbbbbbbb", v: v2 },
    ],
  });
  expect(h.since({ login: "root", admin: true }, v1 - 1)).toEqual({ changed: [{ key: "user:bo", v: v1 }] });
  // Away longer than the hub keeps: start over.
  tick(KEEP_MS + 1);
  expect(h.since({ login: "ada", admin: false }, v2)).toEqual({ reset: true });
});
