// Each person's own API keys (server/directory/api-keys.ts, PersonKeys), on an in-memory SQLite database with the same
// migrations D1 gets: a person's key stays theirs. It is stored encrypted and bound to them, never answered back (only
// its last four characters), never in the change log, never another person's, and set only from their own page; their
// agent alone runs on it (agents/models.ts).

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import { Directory, type Param, type Sql } from "../server/directory/index.ts";
import { agentSettingsFrom, keyFor, usable, type AgentConfig } from "../agents/models.ts";
import { agentApi } from "../agents/person/sessions.ts";
import { OPERATIONS, runOperation } from "../server/operations/index.ts";
import type { Platform, Session } from "../server/platform.ts";
import { respond } from "../server/http.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;
const OPENAI = "sk-proj-" + "q".repeat(60) + "Ow42";
const OPENROUTER = "sk-or-v1-" + "r".repeat(60) + "Rt77";

function fresh(secret: string | null = "the factory key") {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => {
      db.query(q).run(...bind(params));
    },
    batch: async (statements) => {
      db.transaction(() => {
        for (const [q, ...params] of statements) db.query(q).run(...bind(params));
      })();
    },
  };
  return { db, sql, dir: new Directory(sql, { admins: ["ada"], credentialSecret: secret }) };
}

const ada = { login: "ada", admin: true },
  bob = { login: "bob" };
const op = (name: string) => OPERATIONS.find((o) => o.name == name)!;

test("a person's key is stored encrypted, bound to them: never answered, never another's, never in the change log", async () => {
  const { db, dir } = fresh();
  const set = await dir.personKeys.set(bob, "openai", `  ${OPENAI}\n`);
  expect(set).toMatchObject({ name: "openai", set: true, last4: "Ow42", unreadable: false });
  // Bob's list: the last four characters only. Ada's: nothing of Bob's.
  expect(JSON.stringify(await dir.personKeys.list(bob))).not.toContain("qqqqqqqq");
  expect((await dir.personKeys.list(ada)).every((k) => !k.set)).toBe(true);
  expect(await dir.personKeys.opened("bob")).toEqual({ openai: OPENAI });
  expect(await dir.personKeys.opened("ada")).toEqual({});
  // The table and the change log never hold the key.
  const everything = JSON.stringify([db.query("SELECT * FROM person_keys").all(), db.query("SELECT * FROM server_config_versions").all()]);
  expect(everything).not.toContain(OPENAI.slice(0, 20));
  expect(everything).not.toContain(btoa(OPENAI).slice(0, 20));
  expect((await dir.config.history(ada)).versions).toEqual([]);
  // Bob's row, copied under Ada's name, doesn't open for her: each key is bound to its person.
  db.query(
    "INSERT INTO person_keys (login, name, iv, data, last4, updated) SELECT 'ada', name, iv, data, last4, updated FROM person_keys WHERE login = 'bob'"
  ).run();
  expect(await dir.personKeys.opened("ada")).toEqual({});
  expect((await dir.personKeys.list(ada)).find((k) => k.name == "openai")).toMatchObject({ set: true, unreadable: true });
  // Another server's secret (staging's) opens none.
  expect(await fresh().dir.personKeys.opened("bob")).toEqual({});
  // Removed: gone.
  expect(await dir.personKeys.clear(bob, "openai")).toMatchObject({ set: false, last4: null });
  expect(await dir.personKeys.opened("bob")).toEqual({});
});

test("a wrong key is refused, saying why; a server with no FACTORY_KEY can't store one", async () => {
  const { dir } = fresh();
  await expect(dir.personKeys.set(bob, "openai", OPENROUTER)).rejects.toThrow(/That is an OpenRouter API key, not an OpenAI API key/);
  await expect(dir.personKeys.set(bob, "mistral", OPENAI)).rejects.toThrow(/no key "mistral"/);
  await expect(fresh(null).dir.personKeys.set(bob, "openai", OPENAI)).rejects.toThrow(/no FACTORY_KEY/);
});

test("the agent's settings: only that person's own keys, and the admin's choices", async () => {
  const { dir } = fresh();
  await dir.personKeys.set(bob, "openrouter", OPENROUTER);
  const env = { ANTHROPIC_API_KEY: "sk-ant-api03-" + "s".repeat(80) };
  const bobs = (await agentSettingsFrom(env, dir, "bob")) as AgentConfig;
  const adas = (await agentSettingsFrom(env, dir, "ada")) as AgentConfig;
  expect(usable(bobs).map((u) => `${u.choice}:${u.key}`)).toEqual([
    "opus-fast:server",
    "opus:server",
    "sonnet:server",
    "haiku:server",
    "grok:own",
    "kimi-k3:own",
    "deepseek-v4-pro:own",
  ]);
  expect(Redacted.value(keyFor(bobs, "kimi-k3")!)).toBe(OPENROUTER);
  expect(usable(adas).map((u) => u.choice)).toEqual(["opus-fast", "opus", "sonnet", "haiku"]);
  expect(keyFor(adas, "kimi-k3")).toBeNull();
  // Own keys only: the server's key runs nothing; a person with none has their agent off, and is told what to do.
  await dir.config.set(ada, "agent_keys", "own");
  expect(usable((await agentSettingsFrom(env, dir, "bob")) as AgentConfig).map((u) => u.choice)).toEqual([
    "grok",
    "kimi-k3",
    "deepseek-v4-pro",
  ]);
  expect(await agentSettingsFrom(env, dir, "ada")).toMatchObject({ missing: expect.stringContaining("bring their own API key") });
});

test("the operations: the person's own list and remove; an agent never sees a key", async () => {
  const { dir } = fresh();
  await dir.personKeys.set(bob, "openai", OPENAI);
  const platform = { tokens: { list: async () => [] } };
  const caller = { dir, who: { login: "bob", via: "agent" }, name: "Bob", origin: "http://x", platform } as never;
  const listed = JSON.stringify(((await runOperation(op("whoami"), {}, caller)) as { apiKeys: unknown }).apiKeys);
  expect(listed).toContain('"last4":"Ow42"');
  expect(listed).not.toContain("qqqqqqqq");
  expect(await runOperation(op("revoke"), { api_key: "openai" }, caller)).toMatchObject({ removed: "openai" });
  expect(await dir.personKeys.opened("bob")).toEqual({});
});

// The page's route: POST /api/agent/keys, the person in their browser, from this site's pages only.
const { dir } = fresh();
let session: Partial<Session> | null = { login: "bob", name: "Bob" };
// The person's agent object isn't reached: the key goes to the directory.
const platform = { sessionOf: async () => session, directory: dir, personAgent: () => ({}) } as unknown as Platform;
const server = Bun.serve({ port: 0, fetch: (r) => respond(agentApi, r, platform) });
const origin = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

test("POST /api/agent/keys: from the person's own page only; the answer never holds the key", async () => {
  const post = (b: object, headers: Record<string, string> = { Origin: origin }) =>
    fetch(`${origin}/api/agent/keys`, {
      method: "POST",
      body: JSON.stringify(b),
      headers: { "Content-Type": "application/json", ...headers },
    });
  expect((await post({ name: "openai", value: OPENAI }, { Origin: "https://evil.example" })).status).toBe(403);
  expect((await post({ name: "openai", value: OPENAI }, { Origin: origin, Authorization: "Bearer erga_x" })).status).toBe(403);
  const r = await post({ name: "openai", value: OPENAI });
  const text = await r.text();
  expect(r.status).toBe(200);
  expect(text).not.toContain(OPENAI.slice(0, 20));
  expect(JSON.parse(text).key).toMatchObject({ name: "openai", set: true, last4: "Ow42" });
  expect((await post({ name: "openai", value: "nope" })).status).toBe(400);
  // An agent's token session (or a test person) can't set one.
  session = { login: "bob", name: "Bob", agent: {} } as unknown as Partial<Session>;
  expect((await post({ name: "openai", value: OPENAI })).status).toBe(403);
  session = { login: "bob", name: "Bob" };
  expect(await dir.personKeys.opened("bob")).toEqual({ openai: OPENAI });
  expect(await dir.personKeys.opened("ada")).toEqual({});
});
