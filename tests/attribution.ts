#!/usr/bin/env bun
// Who did it (#69, attribution.ts), end to end, against a dev server of its
// own, with the scripted model and simulated factory VMs. One representative
// action through each way a person acts, and each is recorded under the
// person's login, with how they did it beside it, never under an agent alone:
//
//   in person            tester turns the factory on (/admin): "tester"
//   the editor's agent   edits a page and shares the document: "tester, via their agent"
//   a shared agent       an admin token over /api/ext and MCP: edits, publishes files,
//                        sets a setting, adds a user, revokes a token:
//                        "tester, via a shared agent (Attribution test)"
//   the admin agent      changes a user's role, adds a task, merges it:
//                        "tester, via their admin agent"
//   a factory token      adds a task: "tester, via a shared agent (Board agent)"
//   the factory's VM     works on that task: its commits are tester's, and the log
//                        says who asked for the merge
//
// Then the change log (/admin/changes) shows the person and the "via" beside
// them, in headless Chrome.
//
//   bun tests/attribution.ts

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const host = await startHost(null, {
  env: { ERGA_AGENT_MODEL: "script", ERGA_WRITE_DELAY_MS: "50", ERGA_VERSION_IDLE_MS: "800", ERGA_VERSION_MAX_MS: "6000" },
  processEnv: { ERGA_FACTORY_RUNNER: "sim", ERGA_LINK_SECRET: `attribution-test-${crypto.randomUUID()}`, ERGA_FACTORY_SIM_NO_SCRIPTS: "1" },
});
const root = host.base.replace(/\/+$/, "");
const origin = new URL(root).origin;
const LABEL = "Attribution test", BOARD = "Board agent";

const signIn = async (as: string) => (await fetch(`${root}/auth/github?as=${as}&next=/docs`, { redirect: "manual" })).headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="))!;
const cookie = await signIn("tester");
/** As tester, in person: their browser session, from this site's pages. */
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init, headers: { Cookie: cookie, Origin: origin, ...(init.headers as Record<string, string>) } });
const post = (path: string, json: unknown) => get(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
const mint = async (label: string) => /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(await (await get("/tokens/new", { method: "POST", body: new URLSearchParams({ label, scope: "admin" }) })).text())![1];
/** A tool of the server's API, with an agent token. */
const tool = async (token: string, name: string, args: unknown = {}) => {
  const r = await fetch(`${root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const body = await r.json() as any;
  expect(r.ok, `${name} over /api/ext`, body);
  const text = body.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return text ?? body; }
};
const versions = async (id: string) => (await (await get(`/api/docs/${id}/versions?limit=20`)).json() as { versions: { n: number; authors: string[]; description: string | null }[] }).versions;
const task = async (id: number) => (await (await get(`/api/factory/tasks/${id}`)).json()) as any;
const STEP = 60_000;

try {
  // In person: tester turns the factory on, on /admin.
  expect((await get("/admin/settings", { method: "POST", body: new URLSearchParams({ key: "factory", value: JSON.stringify("on") }) })).ok, "tester turns the factory on");
  const token = await mint(LABEL);
  const changes = async () => (await tool(token, "list_setting_changes", { limit: 50 })).changes as { by: string; via?: string; changes: any[] }[];
  const factoryOn = (await changes()).find((v) => v.changes.some((c) => c.key == "factory"));
  expect(factoryOn?.by == "tester" && !factoryOn.via, "a setting set in person: tester, with no via", factoryOn);
  ok("in person: recorded as tester alone");

  // The editor's agent (the scripted model): an edit, and a share, in one turn.
  const at = (await get("/new")).headers.get("location")!.replace(/(\/edit|#edit)$/, "");
  const id = ((await (await get(`${at}/api/name`)).json()) as { id: string }).id;
  const said = await post(`/d/${id}/api/agent`, { text: "@script " + JSON.stringify([
    { tool: "edit", args: { path: "index.html", edits: [{ oldText: "</h1>", newText: " by the editor's agent</h1>" }] } },
    { tool: "share_document", args: { login: "bo", role: "viewer" } },
    { text: "Done." },
  ]) });
  expect(said.ok, "the editor's agent takes the prompt", await said.text());
  await until(async () => (await versions(id)).some((v) => v.authors.includes("tester, via their agent")), 20_000, "the agent's turn is a version, by tester via their agent", async () => (await versions(id)).slice(0, 3));
  const shared = await tool(token, "document_access", { document: id }) as { access: { login: string; grantedBy?: string; grantedVia?: string }[] } | any;
  const bo = JSON.stringify(shared).includes('"grantedVia":"their agent"');
  expect(bo && JSON.stringify(shared).includes('"grantedBy":"tester"'), "the share is tester's, via their agent", shared);
  ok("the editor's agent: its edit's version and its share are tester's, via their agent");

  // A shared agent, with tester's admin token: an edit over /api/ext and files published, then a setting, a user (MCP) and a token.
  const viaToken = `tester, via a shared agent (${LABEL})`;
  await tool(token, "edit", { document: id, path: "index.html", edits: [{ oldText: "</h1>", newText: " and a shared agent</h1>" }] });
  await tool(token, "update_files", { document: id, files: { "notes.md": "# Notes\n" } });
  await until(async () => (await versions(id)).some((v) => v.authors.includes(viaToken)), 30_000, "the shared agent's edits are a version, by tester via it", async () => (await versions(id)).slice(0, 3));
  expect(!(await versions(id)).some((v) => v.authors.some((a) => a == "files published" || /’s agent/.test(a))), "no version is by an agent alone, or by nobody", await versions(id));
  await tool(token, "set_setting", { key: "delete_docs_after_hours", value: 48 });
  const mcp = await (await fetch(`${root}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_user", arguments: { login: "mcp-user" } } }) })).json() as any;
  expect(!mcp.error && !mcp.result?.isError, "add_user over MCP", mcp);
  const spare = await mint("Spare");
  const spareId = ((await tool(token, "list_tokens")) as { id: string; label: string }[]).find((t) => t.label == "Spare")!.id;
  await tool(token, "revoke_token", { id: spareId });
  expect((await fetch(`${root}/api/ext/tools`, { headers: { Authorization: `Bearer ${spare}` } })).status == 401, "the spare token is revoked");
  let log = await changes();
  const byToken = (pred: (c: any) => boolean) => log.find((v) => v.changes.some(pred));
  for (const [what, pred] of [["the setting", (c: any) => c.key == "delete_docs_after_hours"], ["the user added (MCP)", (c: any) => c.user?.login == "mcp-user" && c.user.event == "added"], ["the token revoked", (c: any) => c.token?.label == "Spare"]] as const) {
    const v = byToken(pred);
    expect(v?.by == "tester" && v.via == `a shared agent (${LABEL})`, `${what}: tester, via the shared agent`, v);
  }
  const users = await tool(token, "list_users") as { login: string; addedBy: string; addedVia?: string }[];
  expect(users.find((u) => u.login == "mcp-user")?.addedVia == `a shared agent (${LABEL})`, "the users list: added by tester, via the shared agent", users);
  ok("a shared agent (/api/ext, MCP): edits, published files, a setting, a user and a token, each tester's, via the token's agent");

  // The admin agent: a user's role, and a task.
  const asked = await post("/api/factory/agent", { text: "@script " + JSON.stringify([
    { tool: "set_user_role", args: { login: "mcp-user", role: "admin" } },
    { tool: "create_task", args: { title: "The admin agent's task", description: "A note on the front page." } },
    { text: "Done." },
  ]) });
  expect(asked.ok, "the admin agent takes the prompt", await asked.text());
  const tasks = async () => (await (await get("/api/factory/tasks")).json()) as any[];
  await until(async () => (await tasks()).some((t) => t.title == "The admin agent's task"), 20_000, "the admin agent adds the task");
  const t1 = (await tasks()).find((t) => t.title == "The admin agent's task");
  expect(t1.by == "tester, via their admin agent" && t1.person == "tester" && t1.log[0].message.startsWith("Added by tester, via their admin agent"), "the admin agent's task: tester's, via their admin agent", t1);
  log = await changes();
  expect(byToken((c) => c.user?.login == "mcp-user" && c.user.event == "role")?.via == "their admin agent", "the role change: tester, via their admin agent", log.slice(0, 4));
  expect(byToken((c) => c.task?.id == t1.id && c.task.event == "added")?.via == "their admin agent", "the task added: tester, via their admin agent", log.slice(0, 4));
  ok("the admin agent: a role change and a task, tester's, via their admin agent");

  // A factory token (an outside agent on the board): a task.
  const factoryToken = ((await (await post("/api/factory/tokens", { label: BOARD, hours: 1 })).json()) as { token: string }).token;
  const made = await fetch(`${root}/api/factory/tasks`, { method: "POST", headers: { Authorization: `Bearer ${factoryToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "The board agent's task", description: "Another note." }) });
  const t2 = await made.json() as any;
  expect(made.status == 201 && t2.by == `tester, via a shared agent (${BOARD})` && t2.person == "tester", "a factory token's task: tester's, via the shared agent", t2);
  ok("a factory token: its task is tester's, via the shared agent");

  // The factory's VM: it works on the task as tester's; the admin agent merges it.
  await until(async () => (await task(t2.id)).status == "complete", STEP, "the VM finishes the task", async () => (await task(t2.id)).log.slice(-4));
  const repo = join(host.state, "factory", "erga.git");
  const authors = spawnSync("git", ["-C", repo, "log", "--format=%an", `staging..${(await task(t2.id)).branch}`], { encoding: "utf8" }).stdout.trim().split("\n");
  expect(authors.length > 0 && authors.every((a) => a == "tester"), "the VM's commits are tester's", authors);
  expect((await post("/api/factory/agent", { text: "@script " + JSON.stringify([{ tool: "merge_task", args: { id: t2.id } }, { text: "Merging." }]) })).ok, "the admin agent is asked to merge");
  await until(async () => (await task(t2.id)).status == "merged", STEP, "the task merges", async () => (await task(t2.id)).log.slice(-4));
  expect((await task(t2.id)).log.some((l: any) => l.message == "Merge requested by tester, via their admin agent"), "the task's log: the merge, by tester via their admin agent", (await task(t2.id)).log.slice(-6));
  log = await changes();
  expect(byToken((c) => c.task?.id == t2.id && c.task.event == "merged")?.via == "their admin agent", "the change log: the merge, tester's via their admin agent", log.slice(0, 3));
  ok("the factory's VM: its commits are tester's, and the merge the admin agent asked for is tester's, via it");

  // Nothing in the change log is by an agent, a token or the factory alone.
  expect(log.every((v) => /^[a-z0-9-]+$/.test(v.by)), "every change log entry is by a person's login", log.map((v) => v.by));

  // The change log shows the person, and how, beside each other.
  const browser = await Browser.launch();
  try {
    const p = await browser.page(await browser.context());
    await p.open(`${root}/admin/changes`, { width: 1100, height: 900, scale: 2 });
    await until(() => p.eval(`!!document.querySelector("li.change")`), 10_000, "the change log lists changes");
    const rows = await p.eval<{ by: string; via: string | null }[]>(`[...document.querySelectorAll("li.change")].map((li) => ({ by: li.querySelector(".when .by").textContent, via: li.querySelector(".when .via")?.textContent ?? null }))`);
    for (const via of ["via their admin agent", `via a shared agent (${LABEL})`, `via a shared agent (${BOARD})`]) {
      expect(rows.some((r) => r.by == "tester" && r.via == via), `the change log shows "tester" and "${via}"`, rows);
    }
    expect(rows.some((r) => r.by == "tester" && r.via == null), "and tester's own change, with no via", rows);
    await p.screenshot(join(SHOTS, "attribution-change-log.png"));
  } finally { browser.close(); }
  ok("the change log (/admin/changes) shows each change's person, and how they did it");
  console.log("all attribution checks pass");
} catch (e) {
  console.error(`--- the dev server (tail)\n${host.output().slice(-3000)}`);
  throw e;
} finally {
  spawnSync("pkill", ["-f", join(host.state, "factory", "vms")], { stdio: "ignore" });
  await host.dispose();
}
