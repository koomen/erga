// An agent lists its person's tokens and revokes one, as the person does in Settings (whoami, revoke: the documents
// tool's ops, over the API with the agent's own token). A document token's agent does neither.
import { expect, servers, test } from "../../helpers/fixtures";
import { mint, signIn, tool, unique } from "./access";

await servers.main();

test("an agent lists its person's tokens a page at a time and revokes one by its id; a document token can't", async () => {
  const root = (await servers.main()).root;
  const cookie = await signIn(root, unique("rev"));
  const agent = (await mint(root, cookie, { label: "The agent", scope: "documents" })).token;
  const other = (await mint(root, cookie, { label: "Share with an agent", scope: "documents" })).token;
  const third = (await mint(root, cookie, { label: "Third", scope: "documents" })).token;
  expect([agent, other, third].every(Boolean)).toBe(true);
  const docs = (args: Record<string, unknown>) =>
    tool(root, agent, "documents", args).then((r) => ({ status: r.status, json: r.status == 200 ? JSON.parse(r.text) : r.text }));

  // Newest first, two of them; one more after them, which offset lists.
  const first = (await docs({ op: "whoami", limit: 2 })).json as { tokens: { id: string; label: string }[]; moreTokens: number };
  expect(first.tokens.map((t) => t.label)).toEqual(["Third", "Share with an agent"]);
  expect(first.moreTokens).toBe(1);
  const next = (await docs({ op: "whoami", limit: 2, offset: 2 })).json as typeof first;
  expect(next.tokens.map((t) => t.label)).toEqual(["The agent"]);
  expect(next.moreTokens).toBe(0);

  // Revoke by the id whoami gave: the token stops at once, and the list no longer has it.
  const id = first.tokens[1].id;
  expect((await docs({ op: "revoke", token: id })).json).toEqual({ revoked: id });
  expect((await tool(root, other, "documents", { op: "whoami" })).status).toBe(401);
  expect(((await docs({ op: "whoami" })).json as typeof first).tokens.map((t) => t.label)).toEqual(["Third", "The agent"]);
  expect((await docs({ op: "revoke", token: id })).status).toBe(404);

  // A document token reaches one document: it neither lists its person's tokens nor revokes one.
  const doc = JSON.parse((await tool(root, agent, "documents", { op: "create_document", title: "One" })).text) as { id: string };
  const one = (await mint(root, cookie, { label: "One document", scope: "document", doc: doc.id })).token;
  expect(JSON.parse((await tool(root, one, "documents", { op: "whoami" })).text).tokens).toBeUndefined();
  const refused = await tool(root, one, "documents", { op: "revoke", token: first.tokens[0].id });
  expect([403, 404]).toContain(refused.status);
  expect((await tool(root, third, "documents", { op: "whoami" })).status).toBe(200);
});
