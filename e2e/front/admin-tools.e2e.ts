// Admins configure the server, and owners share documents, through the same tools (server-tools.ts):
// over the API with an agent token, and in the editor's agent on the scripted model, which never has the admin tools.
import { expect, test, until } from "../fixtures";
import { admin, freshLogin, person, resetting, servers, tools } from "./front";

await servers.script();

const HOURS = "delete_docs_after_hours";
/** Permissions as "login:role". */
const roles = (ps: { login: string; role: string }[]) => ps.map((x) => `${x.login}:${x.role}`);
type Item = { kind: string; name?: string; status?: string; detail?: string };

/** Runs a script in a document's editor agent (the scripted model plays the tool calls), as `cookie`'s person; the turn's tool calls. */
async function agentRun(base: string, id: string, cookie: string, steps: unknown[]) {
  const log = async () => ((await (await fetch(`${base}/d/${id}/api/agent`, { headers: { Cookie: cookie } })).json()) as { log: { busy: boolean; items: Item[] } }).log;
  const before = (await log()).items.length;
  const r = await fetch(`${base}/d/${id}/api/agent`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ text: `Test @script ${JSON.stringify(steps)}` }) });
  expect(r.ok).toBe(true);
  let now = await log();
  await until(async () => { now = await log(); return !now.busy && now.items.length > before + 1; }, 10_000, "the agent finishes");
  return now.items.slice(before).filter((i) => i.kind == "tool");
}

test("the admin tools are listed for, documented for and work for an admin's token only, over HTTP and MCP; a user's token has sharing", async () => {
  const s = await servers.script();
  const a = await admin(s), p = await person(s), user = tools(s.root, await p.token());
  expect((await a.call("whoami")).data.login).not.toBe(p.login);
  expect(await a.names()).toContain("set_setting");
  expect(await a.mcpNames()).toContain("list_users");
  expect(await user.names()).not.toContain("set_setting");
  expect(await user.mcpNames()).not.toContain("list_users");
  expect(await user.names()).toContain("share_document");
  expect(await a.guide()).toContain("### set_setting");
  expect(await user.guide()).not.toContain("### set_setting");
  const t = await user.call("list_settings");
  expect(t.status).toBe(403);
  expect(t.text).toMatch(/admin/);
  expect((await user.call("add_user", { login: "sneaky" })).status).toBe(403);
});

test("an admin's agent reads the settings (saying which are locked) and changes one; a bad value says what's wrong; the server goes by the new value (a new blank document lasts 36 hours)", async () => {
  const s = await servers.script(), a = await admin(s);
  await resetting(s, HOURS, async () => {
    let t = await a.call("list_settings");
    expect(t.status).toBe(200);
    expect(typeof t.data?.find((e: { key: string }) => e.key == HOURS)?.locked).toBe("boolean");
    t = await a.call("set_setting", { key: HOURS, value: 36 });
    expect(t.status).toBe(200);
    expect(t.data).toMatchObject({ value: 36, source: "set", updatedBy: "tester" });
    t = await a.call("set_setting", { key: HOURS, value: 0 });
    expect(t.status).toBe(400);
    expect(t.text).toMatch(/whole number/);
    const blank = (await fetch(`${s.root}/new`, { redirect: "manual", headers: { Cookie: a.cookie } })).headers.get("location")?.replace(/#edit$/, "");
    const listed = (await a.call("list_documents")).data.find((d: { address: string }) => d.address == blank);
    const lasts = (Date.parse(listed.expires) - Date.now()) / 3_600_000;
    expect(lasts).toBeGreaterThan(35);
    expect(lasts).toBeLessThanOrEqual(36);
  });
});

test("an admin's agent adds users, makes someone an admin (their documents token still has no admin tools) and a user again, lists users, and removes users; a bootstrap admin stays one", async () => {
  const s = await servers.script(), a = await admin(s), p = await person(s), user = tools(s.root, await p.token());
  const newcomer = freshLogin("wnew");
  let t = await a.call("add_user", { login: newcomer });
  expect(t.status).toBe(200);
  expect(t.data).toMatchObject({ role: "user", addedBy: "tester" });
  t = await a.call("set_user_role", { login: p.login, role: "admin" });
  expect(t.status).toBe(200);
  expect(t.data.role).toBe("admin");
  expect(await user.names()).not.toContain("set_setting");
  t = await a.call("set_user_role", { login: p.login, role: "user" });
  expect(t.data.role).toBe("user");
  t = await a.call("list_users");
  expect(t.data.some((u: { login: string; bootstrap: boolean }) => u.login == "tester" && u.bootstrap)).toBe(true);
  expect(t.data.some((u: { login: string }) => u.login == newcomer)).toBe(true);
  t = await a.call("set_user_role", { login: "tester", role: "user" });
  expect(t.status).toBe(403);
  expect(t.text).toMatch(/deploy/);
  expect((await a.call("remove_user", { login: newcomer })).status).toBe(200);
  expect((await a.call("list_users")).data.some((u: { login: string }) => u.login == newcomer)).toBe(false);
});

test("an owner's agent shares a document over the API, and the person can open it; document_access says with whom; an admin's agent can't share someone else's (being an admin gives nothing on documents)", async () => {
  const s = await servers.script(), a = await admin(s), p = await person(s), user = tools(s.root, await p.token());
  const mine = (await p.nameOf(await p.make())).address;
  let t = await user.call("share_document", { document: mine, login: "Ada", role: "viewer" });
  expect(t.status).toBe(200);
  expect(roles(t.data.permissions)).toContain("ada:viewer");
  expect((await p.get(`${mine}?user=Ada`)).status).toBe(200);
  t = await a.call("share_document", { document: mine, login: "tester", role: "editor" });
  expect(t.status).toBe(403);
  expect(t.text).toMatch(/owner/);
  t = await user.call("document_access", { document: mine });
  expect(t.status).toBe(200);
  expect(t.data.permissions).toHaveLength(2);
});

test("the editor's agent never has the admin tools, an admin's included, and nothing changes; a user's agent shares the document it's in", async () => {
  const s = await servers.script(), a = await admin(s), p = await person(s), user = tools(s.root, await p.token());
  const newcomer = freshLogin("wnew");
  const adminDoc = ((await (await fetch(`${s.root}${(await fetch(`${s.root}/new`, { redirect: "manual", headers: { Cookie: a.cookie } })).headers.get("location")!.replace(/#edit$/, "")}/api/name`, { headers: { Cookie: a.cookie } })).json()) as { id: string }).id;
  const before = (await a.call("list_settings")).data.find((e: { key: string }) => e.key == HOURS).value;
  let calls = await agentRun(s.root, adminDoc, a.cookie, [{ tool: "set_setting", args: { key: HOURS, value: 30 } }, { tool: "add_user", args: { login: newcomer, role: "admin" } }, { text: "Done." }]);
  expect(calls.map((c) => `${c.name} ${c.status}`)).toEqual(["set_setting error", "add_user error"]);
  expect((await a.call("list_settings")).data.find((e: { key: string }) => e.key == HOURS).value).toBe(before);
  expect((await a.call("list_users")).data.some((u: { login: string }) => u.login == newcomer)).toBe(false);
  const mine = await p.make();
  calls = await agentRun(s.root, mine, p.cookie, [{ tool: "list_settings", args: {} }, { tool: "share_document", args: { login: "Bo", role: "editor" } }, { text: "Done." }]);
  expect(calls.map((c) => `${c.name} ${c.status}`)).toEqual(["list_settings error", "share_document done"]);
  expect(roles((await user.call("document_access", { document: mine })).data.permissions)).toContain("bo:editor");
});
