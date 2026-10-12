// A key an admin stores, replaces or clears on /admin/api-keys reaches the
// agent of a document that is already open, at its next turn (document/host.ts reads
// the settings at each turn: cloudflare/agent-settings.ts). No real API call: a
// fake fetch answers for Anthropic and records the key each request sent.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Redacted from "effect/Redacted";
import { startAdminAgent } from "../agents/admin.ts";
import { Directory, type Param, type Sql } from "../server/directory/index.ts";
import { makeHost } from "../document/host.ts";
import { FileStore, Room, StateStore } from "../document/room.ts";
import { agentSettingsFrom, UNREADABLE_KEY } from "../cloudflare/agent-settings.ts";

const MIGRATIONS = new URL("../server/migrations/", import.meta.url).pathname;
const KEY1 = "sk-ant-api03-" + "a".repeat(80) + "One1", KEY2 = "sk-ant-api03-" + "b".repeat(80) + "Two2";
const ada = { login: "ada", admin: true };

function directory(secret: string) {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  return { db, dir: new Directory(sql, { admins: ["ada"], credentialSecret: secret }) };
}

// Anthropic, faked: every request's key is recorded, and the answer is a 401 (the turn ends with that error).
const sent: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    sent.push(new Headers(input instanceof Request ? input.headers : init?.headers).get("x-api-key") ?? "");
    return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

async function openDocument(settings: Parameters<typeof makeHost>[0]["agent"]) {
  const data = new Map([["index.html", new TextEncoder().encode("<p>Hello</p>")]]);
  const files = FileStore.of({
    list: Effect.sync(() => [...data.keys()]),
    read: (p) => Effect.sync(() => data.get(p) ?? null),
    write: (p, text) => Effect.sync(() => { data.set(p, new TextEncoder().encode(text)); }),
  });
  const scope = Effect.runSync(Scope.make());
  const room = await Effect.runPromise(Room.make({}).pipe(Effect.provide(Layer.merge(Layer.succeed(FileStore, files), StateStore.none)), Scope.provide(scope)));
  const host = makeHost({
    room, files, agent: settings,
    doc: { name: "index.html", path: "index.html", kind: "html", dir: "ada" },
    personOf: () => ({ id: "ada", name: "Ada" }),
    agentOf: () => null,
    baseUrl: () => "",
  });
  const call = async (method: "GET" | "POST", body?: unknown) => {
    const r = await host.handler(new Request("http://doc.test/api/agent", { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }));
    return { status: r.status, body: (await r.json()) as { ok?: boolean; reason?: string; enabled?: boolean } };
  };
  return { prompt: (text: string) => call("POST", { text }), state: () => call("GET"), close: () => Effect.runPromise(Scope.close(scope, Effect.void)) };
}

/** Waits until the fake Anthropic has had `n` requests. */
async function requests(n: number) {
  for (let i = 0; i < 400 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return sent.slice();
}

test("a document is open; an admin stores a key, replaces it, clears it: each reaches the open document's agent at its next turn", async () => {
  sent.length = 0;
  const { dir } = directory("staging's factory key");
  const doc = await openDocument(() => agentSettingsFrom({}, dir.credentials));
  try {
    // No key yet: the panel says so, and what to do.
    let st = await doc.state();
    expect(st.body.enabled).toBe(false);
    expect(st.body.reason).toContain("/admin/api-keys");
    expect((await doc.prompt("hello")).body.reason).toContain("ANTHROPIC_API_KEY is not set");

    // The admin stores a key: the same open document's next turn uses it, with no reload.
    await dir.credentials.set(ada, "anthropic", KEY1);
    expect((await doc.state()).body.enabled).toBe(true);
    expect((await doc.prompt("hello")).body.ok).toBe(true);
    expect(await requests(1)).toEqual([KEY1]);

    // Replaced: the next turn sends the new key.
    await dir.credentials.set(ada, "anthropic", KEY2);
    await new Promise((r) => setTimeout(r, 50));
    expect((await doc.prompt("again")).body.ok).toBe(true);
    expect((await requests(2)).at(-1)).toBe(KEY2);

    // Cleared: the agent is off again, and says why.
    await dir.credentials.clear(ada, "anthropic");
    const off = await doc.prompt("and again");
    expect(off.body.ok).toBe(false);
    expect(off.body.reason).toContain("ANTHROPIC_API_KEY is not set");
    expect(sent.length).toBe(2);
  } finally {
    await doc.close();
  }
});

test("a stored key that doesn't open here (another server's FACTORY_KEY): the agent says so, and what to do", async () => {
  const { db, dir } = directory("production's factory key");
  await dir.credentials.set(ada, "anthropic", KEY1);
  // Staging's database is a copy of production's, but staging's FACTORY_KEY is its own.
  const staging = new Directory({
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...(params as (string | number | null)[])) as T[],
    run: async () => {}, batch: async () => {},
  }, { admins: ["ada"], credentialSecret: "staging's factory key" });
  expect(await agentSettingsFrom({}, staging.credentials)).toEqual({ missing: UNREADABLE_KEY });
  expect((await staging.credentials.list(ada)).find((c) => c.name == "anthropic")).toMatchObject({ set: true, unreadable: true });
  // A Worker secret still stands in for it.
  expect("missing" in (await agentSettingsFrom({ ANTHROPIC_API_KEY: KEY2 }, staging.credentials))).toBe(false);
});

test("the admin agent: a key replaced after its session started reaches its next turn", async () => {
  sent.length = 0;
  const agent = startAdminAgent({ cfg: { apiKey: Redacted.make(KEY1), model: "sonnet", effort: "medium" }, owner: "ada", tools: [] });
  agent.prompt("hello", null);
  expect(await requests(1)).toEqual([KEY1]);
  // server/admin/agent.ts reads the settings at each turn and gives them to the session it keeps.
  agent.configure({ apiKey: Redacted.make(KEY2), model: "sonnet", effort: "medium" });
  await new Promise((r) => setTimeout(r, 50));
  agent.prompt("again", null);
  expect((await requests(2)).at(-1)).toBe(KEY2);
});
