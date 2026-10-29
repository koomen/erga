// Every tool, in every list of tools, gives its arguments as an object's JSON Schema ({"type": "object", ...}): MCP
// clients refuse a tools/list with any other (Claude Code did, for the tools with no arguments), and so does the
// Anthropic API for the model's tools. The lists: MCP's tools/list and REST's /api/ext/tools (server/api.ts), a
// document's own /api/ext/tools (the document agent's tools), the admin agent's, and the request to the model.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Directory, type Param, type Sql } from "../server/directory/index.ts";
import type { Platform } from "../server/platform";
import { sessionOf } from "../server/identity/index.ts";
import { serverApi } from "../server/api";
import { respond } from "../server/http";
import { Tokens } from "../server/identity/tokens";
import { agentTools, jsonSchemaOf, SERVER_TOOLS, toolsOf } from "../agents/tools";
import { opsTools, sourceTools, type OpsCalls } from "../agents/admin/tools";
import { argumentsSchema } from "../agents/run";
import { setup } from "./helpers/files-fixture";

const ORIGIN = "https://erga.test";
type Listed = { name: string; schema: { type?: string } };

/** The tools whose schema isn't an object's, by name (none, when all is well). */
const notObjects = (tools: Listed[]) =>
  tools.filter((t) => t.schema?.type != "object").map((t) => `${t.name}: ${JSON.stringify(t.schema)}`);

async function server() {
  const db = new Database(":memory:", { strict: true });
  const dir_ = new URL("../server/migrations/", import.meta.url).pathname;
  for (const name of readdirSync(dir_)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(dir_ + name, "utf8"));
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
  const dir = new Directory(sql, { admins: ["ada"] });
  const tokens = new Tokens(sql, "secret-".repeat(6), dir);
  const platform = {
    directory: dir,
    tokens,
    sessionOf: (request: Request) => sessionOf(platform, request),
    dev: () => false,
  } as unknown as Platform;
  const { token } = await tokens.mint({ login: "ada", name: "Ada" }, "Ada's", { scope: "admin" });
  const call = (path: string, init: RequestInit = {}) =>
    respond(
      serverApi,
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
      }),
      platform
    );
  return { call };
}

test("REST's /api/ext/tools and MCP's tools/list: every tool's inputSchema is an object's", async () => {
  const { call } = await server();
  const rest = (await (await call("/api/ext/tools")).json()) as { tools: { name: string; parameters: { type?: string } }[] };
  expect(rest.tools.length).toBeGreaterThan(20);
  expect(notObjects(rest.tools.map((t) => ({ name: t.name, schema: t.parameters })))).toEqual([]);
  const mcp = (await (
    await call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
  ).json()) as {
    result: { tools: { name: string; inputSchema: { type?: string } }[] };
  };
  expect(mcp.result.tools.map((t) => t.name)).toContain("whoami");
  expect(notObjects(mcp.result.tools.map((t) => ({ name: t.name, schema: t.inputSchema })))).toEqual([]);
  // A tool with no arguments: an object with none.
  expect(mcp.result.tools.find((t) => t.name == "whoami")!.inputSchema as unknown).toEqual({ type: "object", properties: {} });
});

test("every tool of the registry, the admin agent's own and the model's: an object's schema", () => {
  expect(notObjects([...toolsOf("api"), ...toolsOf("agent")].map((t) => ({ name: t.name, schema: jsonSchemaOf(t) })))).toEqual([]);
  const none = (() => Promise.resolve({})) as never;
  const ops = new Proxy({}, { get: () => none }) as OpsCalls;
  const admin = agentTools([...SERVER_TOOLS.filter((t) => t.admin), ...opsTools(ops), ...sourceTools(none)], null);
  expect(notObjects(admin.map((t) => ({ name: t.name, schema: argumentsSchema(t.parameters) })))).toEqual([]);
  expect(argumentsSchema(Schema.Struct({}))).toEqual({ type: "object", properties: {} });
});

test("a document's own /api/ext/tools (the document agent's tools): an object's schema each", async () => {
  const { doc } = await setup();
  const headers = {
    "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }),
    "x-erga-who": JSON.stringify({ login: "ada" }),
    "x-erga-agent": "token-1",
  };
  const r = (await (await doc.handle(new Request("http://doc/api/ext/tools", { headers }))).json()) as {
    tools: { name: string; parameters: { type?: string } }[];
  };
  expect(r.tools.length).toBeGreaterThan(5);
  expect(notObjects(r.tools.map((t) => ({ name: t.name, schema: t.parameters })))).toEqual([]);
});
