// A key an admin stores, replaces or clears on /admin/api-keys reaches the
// agent of a document that is already open, at its next turn (document/host.ts reads
// the settings at each turn: agents/models.ts). No real API call: a
// fake fetch answers for Anthropic and records the key each request sent.

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Redacted from "effect/Redacted";
import { startAgent } from "../agents/person/agent.ts";
import { Directory, type Param } from "../server/directory/index.ts";
import { makeHost } from "../document/host.ts";
import { FileStore, Room, StateStore } from "../document/room.ts";
import { documentAgents } from "../agents/document/session";
import { agentSettingsFrom, UNREADABLE_KEY, type AgentSettings } from "../agents/models";
import { memory } from "./helpers/memory-sql";

const KEY1 = "sk-ant-api03-" + "a".repeat(80) + "One1", KEY2 = "sk-ant-api03-" + "b".repeat(80) + "Two2";
const ada = { login: "ada", admin: true };

function directory(secret: string) {
  const sql = memory();
  const db = sql.db;
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

/** Waits until the fake Anthropic has had `n` requests. */
async function requests(n: number) {
  for (let i = 0; i < 400 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  return sent.slice();
}

test("a stored key that doesn't open here (another server's FACTORY_KEY): the agent says so, and what to do", async () => {
  const { db, dir } = directory("production's factory key");
  await dir.credentials.set(ada, "anthropic", KEY1);
  // Staging's database is a copy of production's, but staging's FACTORY_KEY is its own.
  const staging = new Directory({
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...(params as (string | number | null)[])) as T[],
    run: async () => {}, batch: async () => {},
  }, { admins: ["ada"], credentialSecret: "staging's factory key" });
  expect(await agentSettingsFrom({}, staging)).toMatchObject({ missing: UNREADABLE_KEY });
  expect((await staging.credentials.list(ada)).find((c) => c.name == "anthropic")).toMatchObject({ set: true, unreadable: true });
  // A Worker secret still stands in for it.
  expect("missing" in (await agentSettingsFrom({ ANTHROPIC_API_KEY: KEY2 }, staging))).toBe(false);
});

test("the admin agent: a key replaced after its session started reaches its next turn", async () => {
  sent.length = 0;
  const agent = startAgent({
    cfg: { own: {}, server: { anthropic: Redacted.make(KEY1) }, mode: "server", off: [], model: "sonnet", effort: "medium" },
    owner: "ada",
    admin: true,
    tools: [],
  });
  agent.prompt("hello", null);
  expect(await requests(1)).toEqual([KEY1]);
  // agents/person/sessions.ts reads the settings at each turn and gives them to the session it keeps.
  agent.configure({ own: {}, server: { anthropic: Redacted.make(KEY2) }, mode: "server", off: [], model: "sonnet", effort: "medium" });
  await new Promise((r) => setTimeout(r, 50));
  agent.prompt("again", null);
  expect((await requests(2)).at(-1)).toBe(KEY2);
});
