// The cutover's routes over HTTP: GET /api/admin/documents/export (an admin-scope token reads every document;
// a documents-scope token does not (locally everyone is signed in as the admin DEV_LOGIN, so "no token" is not tested here; tests/export.test.ts has it).
import { expect, servers, test } from "../../fixtures";
import { getter, mint, publish } from "./access";

await servers.main();

test("an admin token exports every document, one JSON line each, with its files; other tokens are refused", async () => {
  const root = (await servers.main()).root;
  const docs = (await mint(root, null, { label: "Docs", scope: "documents" })).token;
  const made = await publish(root, docs, "Exported one");
  const admin = (await mint(root, null, { label: "Admin", scope: "admin" })).token;
  const get = getter(root);
  expect((await get("/api/admin/documents/export", { headers: { Authorization: `Bearer ${docs}` } })).status).toBe(403);
  const res = await get("/api/admin/documents/export", { headers: { Authorization: `Bearer ${admin}` } });
  expect(res.status).toBe(200);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { record: { id: string; owner: string }; files?: Record<string, { text?: string }>; permissions?: { role: string }[] });
  const mine = lines.find((l) => l.record.id == made.id);
  expect(mine?.record.owner).toBe("tester");
  expect(mine?.permissions?.map((p) => p.role)).toEqual(["owner"]);
  expect(mine?.files?.["index.html"]?.text).toContain("Exported one");

  // POST /api/admin/documents/import takes a document back only under a row the directory has and no document yet.
  const post = (token: string, body: unknown) => fetch(`${root}/api/admin/documents/import`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await post(docs, mine)).status).toBe(403);
  expect((await post(admin, mine)).status).toBe(409);
  expect((await post(admin, { ...mine, record: { ...mine!.record, id: "nope1234" } })).status).toBe(404);
  expect((await post(admin, { record: { id: made.id } })).status).toBe(400);
});
