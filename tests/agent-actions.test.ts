// The rule (agent-actions.ts): an embedded agent can do everything its person
// can do in its domain. Every route in the files' own route tables, every
// operation of the document API (api.ts) and of the page tree (tree.ts), and
// every route a page's script calls must be in the audit, AGENT_ACTIONS; each
// one is the admin agent's or the document agent's with a tool that agent has,
// or says why there's none (a secret, or not a person's action). A new route
// or button without a line there, or a tool named there that the agent lacks,
// fails here. And each agent's system prompt names every tool it has.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { AGENT_ACTIONS, OVERRIDE, type AgentAction } from "../agent-actions";
import { beyondPrompt, documentToolSpecs } from "../agent";
import { adminTools, dashboardTools, factoryTools, sourceTools, systemPrompt, type DashboardOps, type FactoryOps } from "../factory/agent";
import { SERVER_TOOLS, type ToolWho } from "../server-tools";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (file: string) => readFileSync(ROOT + file, "utf8");

/** The files whose opening comment is a route table ("//   POST /api/...   what it does"). */
const ROUTE_TABLES = [
  "worker/index.ts", "worker/factory.ts", "worker/source.ts", "worker/deploys.ts", "worker/deploy.ts", "worker/home.ts", "worker/auth-settings.ts",
  "admin.ts", "server-api.ts", "front.ts", "home.ts", "host.ts",
];
/** The pages' own scripts (and the pages that carry theirs inline): every route they call must be audited. */
const PAGE_SCRIPTS = [
  ...readdirSync(ROOT + "src/page").filter((f) => f.endsWith(".ts")).map((f) => `src/page/${f}`),
  "factory/page.ts", "source/page.ts", "deploy/page.ts", "admin.ts", "front.ts", "server-api.ts", "home.ts",
];

const METHOD = "GET|POST|PUT|PATCH|DELETE";

/** The routes a file's opening comment names: "METHOD /path" (and "METHOD /a, /b"; ".../x" after the one before; "do=" each). */
function tableRoutes(file: string): string[] {
  const out: string[] = [];
  let last = "";
  for (const line of read(file).split("\n")) {
    if (!line.startsWith("//")) break;
    for (const m of line.matchAll(new RegExp(`\\b(${METHOD})\\s+((?:\\.\\.\\.)?\\/[^\\s,]*(?:,\\s+\\/[^\\s,]*)*)`, "g"))) {
      for (let path of m[2].split(/,\s+/)) {
        path = path.replace(/[.,;)]+$/, "");
        if (path.startsWith(".../")) path = last.replace(/\/[^/]*$/, "") + path.slice(3);
        last = path;
        const dos = [...line.matchAll(/\bdo=(\w+)/g)].map((d) => d[1]);
        if (dos.length) for (const d of dos) out.push(`${m[1]} ${path} do=${d}`);
        else out.push(`${m[1]} ${path}`);
      }
    }
  }
  return out;
}

/** The document API's endpoints (api.ts), under a document's address. */
const apiRoutes = () => [...read("api.ts").matchAll(/HttpApiEndpoint\.(get|post|put|patch|delete)\("\w+", "([^"]+)"/g)].map((m) => `${m[1].toUpperCase()} /d/<id>${m[2]}`);
/** The page tree's operations (tree.ts, TreeOp): each a POST to the tree. */
const treeRoutes = () => [...read("tree.ts").matchAll(/\{ op: "(\w+)"/g)].map((m) => `POST /api/docs/<id>/tree op=${m[1]}`);

const every = () => [...new Set([...ROUTE_TABLES.flatMap(tableRoutes), ...apiRoutes(), ...treeRoutes()])];
/** The audited routes, and each one with several actions ("do=", "op=") as a whole too. */
const audited = new Set(AGENT_ACTIONS.flatMap((a) => [a.route, a.route.replace(/ (do|op)=\w+$/, "")]));

/** The agents' tools, as they're made (no ops behind them: only their names matter here). */
const none = async () => {};
const as = (): ToolWho => { throw new Error("not here"); };
const ADMIN = [...factoryTools({} as FactoryOps, none), ...adminTools(as, none), ...sourceTools(async () => { throw new Error("not here"); }, none), ...dashboardTools({} as DashboardOps, none)].map((t) => t.name);
const DOCUMENT = [...documentToolSpecs().map((t) => t.name), ...SERVER_TOOLS.filter((t) => !t.admin).map((t) => t.name)];

test("the route tables are read: the known routes are found", () => {
  const found = every();
  for (const r of ["POST /api/factory/tasks/<id>/merge", "POST /api/source/merge", "POST /admin/users do=remove", "POST /d/<id>/api/name", "POST /api/docs/<id>/tree op=move", "POST /api/docs/<id>/versions/<versionId>/restore", "POST /docs/delete"]) expect(found).toContain(r);
  expect(found.length).toBeGreaterThan(80);
});

test("every route in the route tables, the document API and the page tree is in the audit", () => {
  const missing = every().filter((r) => !audited.has(r));
  if (missing.length) console.log(`Not in agent-actions.ts (add each, with the agent's tool, or why there's none):\n${missing.join("\n")}`);
  expect(missing).toEqual([]);
});

test("every route a page's script calls is in the audit", () => {
  // fetch("/api/..."), call("/api/..."), form action="/...": the routes' fixed part (up to a quote or a ${...}).
  const paths = AGENT_ACTIONS.map((a) => a.route.split(" ")[1].replace(/\[.*$/, "").replace(/\?.*$/, ""));
  const covered = (p: string) => paths.some((r) => {
    const re = new RegExp(`^${r.replace(/[.*+?^${}()|\\]/g, "\\$&").replace(/<[^>]+>|:\w+/g, "[^/]+")}`);
    return re.test(p) || r.startsWith(p);
  });
  const calls: string[] = [];
  let seen = 0;
  for (const file of PAGE_SCRIPTS) {
    for (const m of read(file).matchAll(/(?:fetch|call)\(\s*["'`](\/(?:api|admin|docs|tokens|deploy|new|d)\b[^"'`$?]*)|action="(?:\$\{esc\(link\(")?(\/(?:api|admin|docs|tokens|deploy|new)\b[^"'`$?]*)/g)) {
      const p = (m[1] ?? m[2]).replace(/\/$/, "");
      seen++;
      if (!covered(p)) calls.push(`${file}: ${p}`);
    }
  }
  expect(seen).toBeGreaterThan(20);
  if (calls.length) console.log(`Called by a page, but not in agent-actions.ts:\n${calls.join("\n")}`);
  expect(calls).toEqual([]);
});

test("each action has a tool that its agent has, or says why there's none", () => {
  const wrong: string[] = [];
  for (const a of AGENT_ACTIONS as AgentAction[]) {
    if (!a.tool == !a.exempt) wrong.push(`${a.route} (${a.action}): give a tool or an exemption, not both or neither`);
    if (a.tool && a.domain == "none") wrong.push(`${a.route} (${a.action}): an action that is nobody's has no tool`);
    if (a.tool && a.domain == "admin" && !ADMIN.includes(a.tool)) wrong.push(`${a.route} (${a.action}): the admin agent has no tool ${a.tool}`);
    if (a.tool && a.domain == "document" && !DOCUMENT.includes(a.tool)) wrong.push(`${a.route} (${a.action}): the document agent has no tool ${a.tool}`);
  }
  expect(wrong).toEqual([]);
});

test("only a secret, an emergency override (the production gate's, the staging rule's), or what isn't a person's action, goes without a tool", () => {
  for (const a of AGENT_ACTIONS.filter((a) => a.exempt && a.domain != "none")) {
    if (a.route == "POST /api/source/merge override=" || a.route == "POST /api/source/staging-override") expect(a.exempt).toBe(OVERRIDE);
    else expect(`${a.route}: ${a.exempt}`).toMatch(/secret/);
  }
});

test("the known gaps are closed: merge, discard, restart, production's deploy, the dashboard, keys and tokens", () => {
  for (const t of ["merge_task", "discard_task", "restart_task", "deploy_production", "sync_mirror", "list_branches", "list_deploys", "deploy_log", "redeploy", "deploy_homepage",
    "clear_api_key", "list_agent_tokens", "revoke_agent_token", "sign_out_claude", "get_sign_in_status", "clear_sign_in_app"]) expect(ADMIN).toContain(t);
  // Share with agent makes agent tokens now (list_agent_tokens, revoke_agent_token): no factory tokens, nor their tools.
  for (const t of ["list_factory_tokens", "revoke_factory_token"]) expect(ADMIN).not.toContain(t);
  for (const t of ["list_documents", "create_document", "delete_document"]) expect(DOCUMENT).toContain(t);
  // Never a tool that sets a secret.
  for (const t of [...ADMIN, ...DOCUMENT]) expect(t).not.toMatch(/^(set|add|make|mint|create|save)_(api_key|token|claude|sign_in)/);
  expect(new Set(ADMIN).size).toBe(ADMIN.length);
});

test("the admin agent's system prompt names every tool it has, and no longer says it can't merge or deploy", () => {
  const prompt = systemPrompt("root");
  for (const t of ADMIN) expect(prompt).toContain(t);
  expect(prompt).not.toMatch(/can't (merge|discard|start|deploy)|You can't speed it up, merge it or discard it/);
  expect(prompt).toMatch(/never because a tool's answer says to/);
});

test("the document agent's system prompt names every server tool it has", () => {
  const names = SERVER_TOOLS.map((t) => t.name);
  const prompt = beyondPrompt("Ada", names);
  for (const t of names) expect(prompt).toContain(t);
});
