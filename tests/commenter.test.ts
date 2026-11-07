// The commenter role: share_document gives it to a login and to "*"; the access rules rank it between viewer and
// editor; a commenter reads like a viewer, never edits, and comments (mayComment); only editors resolve any thread.

import { expect, test } from "bun:test";
import { allTools, runTool } from "../agents/tools";
import { accessOf, mayComment, mayResolveAny, type Role } from "../document/access.ts";
import { Directory } from "../server/directory/index.ts";
import type { Caller } from "../server/operations/index.ts";
import { memory } from "./helpers/memory-sql";

const share = (ctx: Caller, args: Record<string, unknown>) =>
  runTool(allTools().find((t) => t.name == "share_document")!, args, ctx) as Promise<any>;

async function plan() {
  const dir = new Directory(memory(), { defaults: { public_sharing: true }, admins: ["root"] });
  for (const l of ["bo", "cy"]) await dir.users.add({ login: "root", admin: true }, l);
  const doc = (await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1 })).doc;
  return { dir, doc, ada: { dir, who: { login: "ada" } } as unknown as Caller };
}

test("share_document gives commenter to a login: they open the document, and may not edit, rename, delete or share it", async () => {
  const { dir, doc, ada } = await plan();
  const r = await share(ada, { document: "plan", login: "bo", role: "commenter" });
  expect(r.permissions.map((p: { login: string; role: string }) => `${p.login}:${p.role}`)).toEqual(["ada:owner", "bo:commenter"]);
  expect(await dir.access({ login: "bo" }, doc)).toBe("commenter");
  const can = await Promise.all((["open", "edit", "rename", "delete", "share"] as const).map((a) => dir.may({ login: "bo" }, a, doc)));
  expect(can).toEqual([true, false, false, false, false]);
  expect((await dir.lists.list("bo")).map((d) => [d.id, d.role])).toEqual([["aaaaaaaa", "commenter"]]);
  expect((await dir.openAs({ login: "bo" }, "ada", "plan"))?.role).toBe("commenter");
});

test('commenter for "*": everyone signed in comments; a better role of their own stands, and a commenter\'s beats "*" viewer', async () => {
  const { dir, doc, ada } = await plan();
  await share(ada, { document: "plan", login: "*", role: "commenter" });
  expect(await dir.access({ login: "dee" }, doc)).toBe("commenter");
  await share(ada, { document: "plan", login: "bo", role: "editor" });
  expect(await dir.access({ login: "bo" }, doc)).toBe("editor");
  await share(ada, { document: "plan", login: "*", role: "viewer" });
  await share(ada, { document: "plan", login: "cy", role: "commenter" });
  expect(await dir.access({ login: "cy" }, doc)).toBe("commenter");
  expect(await dir.access({ login: "dee" }, doc)).toBe("viewer");
});

test("someone who may only read (the access rules) is a viewer where they were made a commenter", async () => {
  const { dir, doc } = await plan();
  await dir.share({ login: "ada" }, doc.id, "bo", "commenter");
  await dir.users.setUserRole({ login: "root", admin: true }, "bo", "read");
  const again = new Directory((dir as unknown as { sql: ConstructorParameters<typeof Directory>[0] }).sql, { admins: ["root"] });
  expect(await again.access({ login: "bo" }, doc)).toBe("viewer");
});

test("a role decides what its person does with the page and its comments", () => {
  const rows = (["owner", "editor", "commenter", "viewer", null] as (Role | null)[]).map((r) => [
    r,
    accessOf(r),
    mayComment(r),
    mayResolveAny(r),
  ]);
  expect(rows).toEqual([
    ["owner", "edit", true, true],
    ["editor", "edit", true, true],
    ["commenter", "view", true, false],
    ["viewer", "view", false, false],
    [null, null, false, false],
  ]);
});
