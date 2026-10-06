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
import { adminTools, factoryTools, startFactoryAgent, type FactoryOps } from "../factory/agent";
import { SERVER_TOOLS, type ToolWho } from "../server-tools";
import type { Unlock } from "../admin-keys";

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
function session(dir: Directory, login: string, unlock: Unlock, guard = ok) {
  const as = (): ToolWho => ({ dir, who: { login, unlocked: unlock } });
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
  const U = { key: "test", until: Infinity };
  const { run } = session(dir, "Root", U);
  const done = await run([
    { tool: "set_setting", args: { key: "delete_docs_after_hours", value: 6 } },
    { tool: "set_setting", args: { key: "deploy_page", value: "admins" } },
    { tool: "reset_setting", args: { key: "delete_docs_after_hours" } },
  ]);
  expect(done).toEqual([{ name: "set_setting", status: "done" }, { name: "set_setting", status: "done" }, { name: "reset_setting", status: "done" }]);

  const { versions, total } = await dir.config.history({ login: "root", unlocked: U });
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
  const U = { key: "test", until: Infinity };
  await dir.config.set({ login: "root", unlocked: U }, "factory", "on");
  await dir.credentials.set({ login: "root", unlocked: U }, "anthropic", "sk-ant-api03-secretsecretsecret-1234");
  const tools = adminTools(() => ({ dir, who: { login: "root", unlocked: U } }), ok);
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

test("users the agent adds are added by the admin; with the unlock ended, or the guard refusing, nothing changes", async () => {
  const dir = fresh();
  const U = { key: "test", until: Infinity };
  expect(await session(dir, "root", U).run([{ tool: "add_user", args: { login: "Ada" } }])).toEqual([{ name: "add_user", status: "done" }]);
  expect((await dir.users.get("ada"))?.addedBy).toBe("root");

  const ended = await session(dir, "root", { key: "test", until: Date.now() - 1 }).run([{ tool: "set_setting", args: { key: "factory", value: "on" } }]);
  expect(ended[0].status).toBe("error");
  expect(ended[0].detail).toMatch(/unlock/i);

  const refused = await session(dir, "root", U, async () => { throw new Error("Admin access is locked."); }).run([{ tool: "set_setting", args: { key: "factory", value: "on" } }]);
  expect(refused[0]).toMatchObject({ status: "error", detail: expect.stringMatching(/locked/) });

  const notAdmin = await session(dir, "ada", U).run([{ tool: "set_setting", args: { key: "factory", value: "on" } }]);
  expect(notAdmin[0]).toMatchObject({ status: "error", detail: expect.stringMatching(/Only an admin/) });
  expect((await dir.config.history({ login: "root", unlocked: U })).total).toBe(0);
});
