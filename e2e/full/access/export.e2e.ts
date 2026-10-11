// The cutover's export over HTTP (GET /api/admin/documents/export): an admin-scope token reads every document;
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
});
