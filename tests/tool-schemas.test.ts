// Every tool, in every list of tools, gives its arguments as an object's JSON Schema ({"type": "object", ...}): MCP
// clients refuse a tools/list with any other (Claude Code did, for the tools with no arguments), and so does the
// Anthropic API for the model's tools. The lists: MCP's tools/list and GET /api/tools
// (server/api.ts), the admin agent's, and the request to the model.

import { expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Directory } from "../server/directory/index.ts";
import type { Platform } from "../server/platform";
import { sessionOf } from "../server/identity/index.ts";
import { serverApi } from "../server/api";
import { respond } from "../server/http";
import { Tokens } from "../server/identity/tokens";
import { agentTools, allTools, KINDS, jsonSchemaOf } from "../agents/tools";
import { argumentsSchema } from "../agents/run";
import { memory } from "./helpers/memory-sql";

const ORIGIN = "https://erga.test";
type Listed = { name: string; schema: { type?: string } };

/** The tools whose schema isn't an object's, by name (none, when all is well). */
const notObjects = (tools: Listed[]) =>
  tools.filter((t) => t.schema?.type != "object").map((t) => `${t.name}: ${JSON.stringify(t.schema)}`);

async function server() {
  const sql = memory();
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

test("GET /api/tools and MCP's tools/list: the few agents' tools, each loaded at once, each inputSchema an object's", async () => {
  const { call } = await server();
  const rest = (await (await call("/api/tools")).json()) as { tools: { name: string; parameters: { type?: string } }[] };
  expect(rest.tools.map((t) => t.name)).toEqual(KINDS.map((k) => k.name));
  expect(notObjects(rest.tools.map((t) => ({ name: t.name, schema: t.parameters })))).toEqual([]);
  const mcp = (await (
    await call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
  ).json()) as {
    result: { tools: { name: string; inputSchema: { type?: string }; _meta?: Record<string, unknown> }[] };
  };
  expect(mcp.result.tools.map((t) => t.name)).toEqual(KINDS.map((k) => k.name));
  expect(notObjects(mcp.result.tools.map((t) => ({ name: t.name, schema: t.inputSchema })))).toEqual([]);
  // Claude Code loads the tools every agent uses at once, not behind its tool search; the admins' wait for a search.
  expect(mcp.result.tools.filter((t) => t._meta?.["anthropic/alwaysLoad"] === true).map((t) => t.name)).toEqual([
    "documents",
    "read",
    "edit",
    "page",
  ]);
  // A tool with no arguments: an object with none.
  expect(jsonSchemaOf(allTools().find((t) => t.name == "sign_in")!) as unknown).toEqual({ type: "object", properties: {} });
});

test("every tool of the registry, the admin agent's own and the model's: an object's schema", () => {
  expect(notObjects(allTools().map((t) => ({ name: t.name, schema: jsonSchemaOf(t) })))).toEqual([]);
  const admin = agentTools(allTools(), null);
  expect(notObjects(admin.map((t) => ({ name: t.name, schema: argumentsSchema(t.parameters) })))).toEqual([]);
  expect(argumentsSchema(Schema.Struct({}))).toEqual({ type: "object", properties: {} });
});
