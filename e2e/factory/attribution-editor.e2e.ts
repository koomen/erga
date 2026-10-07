// Who did it (#69; tests/attribution.ts): the editor's agent.
import { expect, test, until } from "../fixtures";
import { servers } from "./factory";
import { unique, who } from "./who";

await servers.factory();

test("the editor's agent's edit is a version by \"tester, via their agent\", and its share is tester's, via their agent", async () => {
  const w = who(await servers.factory());
  const token = await w.mint(`Attribution ${unique()}`);
  const id = await w.newDoc(), bo = `bo-${unique()}`;
  const said = await w.post(`/d/${id}/api/agent`, { text: "@script " + JSON.stringify([
    { tool: "edit", args: { path: "index.html", edits: [{ oldText: "</h1>", newText: " by the editor's agent</h1>" }] } },
    { tool: "share_document", args: { login: bo, role: "viewer" } },
    { text: "Done." },
  ]) });
  expect(said.ok, await said.text()).toBe(true);
  await until(async () => (await w.versions(id)).some((v) => v.authors.includes("tester, via their agent")), 10_000, "the agent's turn is a version, by tester via their agent");
  // The document's permissions, wherever the tool's answer lists them.
  const access = await w.tool(token, "document_access", { document: id });
  const find = (o: any): any => o && typeof o == "object" ? (o.login == bo ? o : Object.values(o).map(find).find(Boolean)) : undefined;
  expect(find(access), JSON.stringify(access)).toMatchObject({ grantedBy: "tester", grantedVia: "their agent" });
});
