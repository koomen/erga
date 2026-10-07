// The factory's agent as a general admin agent (factory/agent.ts,
// `adminTools`), on an in-memory directory: it reads and changes the
// settings on /admin, and every change goes into the settings' change log
// (config.ts history) under the admin who prompted it, never the agent. The
// scripted test model drives the real agent loop, as the panel would.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import { Directory, type Param, type Sql } from "../directory";
import { adminTools, dashboardTools, factoryTools, startFactoryAgent, type DashboardOps, type FactoryOps } from "../factory/agent";
import type { Task } from "../worker/factory";
import { SERVER_TOOLS, type ToolWho } from "../server-tools";


const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;

function fresh(): Directory {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  return new Directory(sql, { admins: ["root"], credentialSecret: "test secret" });
}

const noOps = {} as FactoryOps;
const ok = async () => {};

/** One admin's factory agent on the scripted model, with the factory's tools and the admin tools, as worker/factory.ts makes it. */
function session(dir: Directory, login: string, admin: boolean, guard = ok) {
  const as = (): ToolWho => ({ dir, who: { login, admin } });
  const agent = startFactoryAgent({ cfg: { apiKey: Redacted.make(""), model: "script", effort: "medium" }, owner: login, tools: [...factoryTools(noOps, guard), ...adminTools(as, guard)] });
  /** Runs a script of tool calls, and answers each tool's outcome. */
  const run = (steps: { tool: string; args?: Record<string, unknown> }[]) => new Promise<{ name: string; status: string; detail?: string }[]>((resolve) => {
    const seen: { name: string; status: string; detail?: string }[] = [];
    const off = agent.subscribe((ev) => {
      if (ev.t == "tool" && ev.status != "running") seen.push({ name: ev.name, status: ev.status, detail: ev.detail });
      if (ev.t == "busy" && !ev.busy) { off(); resolve(seen); }
    });
    agent.prompt(`@script ${JSON.stringify(steps)}`, null);
  });
  return { agent, run };
}

test("the factory's agent has every admin tool beside the factory's, each name once", () => {
  const names = [...factoryTools(noOps, ok), ...adminTools(() => ({ dir: fresh(), who: { login: "root" } }), ok)].map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
  for (const t of SERVER_TOOLS.filter((t) => t.admin)) expect(names).toContain(t.name);
  expect(names).toContain("create_task");
  expect(names).not.toContain("share_document");
});

test("a setting the agent changes is in the change log under the admin who prompted it, not the agent", async () => {
  const dir = fresh();
  const { run } = session(dir, "Root", true);
  const done = await run([
    { tool: "set_setting", args: { key: "delete_docs_after_hours", value: 6 } },
    { tool: "set_setting", args: { key: "deploy_page", value: "admins" } },
    { tool: "reset_setting", args: { key: "delete_docs_after_hours" } },
  ]);
  expect(done).toEqual([{ name: "set_setting", status: "done" }, { name: "set_setting", status: "done" }, { name: "reset_setting", status: "done" }]);

  const { versions, total } = await dir.config.history({ login: "root", admin: true });
  expect(total).toBe(3);
  expect(versions.map((v) => v.by)).toEqual(["root", "root", "root"]);
  expect(versions[0].changes).toEqual([{ key: "delete_docs_after_hours", from: 6, to: expect.anything(), reset: true }]);
  expect(versions[2].changes[0]).toMatchObject({ key: "delete_docs_after_hours", to: 6 });
  const entry = await dir.config.entry("deploy_page");
  expect(entry.updatedBy).toBe("root");
  expect(entry.value).toBe("admins");
  // Never the agent's name.
  expect(JSON.stringify(versions)).not.toMatch(/agent/i);
});

test("the agent reads the settings, the change log and the API keys as /admin shows them", async () => {
  const dir = fresh();
  await dir.config.set({ login: "root", admin: true }, "factory", "on");
  await dir.credentials.set({ login: "root", admin: true }, "anthropic", "sk-ant-api03-secretsecretsecret-1234");
  const tools = adminTools(() => ({ dir, who: { login: "root", admin: true } }), ok);
  const call = async (name: string, args = {}) => JSON.parse((await tools.find((t) => t.name == name)!.execute("1", args) as { content: { text: string }[] }).content[0].text);

  const settings = await call("list_settings") as { key: string; value: unknown; updatedBy: string | null }[];
  expect(settings.find((s) => s.key == "factory")).toMatchObject({ value: "on", updatedBy: "root" });
  const log = await call("list_setting_changes", { limit: 5 }) as { total: number; changes: { by: string; changes: { key: string }[] }[] };
  expect(log.total).toBe(2);
  expect(log.changes.map((c) => c.by)).toEqual(["root", "root"]);
  const keys = await call("list_api_keys") as { name: string; stored: boolean; last4: string | null }[];
  expect(keys.find((k) => k.name == "anthropic")).toMatchObject({ stored: true, last4: "1234" });
  expect(JSON.stringify(keys)).not.toContain("sk-ant-secret");
});

test("users the agent adds are added by the admin; without admin power, or the guard refusing, nothing changes", async () => {
  const dir = fresh();
  expect(await session(dir, "root", true).run([{ tool: "add_user", args: { login: "Ada" } }])).toEqual([{ name: "add_user", status: "done" }]);
  expect((await dir.users.get("ada"))?.addedBy).toBe("root");

  const without = await session(dir, "root", false).run([{ tool: "set_setting", args: { key: "factory", value: "on" } }]);
  expect(without[0].status).toBe("error");
  expect(without[0].detail).toMatch(/no admin power/i);

  const refused = await session(dir, "root", true, async () => { throw new Error("Only admins can use the factory."); }).run([{ tool: "set_setting", args: { key: "factory", value: "on" } }]);
  expect(refused[0]).toMatchObject({ status: "error", detail: expect.stringMatching(/Only admins/) });

  const notAdmin = await session(dir, "ada", true).run([{ tool: "set_setting", args: { key: "factory", value: "on" } }]);
  expect(notAdmin[0]).toMatchObject({ status: "error", detail: expect.stringMatching(/Only an admin/) });
  expect((await dir.config.history({ login: "root", admin: true })).total).toBe(0);
});

test("the board's buttons, the dashboard, keys and tokens: each tool does what the page does, as the admin, and says what changed", async () => {
  const calls: string[] = [];
  const task = (id: number) => ({ id, title: `Task ${id}`, status: "complete", branch: `task/${id}-x`, startAfter: [], mergeAfter: [], log: [], screenshots: [], updatedAt: "" }) as unknown as Task;
  const button = (name: string) => async (id: number) => { calls.push(`${name} ${id}`); return id == 9 ? { ok: false, error: `task #9 is merged` } : { ok: true }; };
  const ops = {
    task: async (id: number) => (id == 404 ? null : task(id)),
    start: button("start"), merge: button("merge"), discard: button("discard"), restart: button("restart"),
    tokens: async () => [{ id: "t1", label: "Laptop", created: 1.8e12, expires: 1.9e12 }],
    revokeToken: async (id: string) => { calls.push(`revoke factory token ${id}`); return id == "t1"; },
    signOutClaude: async () => { calls.push("sign out claude"); },
  } as unknown as FactoryOps;
  const dash = {
    release: async (commit?: string) => { calls.push(`release ${commit ?? "head"}`); return { commit: "abc", done: "main moved" }; },
    deployLog: async (target: string) => (target == "staging" ? { lines: Array.from({ length: 300 }, (_, i) => ({ text: `line ${i}` })) } : null),
    redeploy: async (target: string) => { calls.push(`redeploy ${target}`); return { done: `${target} redeploys now` }; },
    revokeAgentToken: async (id: string) => id == "mine",
  } as unknown as DashboardOps;
  let locked = false;
  const guard = async () => { if (locked) throw new Error("Unlock admin access first."); };
  const tools = [...factoryTools(ops, guard), ...dashboardTools(dash, guard)];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const out = await tools.find((t) => t.name == name)!.execute("call", args as never);
    return (out.content[0] as { text: string }).text;
  };
  const fails = (p: Promise<unknown>) => p.then(() => "no error", (e: Error) => e.message);

  expect(await call("merge_task", { id: 3 })).toMatch(/Merge requested for task #3: Task 3/);
  expect(await call("discard_task", { id: 4 })).toMatch(/Discarded task #4/);
  expect(await call("restart_task", { id: 5 })).toMatch(/Restarted task #5/);
  expect(await call("start_task", { id: 6 })).toMatch(/Started task #6/);
  expect(await fails(call("merge_task", { id: 9 }))).toBe("task #9 is merged");
  expect(await fails(call("discard_task", { id: 404 }))).toMatch(/no task #404/);
  expect(await call("list_factory_tokens")).toMatch(/"created": "2027-/);
  expect(await call("revoke_factory_token", { id: "t1" })).toMatch(/"revoked": "t1"/);
  expect(await fails(call("revoke_factory_token", { id: "t2" }))).toMatch(/no working factory token/);
  expect(await call("sign_out_claude")).toMatch(/signed out/);
  expect(await call("deploy_production")).toMatch(/main moved/);
  await call("deploy_production", { commit: " 1234567 " });
  const log = JSON.parse(await call("deploy_log", { target: "staging" }));
  expect([log.lines.length, log.lines[0].text, log.cut]).toEqual([200, "line 100", "the last 200 of 300 lines"]);
  expect(await fails(call("deploy_log", { target: "nope" }))).toMatch(/No such deploy/);
  expect(await call("redeploy", { target: "production" })).toMatch(/production redeploys now/);
  expect(await fails(call("revoke_agent_token", { id: "theirs" }))).toMatch(/You have no token/);
  expect(calls).toEqual(["merge 3", "discard 4", "restart 5", "start 6", "merge 9", "revoke factory token t1", "revoke factory token t2", "sign out claude", "release head", "release 1234567", "redeploy production"]);
  // Admin access locked (or its key revoked): nothing runs.
  locked = true;
  expect(await fails(call("merge_task", { id: 3 }))).toMatch(/Unlock/);
  expect(await fails(call("deploy_production"))).toMatch(/Unlock/);
  expect(calls.length).toBe(11);
});
