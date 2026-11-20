// The API keys admins enter on the Agents and models page (/admin/agents), on an
// in-memory SQLite database with the same migrations D1 gets: stored
// encrypted, never answered back (only set, the last four characters, and who
// set it when), in the changelog without the value, and admins only.

import { afterAll, expect, test } from "bun:test";
import { adminRoutes } from "../server/admin/index.ts";
import { checkKey, CredentialError, Credentials, Directory, keyCheck, NotAllowed } from "../server/directory/index.ts";
import type { Platform, Session } from "../server/platform.ts";
import { quietConsole } from "./helpers/quiet.ts";
import { respond } from "../server/http.ts";
import { memory } from "./helpers/memory-sql";

quietConsole();

const ANTHROPIC = "sk-ant-api03-" + "x".repeat(80) + "Ab12";
const OPENAI = "sk-proj-" + "y".repeat(60) + "Zz90";

/** In the providers' place (no test asks a real one): it knows every key but "nope". */
const provider = (async (_: RequestInfo | URL, init?: RequestInit) =>
  JSON.stringify(init?.headers).includes("nope")
    ? Response.json({ error: { message: "invalid x-api-key" } }, { status: 401 })
    : Response.json({ data: [] })) as typeof fetch;

function fresh(secret: string | null = "the secrets key", fallback: string[] = []) {
  const sql = memory();
  const db = sql.db;
  const dir = new Directory(sql, {
    admins: ["ada"],
    credentialSecret: secret,
    fallback: (env) => fallback.includes(env),
    keyCheck: keyCheck(null, provider),
  });
  return { db, sql, dir };
}
const ada = { login: "ada", admin: true };

test("a key is stored encrypted: the table and the changelog never hold it; the list shows only its last four characters", async () => {
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
  // The changelog: what happened to the key, by whom, never the key.
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
  // The server looks at no key's shape (its provider says whether it is one): only at what no request can carry.
  expect(checkKey("openai", `  ${OPENAI}\n`)).toBe(OPENAI);
  expect(checkKey("anthropic", "any-start.2026")).toBe("any-start.2026");
  expect(() => checkKey("anthropic", "sk-ant-has a space in it xxxxxxxxxxxx")).toThrow(CredentialError);
  expect(() => checkKey("anthropic", "")).toThrow(/Paste/);
  const none = fresh(null, ["ANTHROPIC_API_KEY"]).dir;
  await expect(none.credentials.set(ada, "anthropic", ANTHROPIC)).rejects.toThrow(/no SECRETS_KEY/);
  expect((await none.credentials.list(ada)).map((c) => [c.name, c.canStore, c.fallback])[0]).toEqual(["anthropic", false, true]);
});

test("a key's provider says whether it is one, before it is kept: one request each, and the provider's own reason on the page", async () => {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  let answer = (): Response => Response.json({ data: [] });
  const provider = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input, init);
    const sent = ["x-api-key", "anthropic-version", "x-goog-api-key", "authorization"].flatMap((h) =>
      r.headers.has(h) ? [[h, r.headers.get(h)!]] : []
    );
    asked.push({ url: r.url, headers: Object.fromEntries(sent) });
    return answer();
  }) as typeof fetch;
  const dir = new Directory(memory(), { admins: ["ada"], credentialSecret: "the secrets key", keyCheck: keyCheck(null, provider) });
  const last4 = async (name: string) => (await dir.credentials.list(ada)).find((c) => c.name == name)!.last4;
  // A key of no known start (Google AI Studio's keys of 2026 don't start with AIza): the server's, and a person's own.
  const KEY = "Ab." + "k".repeat(50) + "Qq77";
  for (const name of ["anthropic", "openai", "google", "openrouter"])
    expect((await dir.credentials.set(ada, name, KEY)).last4).toBe("Qq77");
  expect(await dir.personKeys.set({ login: "bob" }, "google", KEY)).toMatchObject({ set: true, last4: "Qq77" });
  expect(asked).toEqual([
    { url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" } },
    { url: "https://api.openai.com/v1/models", headers: { authorization: `Bearer ${KEY}` } },
    { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": KEY } },
    { url: "https://openrouter.ai/api/v1/key", headers: { authorization: `Bearer ${KEY}` } },
    { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": KEY } },
  ]);
  // Each provider refuses a key as it answered a made-up one on 2026-11-19: its words, and the key before stays.
  const OTHER = KEY.replace("Qq77", "Rr88");
  const refusals: [string, number, object | string, string][] = [
    [
      "anthropic",
      401,
      { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
      "Anthropic says: invalid x-api-key",
    ],
    [
      "openai",
      401,
      { error: { message: "Incorrect API key provided: Ab.kkkkk****Rr88.", type: "invalid_request_error", code: "invalid_api_key" } },
      "OpenAI says: Incorrect API key provided: Ab.kkkkk****Rr88.",
    ],
    [
      "google",
      400,
      { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } },
      "Google refuses this key, so it isn't saved. Google says: API key not valid. Please pass a valid API key.",
    ],
    ["openrouter", 401, { error: { message: "User not found.", code: 401 } }, "OpenRouter says: User not found."],
    // A key in the provider's words is cut out; an answer with no words: its status.
    ["openai", 401, { error: { message: `The key ${OTHER} is wrong.` } }, "OpenAI says: The key … is wrong."],
    ["openai", 502, "<html>Bad gateway</html>", "OpenAI says: HTTP 502"],
  ];
  for (const [name, status, body, said] of refusals) {
    answer = () => (typeof body == "string" ? new Response(body, { status }) : Response.json(body, { status }));
    await expect(dir.credentials.set(ada, name, OTHER)).rejects.toThrow(said);
    expect(await last4(name)).toBe("Qq77");
  }
  await expect(dir.personKeys.set({ login: "bob" }, "openrouter", OTHER)).rejects.toThrow("OpenRouter says: HTTP 502");
  // No answer from the provider: not saved, and the page says to try again.
  answer = () => {
    throw new Error("offline");
  };
  await expect(dir.credentials.set(ada, "google", OTHER)).rejects.toThrow(
    "Google gave no answer, so the key isn't checked or saved. Try again."
  );
  expect(await last4("google")).toBe("Qq77");
});

test("the deploy's own secrets only as set or not", async () => {
  const { dir } = fresh("the secrets key", ["SESSION_SECRET", "GITHUB_CLIENT_SECRET"]);
  const deployed = await dir.credentials.deployed(ada);
  expect(deployed.map((d) => [d.env, d.set])).toEqual([
    ["SESSION_SECRET", true],
    ["SECRETS_KEY", false],
    ["GITHUB_CLIENT_SECRET", true],
  ]);
  expect(deployed.find((d) => d.env == "SECRETS_KEY")!.standIn).toBe(true);
  await expect(dir.credentials.deployed({ login: "mallory" })).rejects.toThrow(NotAllowed);
});

// The real page, on the real directory: what POST /admin/credentials answers, and what the pages show.
const { dir } = fresh("the secrets key", ["ANTHROPIC_API_KEY"]);
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
  expect(before).not.toContain(`value="gpt-6.2-sol"`);
  expect((await post({ name: "anthropic", value: ANTHROPIC }, "https://evil.example")).status).toBe(403);
  const r = await post({ name: "anthropic", value: ANTHROPIC });
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).not.toContain(ANTHROPIC.slice(0, 20));
  expect(JSON.parse(text).credential).toMatchObject({ name: "anthropic", set: true, last4: "Ab12" });
  // A key that Anthropic refuses: its reason, for the row.
  const refused = await post({ name: "anthropic", value: "nope" });
  expect([refused.status, await refused.text()]).toEqual([
    400,
    JSON.stringify({ error: "Anthropic refuses this key, so it isn't saved. Anthropic says: invalid x-api-key" }),
  ]);
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

test("the changelog shows a row of the removed factory as plain values: it has no code of its own", async () => {
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

test("the changelog shows Anyone's level with the Access page's words, and an old line of everybody's rule as it was", async () => {
  // Everybody's rule is Anyone's level now; a line from before still names it.
  const old = [
    { key: "access", from: null, to: null, access: { event: "changed", kind: "everybody", value: "", access: "read", from: "none" } },
  ];
  await dir.config.record("ada", old as never, Date.UTC(2026, 9, 2));
  await dir.setAnyone({ login: "ada", admin: true }, "read");
  const log = await (await fetch(`${origin}/admin/changes`)).text();
  expect(log).toContain(
    `<span class="key" title="anyone_access">Anyone</span> <span class="was">No access</span> <span class="to" aria-label="to">→</span> <span class="was">Can view documents shared with them</span>`
  );
  expect(log).toContain(`<span class="key">Access</span> Everybody No access → Can view documents`);
  await dir.setAnyone({ login: "ada", admin: true }, "none");
});
