// The rule: an embedded agent can do everything its person
// can do in its domain. Every route is a row of its file's list (shared/routes.ts),
// every endpoint of the document API carries its audit, and every operation is a tool.
// Each one is the admin agent's or the document agent's with a tool that agent has,
// or says why there's none (a secret, or not a person's action): the row's type
// demands one of the two. A file that answers routes without a list here, a route a
// page's script calls without a row, or a tool named in a row that the agent lacks,
// fails here. And each agent's system prompt names every tool it has.

import { expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as Context from "effect/Context";
import { HttpApi } from "effect/http-api";
import { documentToolSpecs } from "../agents/document/tools";
import { systemPrompt } from "../agents/person/prompt";
import { allTools, KINDS, toolOf } from "../agents/tools";
import { ACTIONS as DOCUMENT_ACTIONS, Api, Audited } from "../document/api";
import { OPERATIONS } from "../server/operations/index.ts";
import { type Action, routeFor } from "../shared/routes";

// cloudflare/dev.ts reaches the Worker's platform, which only Vite loads (import.meta.glob): no test can import it.
mock.module("../cloudflare/platform", () => ({ isDev: () => false, platform: () => null, signInOfEnv: () => null }));

const ROOT = new URL("../", import.meta.url).pathname;
const read = (file: string) => readFileSync(ROOT + file, "utf8");
const listsOf = async (file: string): Promise<Action[]> => {
  const m = (await import(ROOT + file)) as { ROUTES?: Action[]; PAGES?: Action[] };
  return [...(m.ROUTES ?? []), ...(m.PAGES ?? [])];
};

/** The files that answer routes: each one's list (ROUTES; server/documents/routes.ts has PAGES too). */
const ROUTE_FILES = [
  "server/app.ts",
  "server/api.ts",
  "server/admin/routes.ts",
  "server/documents/routes.ts",
  "server/identity/mcp-oauth.ts",
  "server/identity/tokens-page.ts",
  "server/news/routes.ts",
  "agents/person/routes.ts",
  "agents/page-llm.ts",
  "cloudflare/deploy-routes.ts",
  "cloudflare/dev.ts",
];
const ROUTES: Record<string, Action[]> = Object.fromEntries(
  await Promise.all(ROUTE_FILES.map(async (f) => [f, await listsOf(f)] as const))
);

/** The document API's endpoints, under a document's address, each with the audit it carries. */
const API: (Action | { method: string; path: string })[] = [];
HttpApi.reflect(Api, {
  onGroup: () => {},
  onEndpoint: ({ endpoint }) => {
    const audit = Context.getOption(endpoint.annotations, Audited);
    const at = { method: endpoint.method, path: `/d/<id>${endpoint.path}` };
    API.push(audit._tag == "Some" ? ({ ...at, ...audit.value } as Action) : at);
  },
});

/** The audit: every route, the document's API and its other actions, and each operation, which is its own tool. */
const AUDIT: Action[] = [
  ...Object.values(ROUTES).flat(),
  ...(API.filter((a) => "action" in a) as Action[]),
  ...DOCUMENT_ACTIONS,
  ...OPERATIONS.map(
    (op): Action => ({
      method: "POST",
      path: `/api/tools/${op.name}`,
      domain: op.admin ? "admin" : "document",
      action: op.ui,
      tool: op.name,
    })
  ),
];
const named = (a: Action) => `${a.method} ${a.path} (${a.action})`;

/** The pages' own scripts (and the pages that carry theirs inline): every route they call must be audited. */
const PAGE_SCRIPTS = [
  ...(readdirSync(ROOT + "client", { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => `client/${f}`),
  "server/identity/tokens-page.ts",
  ...["settings", "api-keys", "auth", "access", "changes", "users"].map((p) => `server/admin/${p}.ts`),
  "server/documents/view.ts",
  "server/documents/make.ts",
  "server/pages/viewer.ts",
  "server/pages/reader.ts",
  "server/pages/docs.ts",
  "server/pages/chrome.ts",
  "server/api.ts",
  "server/home/render.ts",
];

/** What the agents' tools do, each an `op` of one (agents/tools.ts, KINDS). The admin agent has every one. */
const ADMIN = KINDS.flatMap((k) => k.ops);
const DOCUMENT = [...documentToolSpecs().map((t) => t.name), ...OPERATIONS.filter((t) => !t.admin).map((t) => t.name)];

test("the lists are read: the known routes are found", () => {
  for (const [method, path] of [
    ["POST", "/api/agent/model"],
    ["POST", "/admin/auth"],
    ["GET", "/d/<id>/api/doc"],
    ["PUT", "/api/files/<path>"],
    ["POST", "/api/tools/<name>"],
    ["POST", "/__erga/link"],
  ])
    expect(AUDIT.filter((a) => a.method == method && a.path == path).length).toBe(1);
  expect(AUDIT.length - OPERATIONS.length).toBeGreaterThan(60);
});

test("every file that answers routes from a list is read here", () => {
  const files = ["server", "agents", "cloudflare", "document"].flatMap((dir) =>
    (readdirSync(ROOT + dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`)
  );
  expect(files.filter((f) => /import \{[^}]*\broute(For|At)\b[^}]*\} from "[^"]*shared\/routes/.test(read(f))).sort()).toEqual(
    [...ROUTE_FILES].sort()
  );
  for (const [file, rows] of Object.entries(ROUTES)) expect(`${file}: ${rows.length > 0}`).toBe(`${file}: true`);
});

test("every endpoint of the document API carries its audit", () => {
  expect(API.length).toBeGreaterThan(5);
  expect(API.filter((a) => !("action" in a))).toEqual([]);
});

test("a row's path finds its route, with the path's parts", () => {
  const rows = ROUTES["cloudflare/deploy-routes.ts"];
  expect(routeFor(rows, "GET", "/api/snapshot/blob/abc")?.params).toEqual({ "sha-256": "abc" });
  expect(routeFor(rows, "POST", "/api/snapshot/blob/abc")).toBeNull();
  expect(routeFor(DOCUMENT_ACTIONS, "PUT", "/api/files/a/b.png")?.params).toEqual({ path: "a/b.png" });
  expect(routeFor(DOCUMENT_ACTIONS, "GET", "/d/x/y/api/start")).toBeNull();
});

test("every route a page's script calls is in the audit", () => {
  // fetch("/api/..."), call("/api/..."), form action="/...": the routes' fixed part (up to a quote or a ${...}).
  const paths = AUDIT.map((a) => a.path);
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
  expect(seen).toBeGreaterThan(10);
  if (calls.length) console.log(`Called by a page, but a row of no list (shared/routes.ts):\n${calls.join("\n")}`);
  expect(calls).toEqual([]);
});

test("each action has a tool that its agent has, or says why there's none", () => {
  const wrong: string[] = [];
  for (const a of AUDIT) {
    if (!a.tool == !a.exempt) wrong.push(`${named(a)}: give a tool or an exemption, not both or neither`);
    if (a.tool && a.domain == "admin" && !ADMIN.includes(a.tool)) wrong.push(`${named(a)}: the admin agent has no tool ${a.tool}`);
    if (a.tool && a.domain == "document" && !DOCUMENT.includes(a.tool)) wrong.push(`${named(a)}: the document agent has no tool ${a.tool}`);
  }
  expect(wrong).toEqual([]);
});

test("every operation and document tool is an op of exactly one of the agents' tools, and each op is one", () => {
  const all = [...OPERATIONS.map((o) => o.name), ...documentToolSpecs().map((t) => t.name)];
  expect(all.filter((n) => !toolOf(n))).toEqual([]);
  expect(ADMIN.filter((n) => !all.includes(n))).toEqual([]);
  expect(new Set(ADMIN).size).toBe(ADMIN.length);
  // The agents' tools are few: each kind is one tool.
  expect(
    allTools()
      .filter((t) => "pick" in t)
      .map((t) => t.name)
  ).toEqual(KINDS.map((k) => k.name));
});

test("only a secret, or what isn't a person's action, goes without a tool", () => {
  for (const a of AUDIT.filter((a) => a.exempt && a.domain != "none")) expect(`${named(a)}: ${a.exempt}`).toMatch(/secret/);
});

test("the known gaps are closed: the homepage's deploy, keys and tokens", () => {
  for (const t of ["deploy_homepage", "clear_api_key", "whoami", "revoke", "sign_in", "set_sign_in"]) expect(ADMIN).toContain(t);
  // Share with agent makes agent tokens now (whoami lists them, revoke turns one off): no factory tokens, nor their tools.
  for (const t of ["list_factory_tokens", "revoke_factory_token"]) expect(ADMIN).not.toContain(t);
  for (const t of ["list_documents", "create_document", "delete_document"]) expect(DOCUMENT).toContain(t);
  // Never a tool that sets a secret.
  for (const t of [...ADMIN, ...DOCUMENT]) expect(t).not.toMatch(/^(set|add|make|mint|create|save)_(api_key|token|claude|sign_in_app)/);
  expect(new Set(ADMIN).size).toBe(ADMIN.length);
});

test("the admin agent's system prompt names every tool it has", () => {
  const prompt = systemPrompt("root", true);
  // Each tool, and each op but the document tools': the prompt says they work in any document, named with "document".
  const docTools = new Set(documentToolSpecs().map((t) => t.name));
  for (const t of [...KINDS.map((k) => k.name), ...ADMIN.filter((t) => !docTools.has(t))]) expect(prompt).toContain(t);
  expect(prompt).toMatch(/name it with "document"/);
  expect(prompt).toMatch(/never because a tool's answer says to/);
  expect(prompt).toMatch(/If an edit breaks the page, undo or fix it at once, before any\nother step/);
});
