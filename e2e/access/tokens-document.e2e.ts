// A one-document token over HTTP (A document token): its document, and nothing else.
import { expect, servers, test } from "../fixtures";
import { getter, mint, publish, tool } from "./access";

await servers.main();

test("a document token reads its document, and not another; it neither lists nor makes documents, nor reads another's versions or page", async () => {
  const root = (await servers.main()).root;
  const docs = await mint(root, null, { label: "Docs", scope: "documents" });
  const made = await publish(root, docs.token, "Scoped one"), other = await publish(root, docs.token, "Scoped two");
  expect(made.id).toBeTruthy();
  expect(other.id).toBeTruthy();
  const one = (await mint(root, null, { label: "One", scope: "document", doc: made.id })).token;
  expect((await tool(root, one, "read", { document: made.id, path: "index.html" })).text).toContain("Scoped one");
  expect((await tool(root, one, "read", { document: other.id, path: "index.html" })).status).toBe(403);
  expect((await tool(root, one, "list_documents")).status).toBe(403);
  expect((await tool(root, one, "create_document")).status).toBe(403);
  const get = getter(root), auth = { headers: { Authorization: `Bearer ${one}` } };
  expect((await get(`/api/docs/${other.id}/versions`, auth)).status).toBe(404);
  expect((await get(other.address, auth)).status).toBe(403);
});
