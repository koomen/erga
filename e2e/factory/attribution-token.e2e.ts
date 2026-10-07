// Who did it (#69; tests/attribution.ts): a shared agent, with tester's admin token.
import { expect, test, until } from "../fixtures";
import { servers } from "./factory";
import { freshHours, SETTING, unique, who } from "./who";

test.beforeAll(async () => { await servers.factory(); });

test("a shared agent (/api/ext and MCP): its edits and published files are a version by tester via it, none by an agent alone; a setting, a user added over MCP and a token revoked are each tester's, via the token's agent; the users list says so", async () => {
  const s = await servers.factory(), w = who(s);
  const label = `Attribution ${unique()}`, via = `a shared agent (${label})`;
  const token = await w.mint(label);
  const id = await w.newDoc();
  await w.tool(token, "edit", { document: id, path: "index.html", edits: [{ oldText: "</h1>", newText: " and a shared agent</h1>" }] });
  await w.tool(token, "update_files", { document: id, files: { "notes.md": "# Notes\n" } });
  await until(async () => (await w.versions(id)).some((v) => v.authors.includes(`tester, via ${via}`)), 10_000, "the shared agent's edits are a version, by tester via it");
  for (const v of await w.versions(id)) for (const a of v.authors) expect(a == "files published" || /’s agent/.test(a), `version ${v.n} by ${a}`).toBe(false);

  const hours = freshHours(), user = `mcp-${unique()}`, spareLabel = `Spare ${unique()}`;
  await w.tool(token, "set_setting", { key: SETTING, value: hours });
  const mcp = await (await fetch(`${s.root}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_user", arguments: { login: user } } }) })).json() as any;
  expect(!mcp.error && !mcp.result?.isError, JSON.stringify(mcp)).toBe(true);
  const spare = await w.mint(spareLabel);
  const spareId = ((await w.tool(token, "list_tokens")) as { id: string; label: string }[]).find((t) => t.label == spareLabel)!.id;
  await w.tool(token, "revoke_token", { id: spareId });
  expect((await fetch(`${s.root}/api/ext/tools`, { headers: { Authorization: `Bearer ${spare}` } })).status).toBe(401);

  const log = await w.changes(token);
  const of = (pred: (c: any) => boolean) => log.find((v) => v.changes.some(pred));
  for (const [what, pred] of [["the setting", (c: any) => c.key == SETTING && c.to == hours], ["the user added (MCP)", (c: any) => c.user?.login == user && c.user.event == "added"], ["the token revoked", (c: any) => c.token?.label == spareLabel]] as const) {
    expect([of(pred)?.by, of(pred)?.via], what).toEqual(["tester", via]);
  }
  const users = await w.tool(token, "list_users") as { login: string; addedVia?: string }[];
  expect(users.find((u) => u.login == user)?.addedVia).toBe(via);
});
