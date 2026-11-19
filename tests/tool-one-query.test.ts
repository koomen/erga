// An agent's tool call asks the database one time: the document and the caller's role come in one query
// (Directory.openAs), and a token that was good a moment ago is remembered (Tokens.verify).

import { expect, test } from "bun:test";
import { Directory, type Param, type Sql } from "../server/directory/index.ts";
import { type Caller, findDocument } from "../server/operations/operation";
import { memory } from "./helpers/memory-sql";

/** A database that counts its reads. */
function counting() {
  const sql = memory();
  const seen = { reads: 0 };
  const counted: Sql = { ...sql, all: <T>(q: string, ...p: Param[]) => (seen.reads++, sql.all<T>(q, ...p)) };
  return { sql: counted, seen };
}

/** ada with her document "Plan", shared with bo (an editor) and cy (a viewer); dee has no share. */
async function server() {
  const { sql, seen } = counting();
  const dir = new Directory(sql, { admins: ["root"] });
  const root = { login: "root", admin: true };
  for (const login of ["ada", "bo", "cy", "dee"]) await dir.users.add(root, login);
  const { doc } = await dir.add({ id: "planplan", owner: "ada", title: "Plan", created: 1, expires: null });
  await dir.share({ login: "ada" }, doc.id, "bo", "editor");
  await dir.share({ login: "ada" }, doc.id, "cy", "viewer");
  const caller = (login: string, onlyDoc?: string): Caller => ({ dir, who: { login, ...(onlyDoc ? { onlyDoc } : {}) } }) as Caller;
  return { sql, seen, dir, doc, caller, root };
}

test("a tool call finds its document and the caller's role in one query", async () => {
  const { seen, doc, caller } = await server();
  // The first call reads bo's account and the settings, which the server remembers a few seconds.
  await findDocument(caller("bo"), `/ada/${doc.slug}`, "edit");
  for (const ref of [`/ada/${doc.slug}`, doc.id, `/d/${doc.id}`, `https://erga.test/ada/${doc.slug}`]) {
    seen.reads = 0;
    expect((await findDocument(caller("bo"), ref, "edit")).id).toBe(doc.id);
    expect([ref, seen.reads]).toEqual([ref, 1]);
  }
});

test("every name of a document finds it, with the caller's rights", async () => {
  const { dir, doc, caller } = await server();
  const old = doc.slug;
  await dir.rename(doc.id, { slug: "roadmap" }, null);
  for (const ref of ["/ada/roadmap", `/ada/${old}`, `/ada/${doc.id}`, `/d/${doc.id}`, doc.id, "https://erga.test/ada/roadmap?x=1"])
    expect([ref, (await findDocument(caller("bo"), ref, "edit")).id]).toEqual([ref, doc.id]);
  // One of the caller's own slugs.
  expect((await findDocument(caller("ada"), "roadmap", "delete")).id).toBe(doc.id);
  await expect(findDocument(caller("bo"), "roadmap", "open")).rejects.toThrow(/no document/);
  await expect(findDocument(caller("bo"), "/ada/nothing", "open")).rejects.toThrow(/no document/);
  await expect(findDocument(caller("bo"), "", "open")).rejects.toThrow(/Name the document/);

  expect((await findDocument(caller("cy"), "/ada/roadmap", "open")).id).toBe(doc.id);
  await expect(findDocument(caller("cy"), "/ada/roadmap", "edit")).rejects.toThrow("You can't edit that document.");
  await expect(findDocument(caller("dee"), "/ada/roadmap", "open")).rejects.toThrow("You can't open that document.");
  await expect(findDocument(caller("bo"), "/ada/roadmap", "delete")).rejects.toThrow(/Only its owner can delete/);

  // A document token reaches its document only.
  const { doc: other } = await dir.add({ id: "otherdoc", owner: "ada", title: "Other", created: 2, expires: null });
  expect((await findDocument(caller("ada", doc.id), "/ada/roadmap", "edit")).id).toBe(doc.id);
  await expect(findDocument(caller("ada", doc.id), `/ada/${other.slug}`, "open")).rejects.toThrow(/one document only/);
});

test("someone with Can authenticate only views what is shared with them, by the one query too", async () => {
  const { dir, doc, caller, root } = await server();
  await dir.users.setUserRole(root, "bo", "read");
  const again = new Directory((dir as unknown as { sql: Sql }).sql, { admins: ["root"] });
  expect((await again.openAs({ login: "bo" }, "ada", doc.slug))?.role).toBe("viewer");
  expect(await again.access({ login: "bo" }, doc)).toBe("viewer");
  await expect(findDocument({ ...caller("bo"), dir: again }, `/ada/${doc.slug}`, "edit")).rejects.toThrow("You can't edit that document.");
});
