// A request for a token (server/identity/tokens.ts) on an in-memory SQLite database: each change is guarded by the
// request's status, so two approvals, two polls or two code trades never give two tokens, and a request approved
// near its end still waits for its agent.

import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Directory } from "../server/directory/index.ts";
import { REQUEST_MINUTES, Tokens } from "../server/identity/tokens";
import { memory } from "./helpers/memory-sql";

const ada = { login: "ada", name: "Ada" };
const MINUTE = 60_000;
// RFC 7636, appendix B.
const VERIFIER = "dBjftJeZ4CVP-mJ92K9qhqYL5ws8yS7LkwhTo0SGFgY";
const oauth = { client: "c", redirectUri: "http://127.0.0.1:1/cb", challenge: "oD1Tc8EbUgubZqm--TW1jET4nIqfIa0i_UfdTFEhMqI", state: null };

async function server() {
  const sql = memory();
  const dir = new Directory(sql, { admins: ["root"] });
  await dir.users.add({ login: "root", admin: true }, "ada");
  return { sql, tokens: new Tokens(sql, "secret-".repeat(6), dir) };
}
const adasTokens = (sql: ReturnType<typeof memory>) => sql.db.query("SELECT id FROM agent_tokens WHERE login = 'ada'").all().length;

afterEach(() => setSystemTime());

test("two approvals at once make one token, and the second hears there is no request", async () => {
  const { sql, tokens } = await server();
  const asked = await tokens.request("Agent", { scope: "documents" });
  const both = await Promise.all([tokens.approve(asked.userCode, ada), tokens.approve(asked.userCode, ada)]);
  expect(both.filter(Boolean).length).toBe(1);
  expect(adasTokens(sql)).toBe(1);
  expect((await tokens.collect(asked.code)).status).toBe("ready");
});

test("two approvals of an OAuth request at once give one code, and that code trades for the token", async () => {
  const { sql, tokens } = await server();
  const asked = await tokens.request("App", { scope: "documents" }, oauth);
  const both = (await Promise.all([tokens.approve(asked.userCode, ada), tokens.approve(asked.userCode, ada)])).filter(Boolean);
  expect(both.length).toBe(1);
  expect(adasTokens(sql)).toBe(1);
  expect(await tokens.exchange(both[0]!.oauth!.code, "c", oauth.redirectUri, VERIFIER)).not.toBeNull();
});

test("an OAuth code traded two times at once gives the token one time", async () => {
  const { tokens } = await server();
  const asked = await tokens.request("App", { scope: "documents" }, oauth);
  const code = (await tokens.approve(asked.userCode, ada))!.oauth!.code;
  const both = await Promise.all([
    tokens.exchange(code, "c", oauth.redirectUri, VERIFIER),
    tokens.exchange(code, "c", oauth.redirectUri, VERIFIER),
  ]);
  expect(both.filter(Boolean).length).toBe(1);
});

test("two polls at once hand the token over one time", async () => {
  const { tokens } = await server();
  const asked = await tokens.request("Agent", { scope: "documents" });
  await tokens.approve(asked.userCode, ada);
  const both = await Promise.all([tokens.collect(asked.code), tokens.collect(asked.code)]);
  expect(both.map((r) => r.status).sort()).toEqual(["gone", "ready"]);
});

test("a request approved near its end waits for its agent's next poll, past another agent's request", async () => {
  const { tokens } = await server();
  const start = Date.now();
  setSystemTime(start);
  const asked = await tokens.request("Slow", { scope: "documents" });
  setSystemTime(start + (REQUEST_MINUTES - 1) * MINUTE);
  await tokens.approve(asked.userCode, ada);
  setSystemTime(start + (REQUEST_MINUTES + 1) * MINUTE);
  await tokens.request("Another", { scope: "documents" });
  expect((await tokens.collect(asked.code)).status).toBe("ready");
});

test("a token that nobody collects in time stops working", async () => {
  const { sql, tokens } = await server();
  const start = Date.now();
  setSystemTime(start);
  const asked = await tokens.request("Gone", { scope: "documents" });
  await tokens.approve(asked.userCode, ada);
  expect(adasTokens(sql)).toBe(1);
  setSystemTime(start + (REQUEST_MINUTES + 1) * MINUTE);
  expect((await tokens.collect(asked.code)).status).toBe("gone");
  expect(adasTokens(sql)).toBe(0);
});

test("another agent's request clears the requests that ended, and revokes a token that nobody collected", async () => {
  const { sql, tokens } = await server();
  const start = Date.now();
  setSystemTime(start);
  const approved = await tokens.request("Gone", { scope: "documents" });
  await tokens.approve(approved.userCode, ada);
  await tokens.request("Waiting", { scope: "documents" });
  setSystemTime(start + (REQUEST_MINUTES + 1) * MINUTE);
  await tokens.request("New", { scope: "documents" });
  expect(adasTokens(sql)).toBe(0);
  expect(sql.db.query("SELECT label FROM token_requests").all()).toEqual([{ label: "New" }]);
});

test("a denied request can't be approved after, and its agent hears it's gone", async () => {
  const { sql, tokens } = await server();
  const asked = await tokens.request("Agent", { scope: "documents" });
  const both = await Promise.all([tokens.deny(asked.userCode), tokens.approve(asked.userCode, ada)]);
  expect(both.filter(Boolean).length).toBe(1);
  if (both[0]) {
    expect(adasTokens(sql)).toBe(0);
    expect((await tokens.collect(asked.code)).status).toBe("gone");
  }
});
