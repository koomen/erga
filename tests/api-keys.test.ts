// The API keys admins enter on the Agents and models page (/admin/agents), on an
// in-memory SQLite database with the same migrations D1 gets: stored
// encrypted, never answered back (only set, the last four characters, and who
// set it when), in the change log without the value, and admins only.

import { afterAll, expect, test } from "bun:test";
import { adminRoutes } from "../server/admin/index.ts";
import { checkKey, CredentialError, Credentials, Directory, NotAllowed } from "../server/directory/index.ts";
import type { Platform, Session } from "../server/platform.ts";
import { quietConsole } from "./helpers/quiet.ts";
import { respond } from "../server/http.ts";
import { memory } from "./helpers/memory-sql";

quietConsole();

const ANTHROPIC = "sk-ant-api03-" + "x".repeat(80) + "Ab12";
const OPENAI = "sk-proj-" + "y".repeat(60) + "Zz90";

function fresh(secret: string | null = "the factory key", fallback: string[] = []) {
  const sql = memory();
  const db = sql.db;
  const dir = new Directory(sql, { admins: ["ada"], credentialSecret: secret, fallback: (env) => fallback.includes(env) });
  return { db, sql, dir };
}
const ada = { login: "ada", admin: true };

test("a key is stored encrypted: the table and the change log never hold it; the list shows only its last four characters", async () => {
  const { db, dir } = fresh();
  const set = await dir.credentials.set(ada, "anthropic", `  ${ANTHROPIC}\n`);
  expect(set).toMatchObject({ name: "anthropic", env: "ANTHROPIC_API_KEY", set: true, last4: "Ab12", updatedBy: "ada", canStore: true });
  expect(JSON.stringify(await dir.credentials.list(ada))).not.toContain("xxxxxxxx");
  const everything = JSON.stringify([db.query("SELECT * FROM credentials").all(), db.query("SELECT * FROM server_config_versions").all()]);
  expect(everything).not.toContain(ANTHROPIC.slice(0, 20));
  expect(everything).not.toContain(btoa(ANTHROPIC).slice(0, 20));
  expect(await dir.credentials.value("anthropic")).toBe(ANTHROPIC);

  await dir.credentials.set(ada, "anthropic", ANTHROPIC.replace("Ab12", "Cd34"));
  expect(await dir.credentials.value("anthropic")).toBe(ANTHROPIC.replace("Ab12", "Cd34"));
  const cleared = await dir.credentials.clear(ada, "anthropic");
  expect(cleared).toMatchObject({ set: false, last4: null, updated: null });
  expect(await dir.credentials.value("anthropic")).toBeNull();
  // The change log: what happened to the key, by whom, never the key.
  const { versions } = await dir.config.history(ada);
  expect(versions.map((v) => [v.by, v.changes])).toEqual([
    ["ada", [{ key: "ANTHROPIC_API_KEY", from: null, to: null, credential: "cleared" }]],
    ["ada", [{ key: "ANTHROPIC_API_KEY", from: null, to: null, credential: "replaced" }]],
    ["ada", [{ key: "ANTHROPIC_API_KEY", from: null, to: null, credential: "set" }]],
  ]);
});

test("a fresh IV each time; another secret (staging, with a copy of production's database) can't open it", async () => {
  const { db, sql, dir } = fresh();
  await dir.credentials.set(ada, "anthropic", ANTHROPIC);
  const first = db.query("SELECT iv, data FROM credentials").get() as { iv: string; data: string };
  await dir.credentials.set(ada, "anthropic", ANTHROPIC);
  const second = db.query("SELECT iv, data FROM credentials").get() as { iv: string; data: string };
  expect(second.iv).not.toBe(first.iv);
  expect(second.data).not.toBe(first.data);
  const elsewhere = new Credentials(sql, dir.users, "another key");
  expect(await elsewhere.value("anthropic")).toBeNull();
});

test("admins only, with admin power; a key that isn't one, or a server with no secret, is refused saying why", async () => {
  const { dir } = fresh();
  await expect(dir.credentials.set({ login: "mallory" }, "anthropic", ANTHROPIC)).rejects.toThrow(NotAllowed);
  await expect(dir.credentials.list({ login: "ada" })).rejects.toThrow(/no admin power/);
  await expect(dir.credentials.set(ada, "gemini", ANTHROPIC)).rejects.toThrow(/no key "gemini"/);
  // An OpenAI key starts with sk-, as Anthropic's does: one pasted in the wrong row is named.
  await expect(dir.credentials.set(ada, "openai", ANTHROPIC)).rejects.toThrow(/That is an Anthropic API key, not an OpenAI API key/);
  expect(checkKey("openai", OPENAI)).toBe(OPENAI);
  expect(() => checkKey("anthropic", "sk-ant-oat01-" + "z".repeat(40))).toThrow(/Claude plan token/);
  expect(() => checkKey("anthropic", OPENAI)).toThrow(/starts with sk-ant-/);
  expect(() => checkKey("anthropic", "sk-ant-has a space in it xxxxxxxxxxxx")).toThrow(CredentialError);
  expect(() => checkKey("anthropic", "")).toThrow(/Paste/);
  const none = fresh(null, ["ANTHROPIC_API_KEY"]).dir;
  await expect(none.credentials.set(ada, "anthropic", ANTHROPIC)).rejects.toThrow(/no FACTORY_KEY/);
  expect((await none.credentials.list(ada)).map((c) => [c.name, c.canStore, c.fallback])[0]).toEqual(["anthropic", false, true]);
});

test("the deploy's own secrets only as set or not", async () => {
  const { dir } = fresh("the factory key", ["SESSION_SECRET", "GITHUB_CLIENT_SECRET"]);
  const deployed = await dir.credentials.deployed(ada);
  expect(deployed.map((d) => [d.env, d.set])).toEqual([
    ["SESSION_SECRET", true],
    ["FACTORY_KEY", false],
    ["GITHUB_CLIENT_SECRET", true],
    ["GITHUB_ISSUES_TOKEN", false],
  ]);
  expect(deployed.find((d) => d.env == "FACTORY_KEY")!.standIn).toBe(true);
  await expect(dir.credentials.deployed({ login: "mallory" })).rejects.toThrow(NotAllowed);
});

// The real page, on the real directory: what POST /admin/credentials answers, and what the pages show.
const { dir } = fresh("the factory key", ["ANTHROPIC_API_KEY"]);
const session = { login: "ada", name: "Ada", admin: true } as unknown as Session;
const platform = { sessionOf: async () => session, directory: dir } as unknown as Platform;
const server = Bun.serve({
  // (Its own address: with all addresses, a test server of the browser tests can take the same port on 127.0.0.1.)
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (r) => {
    const path = new URL(r.url).pathname;
    return path == "/admin" || path.startsWith("/admin/") ? respond(adminRoutes, r, platform) : new Response("", { status: 404 });
  },
});
const origin = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

test("POST /admin/credentials: only from this site's pages; the answer never holds the key", async () => {
  const post = (fields: Record<string, string>, from = origin) =>
    fetch(`${origin}/admin/credentials`, { method: "POST", body: new URLSearchParams(fields), headers: { Origin: from } });
  const before = await (await fetch(`${origin}/admin/agents`)).text();
  expect(before).toContain("Using the deploy's</span> <code>ANTHROPIC_API_KEY</code>");
  // A provider's models show once the server has a key for it: Anthropic's (the deploy's), not OpenAI's.
  expect(before).toContain(`value="sonnet" checked`);
  expect(before).not.toContain(`value="gpt-6.1-sol"`);
  expect((await post({ name: "anthropic", value: ANTHROPIC }, "https://evil.example")).status).toBe(403);
  const r = await post({ name: "anthropic", value: ANTHROPIC });
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).not.toContain(ANTHROPIC.slice(0, 20));
  expect(JSON.parse(text).credential).toMatchObject({ name: "anthropic", set: true, last4: "Ab12" });
  expect((await post({ name: "anthropic", value: "nope" })).status).toBe(400);
  expect((await post({ name: "gemini", value: OPENAI })).status).toBe(400);
  const html = await (await fetch(`${origin}/admin/agents`)).text();
  expect(html).not.toContain(ANTHROPIC.slice(0, 20));
  // The page shows only the key's last 4 characters, with Replace and Remove; its box is closed until Replace.
  expect(html).toContain(`<code class="masked" aria-label="The key ends in Ab12">•••• Ab12</code>`);
  expect(html).toMatch(/class="pill replace"[^>]*>Replace<\/button><button type="button" class="pill clear">Remove<\/button>/);
  const log = await (await fetch(`${origin}/admin/changes`)).text();
  expect(log).toContain(`<span class="key">API key</span> <code>ANTHROPIC_API_KEY</code> set`);
  expect(log).not.toContain(ANTHROPIC.slice(0, 20));
  // Every agent setting is on Agents: the keys, whose keys (the list at the top) and the daily token limit (with No
  // limit). The deploy's secrets are on Settings (tests/settings.test.ts).
  expect(html).toContain(`data-name="anthropic"`);
  for (const name of ["openai", "google", "openrouter"]) expect(html).toContain(`data-name="${name}"`);
  expect(html).not.toContain(`data-name="cloudflare_deploy"`);
  expect(html).toContain(`<option value="server" selected>Server will provide keys</option>`);
  expect(html).toContain(`data-key="agent_daily_tokens"`);
  expect(html).toContain(`<option value="never">No limit</option>`);
  expect(html).not.toContain(`data-env="SESSION_SECRET"`);
  expect(html).toContain(`href="/admin/agents" aria-current="page"`);
  expect((await fetch(`${origin}/admin/api-keys`)).status).toBe(404);
});

test("the change log shows a row of the removed factory as plain values: it has no code of its own", async () => {
  // Rows as the factory wrote them, before it went: a task, main moved with its commits, a push past the old staging
  // rule, a user's deploy role. The production database still has such rows.
  const old = [
    { key: "task", from: null, to: null, task: { id: 12, title: "A task", event: "merged", commit: "a".repeat(40) } },
    {
      key: "main",
      from: "1".repeat(40),
      to: "2".repeat(40),
      release: { commits: [{ sha: "2".repeat(40), subject: "A commit" }], total: 1 },
    },
    { key: "staging", from: null, to: null, stagingOverride: { reason: "an emergency", until: 1 } },
    { key: "user", from: null, to: null, user: { login: "bo", event: "deploy", deploy: true } },
  ];
  await dir.config.record("ada", old as never, Date.UTC(2026, 9, 1), "the factory (task #12)");
  const r = await fetch(`${origin}/admin/changes`);
  expect(r.status).toBe(200);
  const log = await r.text();
  // Each row is there, as a key with its values; the via is the text as it was recorded.
  expect(log).toContain(`<span class="key" title="main">main</span> <span class="was">“${"1".repeat(40)}”</span>`);
  expect(log).toContain(`<span class="key" title="task">task</span> <span class="was">never</span>`);
  expect(log).toContain(`<span class="key">User</span> <span class="title">bo</span> deploy`);
  expect(log).toContain(`title="via the factory (task #12)">the factory (task #12)</span>`);
  // Nothing of the factory's own lines.
  for (const gone of ["Task #12", "A task", "A commit", "merged into", "overridden", "an emergency", "deploy role", "factory #12"])
    expect(log).not.toContain(gone);
});
