// The API keys admins enter on /admin/api-keys, on an
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
    ["SNAPSHOT_TOKEN", false],
  ]);
  expect(deployed.find((d) => d.env == "FACTORY_KEY")!.standIn).toBe(true);
  await expect(dir.credentials.deployed({ login: "mallory" })).rejects.toThrow(NotAllowed);
});

// The real page, on the real directory: what POST /admin/credentials answers, and what the pages show.
const { dir } = fresh("the factory key", ["ANTHROPIC_API_KEY"]);
const session = { login: "ada", name: "Ada", admin: true } as unknown as Session;
const platform = { sessionOf: async () => session, directory: dir } as unknown as Platform;
const server = Bun.serve({
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
  const before = await (await fetch(`${origin}/admin/api-keys`)).text();
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
  const html = await (await fetch(`${origin}/admin/api-keys`)).text();
  expect(html).not.toContain(ANTHROPIC.slice(0, 20));
  expect(html).toContain(`Key saved</span> · <code>…Ab12</code>`);
  const log = await (await fetch(`${origin}/admin/changes`)).text();
  expect(log).toContain(`<span class="key">API key</span> <code>ANTHROPIC_API_KEY</code> set`);
  expect(log).not.toContain(ANTHROPIC.slice(0, 20));
  // The keys have their own page now: Settings has none of them; every key and deploy secret is on API keys.
  expect(await (await fetch(`${origin}/admin`)).text()).not.toContain('li class="provider"');
  expect(html).toContain(`data-name="anthropic"`);
  for (const name of ["openai", "google", "openrouter"]) expect(html).toContain(`data-name="${name}"`);
  expect(html).not.toContain(`data-name="cloudflare_deploy"`);
  // Whose keys the agents use is set here (the list at the top), not on Settings.
  expect(html).toContain(`<option value="server" selected>Server will provide keys</option>`);
  for (const key of ["agent_keys", "agent_models_off"])
    expect(await (await fetch(`${origin}/admin`)).text()).not.toContain(`data-key="${key}"`);
  for (const env of ["SESSION_SECRET", "FACTORY_KEY", "GITHUB_CLIENT_SECRET", "GITHUB_ISSUES_TOKEN", "SNAPSHOT_TOKEN"])
    expect(html).toContain(`data-env="${env}"`);
  expect(html).not.toContain("DEPLOY_HOOK_SECRET");
  expect(html).toContain(`href="/admin/api-keys" aria-current="page"`);
});
