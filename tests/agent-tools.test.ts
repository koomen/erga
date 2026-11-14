// The tools every agent has (the server's operations), on an in-memory directory:
// one set for every agent, admin tools only with admin power (never the editor's agent's), a setting the deploy
// locks seen but not changed, users managed as an admin can, sharing by a document's owner, and the editor's agent
// working in another document.

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, type Who } from "../server/directory/index.ts";
import { agentTools, allTools, documentTools, documentToolsHere, KINDS, opsOf, runTool, toolsFor } from "../agents/tools";
import { type Caller, OPERATIONS, OperationError } from "../server/operations/index.ts";
import { VIA } from "../shared/attribution";
import type { Platform } from "../server/platform";
import { newDocMenu, templateById } from "../server/pages/templates.ts";
import { person, runTool as overHttp, server, signedOut } from "./helpers/app";
import { memory } from "./helpers/memory-sql";

function fresh(opts: ConstructorParameters<typeof Directory>[1] = {}): Directory {
  const sql = memory();
  return new Directory(sql, opts);
}

const tool = (name: string) => allTools().find((t) => t.name == name)!;
const run = (ctx: Caller, name: string, args: Record<string, unknown> = {}) => runTool(tool(name), args, ctx) as Promise<any>;
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as OperationError;
  }
  throw new Error("it didn't fail");
};

test("admin tools are offered to admins only, and refused to anyone else", async () => {
  const dir = fresh({ admins: ["root"] });
  await dir.users.add({ login: "root", admin: true }, "bo");
  const names = async (who: Who) => (await toolsFor({ dir, who, here: "aaaaaaaa" })).map((t) => t.name);
  const ops = async (who: Who) => (await toolsFor({ dir, who, here: "aaaaaaaa" })).flatMap(opsOf);
  expect(await names({ login: "root", admin: true })).toEqual(KINDS.map((k) => k.name));
  expect(await ops({ login: "root", admin: true })).toContain("set_setting");
  expect(await names({ login: "bo" })).toEqual(["documents", "read", "edit", "page"]);
  expect((await ops({ login: "bo" })).sort()).toEqual(
    [...OPERATIONS.filter((o) => !o.admin).map((o) => o.name), ...documentTools().map((t) => t.name)].sort()
  );
  const e = await failure(run({ dir, who: { login: "bo" } }, "settings"));
  expect(e).toBeInstanceOf(OperationError);
  expect(e.status).toBe(403);
  // A person's own agent gets the same, as its loop runs them.
  const bo = { dir, who: { login: "bo" }, here: "aaaaaaaa" };
  expect(agentTools(await toolsFor(bo, true), bo).map((t) => t.name)).toEqual(await names({ login: "bo" }));
  const root = { dir, who: { login: "root", admin: true } };
  const forRoot = agentTools(await toolsFor(root, true), root);
  const out = await forRoot.find((t) => t.name == "settings")!.execute("x", {});
  expect(JSON.parse((out.content[0] as { text: string }).text).settings.map((e: { key: string }) => e.key)).toContain(
    "delete_docs_after_hours"
  );
});

test("settings: set, a number given as a string, bad values explained, reset, locked ones refused", async () => {
  const dir = fresh({ admins: ["root"] });
  const root = { dir, who: { login: "root", admin: true } };
  expect((await run(root, "set_setting", { key: "delete_docs_after_hours", value: 48 })).value).toBe(48);
  const set = await run(root, "set_setting", { key: "delete_docs_after_hours", value: "12" });
  expect([set.value, set.source, set.updatedBy, set.locked]).toEqual([12, "set", "root", false]);
  let e = await failure(run(root, "set_setting", { key: "delete_docs_after_hours", value: -1 }));
  expect([e.status, /whole number/.test(e.message)]).toEqual([400, true]);
  e = await failure(run(root, "set_setting", { key: "nope", value: 1 }));
  expect([e.status, e.message.includes("delete_docs_after_hours")]).toEqual([400, true]);
  // Never: null, or "null" / "never" as a model may send it.
  for (const value of [null, "null", "never"]) expect((await run(root, "set_setting", { key: "delete_docs_after_hours", value })).value).toBeNull();
  expect((await run(root, "set_setting", { key: "delete_docs_after_hours", reset: true })).source).toBe("default");

  const locked = fresh({ admins: ["root"], locked: { delete_docs_after_hours: 6 } });
  const lroot = { dir: locked, who: { login: "root", admin: true } };
  const entry = (await run(lroot, "settings")).settings.find((e: { key: string }) => e.key == "delete_docs_after_hours");
  expect([entry.value, entry.source, entry.locked]).toEqual([6, "locked", true]);
  e = await failure(run(lroot, "set_setting", { key: "delete_docs_after_hours", value: 10 }));
  expect([e.status, /fixed by the deploy/.test(e.message)]).toEqual([403, true]);
  e = await failure(run(lroot, "set_setting", { key: "delete_docs_after_hours", reset: true }));
  expect(e.status).toBe(403);
});

test("users: add by provider account with a role, make admin, demote, remove; bootstrap admins and yourself are kept", async () => {
  const dir = fresh({
    admins: ["root"],
    providers: ["github", "google"],
    lookup: async (_provider, login) => (login.startsWith("no-such-") ? null : { subject: String(login.length), handle: login }),
  });
  const root = { dir, who: { login: "root", admin: true } };
  // Before their first sign-in: their GitHub account (its id found) or Google email, and one role.
  const { person } = await run(root, "set_user", { action: "add", provider: "github", handle: "Cy", role: "read" });
  expect(person).toMatchObject({
    waiting: true,
    provider: "github",
    handle: "cy",
    role: "read",
    roleLabel: "Can authenticate",
    addedBy: "root",
  });
  expect((await run(root, "set_user", { action: "role", person: person.person, role: "write" })).roleLabel).toBe(
    "Can create and edit content"
  );
  expect(
    (await failure(run(root, "set_user", { action: "add", provider: "github", handle: "no-such-one", role: "read" }))).message
  ).toMatch(/GitHub has no account/);
  expect((await run(root, "set_user", { action: "add", provider: "github", handle: "root", role: "admin" })).note).toBe(
    "root is already an admin."
  );
  expect(await run(root, "set_user", { action: "remove", person: person.person })).toEqual({ removed: { person: person.person } });
  await dir.users.add(root.who, "bo", { name: "Bo B" });
  expect((await run(root, "people")).users.find((u: { login?: string }) => u.login == "bo")).toMatchObject({
    name: "Bo B",
    role: "write",
    roleLabel: "Can create and edit content",
  });
  expect((await run(root, "set_user", { action: "role", login: "bo", role: "admin" })).role).toBe("admin");
  // Bo, an admin now, has the tools.
  expect((await toolsFor({ dir, who: { login: "bo", admin: true } })).some((t) => t.name == "people")).toBe(true);
  // Without admin power (a token without the admin scope), an admin has none of them, and each is refused, saying so.
  expect((await toolsFor({ dir, who: { login: "bo" } })).some((t) => t.name == "people")).toBe(false);
  expect((await failure(run({ dir, who: { login: "bo" } }, "people"))).message).toMatch(/no admin power/);
  expect(
    (await run({ dir, who: { login: "bo", admin: true } }, "people")).users.map(
      (u: { login: string; bootstrap: boolean }) => `${u.login}${u.bootstrap ? "*" : ""}`
    )
  ).toEqual(["bo", "root*"]);
  let e = await failure(run(root, "set_user", { action: "role", login: "root", role: "write" }));
  expect([e.status, /DEV_LOGIN/.test(e.message)]).toEqual([403, true]);
  // Yourself, as on the Users page: the directory decides (a bootstrap admin stays).
  e = await failure(run(root, "set_user", { action: "remove", login: "root" }));
  expect([e.status, /DEV_LOGIN/.test(e.message)]).toEqual([403, true]);
  e = await failure(run({ dir, who: { login: "bo", admin: true } }, "set_user", { action: "remove", login: "root" }));
  expect([e.status, /DEV_LOGIN/.test(e.message)]).toEqual([403, true]);
  e = await failure(run(root, "set_user", { action: "remove", login: "nobody" }));
  expect(e.status).toBe(404);
  e = await failure(run(root, "set_user", { action: "add", provider: "github", handle: "not a login", role: "read" }));
  expect(e.status).toBe(403);
  expect(await run(root, "set_user", { action: "remove", login: "bo" })).toEqual({ removed: "bo" });
  expect(await dir.users.allowed("bo")).toBe(false);
});

test("access: a group rule added, changed and removed, public sharing switched, in one tool; people reads them", async () => {
  const dir = fresh({ admins: ["root"] });
  const root = { dir, who: { login: "root", admin: true } };
  const rule = await run(root, "set_access", { action: "add", kind: "github_org", value: "acme", access: "read" });
  expect([rule.who, rule.accessLabel]).toEqual(["GitHub organization: acme", "Can authenticate"]);
  expect((await run(root, "set_access", { action: "change", id: rule.id, access: "write" })).from).toBe("read (Can authenticate)");
  expect((await run(root, "set_access", { action: "public", on: false })).publicSharing).toBe(false);
  const people = await run(root, "people");
  expect([people.publicSharing, people.rules.find((r: { id: number }) => r.id == rule.id).access]).toEqual([false, "write"]);
  expect((await run(root, "set_access", { action: "remove", id: rule.id })).removed.id).toBe(rule.id);
  // An action without what it needs says which argument.
  expect((await failure(run(root, "set_access", { action: "change", id: 1 }))).message).toBe("change needs access.");
  expect((await failure(run(root, "set_user", { action: "deploy", login: "root" }))).status).toBe(400);
});

test("sharing: the owner sees and changes who has access; editors change the readers' options; the document agent defaults to its document", async () => {
  // Users can share content publicly here (anyone with the link): the Access page's switch.
  const dir = fresh({ defaults: { public_sharing: true }, admins: ["root"] });
  // Bo and Cy may sign in here (a share goes only to someone who may).
  for (const l of ["bo", "cy"]) await dir.users.add({ login: "root", admin: true }, l);
  await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1 });
  const ada = { dir, who: { login: "ada" } };
  let r = await run(ada, "share_document", { document: "/ada/plan", login: "Bo", role: "editor" });
  expect(r.permissions.map((p: { login: string; role: string }) => `${p.login}:${p.role}`)).toEqual(["ada:owner", "bo:editor"]);
  r = await run({ ...ada, here: "aaaaaaaa" }, "share_document", { login: "*", role: "viewer" });
  expect(r.document.address).toBe("/ada/plan");
  // The readers' options, set alone: the answer says who has access too.
  r = await run(ada, "share_document", { document: "plan", reader_bars: false });
  expect([r.permissions.length, r.readerBars]).toEqual([3, false]);
  expect((await failure(run(ada, "share_document", { document: "plan", reader_agent: true }))).status).toBe(409);
  const e = await failure(run({ dir, who: { login: "bo" } }, "share_document", { document: "aaaaaaaa", login: "cy", role: "editor" }));
  expect([e.status, /owner/.test(e.message)]).toEqual([403, true]);
  // Bo, an editor, changes the readers' options, and doesn't see who has access; Cy, not shared with, may not.
  r = await run({ dir, who: { login: "bo" } }, "share_document", { document: "aaaaaaaa", reader_bars: true });
  expect([r.readerBars, r.anyoneWithLink, r.permissions]).toEqual([true, true, undefined]);
  expect((await failure(run({ dir, who: { login: "cy" } }, "share_document", { document: "aaaaaaaa", reader_bars: true }))).status).toBe(
    403
  );
  expect((await failure(run(ada, "share_document", { login: "cy", role: "editor" }))).status).toBe(400);
  expect((await failure(run(ada, "share_document", { document: "/ada/none", login: "cy", role: "editor" }))).status).toBe(404);
  expect((await failure(run(ada, "share_document", { document: "plan", login: "cy" }))).status).toBe(400);
  r = await run(ada, "share_document", { document: "aaaaaaaa", login: "bo", role: "none" });
  expect(r.permissions.map((p: { login: string }) => p.login)).toEqual(["ada", "*"]);
});

test("the Project template makes a project from the start, with its two pages that link to each other: from /new's menu and from create_document", async () => {
  const dir = fresh();
  const { platform } = platformOf(dir);
  const read = (f: string) => readFileSync(new URL(`../assets/templates/project/${f}`, import.meta.url), "utf8");
  (platform as { templates: Platform["templates"] }).templates.project = {
    "index.html": read("index.html"),
    "about.html": read("about.html"),
  };
  const created: { kind?: string; files: string[] }[] = [];
  platform.docs.create = async (_doc, files, _index, opts) => {
    created.push({ kind: opts.kind, files: Object.keys(files).sort() });
    return true;
  };
  const t = templateById("project")!;
  expect([t.name, t.kind]).toEqual(["Project", "project"]);
  expect(newDocMenu((p) => p)).toContain('data-template="project"');
  expect(read("index.html")).toContain('href="about.html"');
  expect(read("about.html")).toContain('href="index.html"');
  const ada: Caller = { dir, who: { login: "ada" }, platform, origin: "https://erga.test" };
  const r = await run(ada, "create_document", { template: "project" });
  expect(created).toEqual([{ kind: "project", files: ["about.html", "index.html"] }]);
  expect((await dir.get(r.id))?.kind).toBe("project");
});

/** The platform the documents list's tools need, on the in-memory directory: templates, and documents that are only rows. */
function platformOf(dir: Directory) {
  const made: string[] = [];
  const platform = {
    directory: dir,
    templates: { doc: { "index.html": "<h1>Blank</h1>" }, slides: { "index.html": "<h1>Slides</h1>" } },
    docs: {
      create: async (doc: { id: string }) => { made.push(doc.id); return true; },
      delete: async () => false,
      snapshot: async () => ({ files: { "index.html": "<h1>Copied</h1>" }, index: "index.html" }),
      list: async (owner: string) => (await dir.lists.list(owner)).map((d) => ({ ...d, modified: d.modified ?? d.created })),
    },
  } as unknown as Platform;
  return { platform, made };
}

test("the documents list: the document agent lists, makes (blank, a template, a copy) and deletes the person's documents, as /docs does", async () => {
  const dir = fresh();
  const { platform, made } = platformOf(dir);
  await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1 });
  await dir.add({ id: "bbbbbbbb", owner: "cy", title: "Secret", created: 1 });
  const ada: Caller = { dir, who: { login: "ada" }, here: "aaaaaaaa", platform, origin: "https://erga.test" };
  let r = await run(ada, "list_documents");
  expect(r.documents.map((d: { address: string; here?: boolean }) => [d.address, !!d.here])).toEqual([["/ada/plan", true]]);
  r = await run(ada, "create_document", { title: "Notes" });
  expect([r.address, made.length]).toEqual(["/ada/notes", 1]);
  r = await run(ada, "create_document", { template: "slides", slug: "deck" });
  expect(r.address).toBe("/ada/deck");
  r = await run(ada, "create_document", { from: "/ada/plan", title: "Plan copy" });
  expect([r.url, r.from]).toEqual(["https://erga.test/ada/plan-copy", "aaaaaaaa"]);
  expect((await failure(run(ada, "create_document", { template: "nope" }))).message).toMatch(/slides/);
  expect((await failure(run(ada, "create_document", { from: "bbbbbbbb" }))).status).toBe(403);
  // limit: that many from the top of the list, 20 when left out; moreDocuments: how many it left out.
  const listed = async (args = {}) => {
    const l = await run(ada, "list_documents", args);
    return [l.documents.map((d: { address: string }) => d.address), l.moreDocuments] as [string[], number];
  };
  const [four, none] = await listed();
  expect([four.length, none]).toEqual([4, 0]);
  expect(await listed({ limit: 3 })).toEqual([four.slice(0, 3), 1]);
  expect((await listed({ limit: 1, query: "plan" }))[1]).toBe(1);
  for (let i = 0; i < 20; i++) await dir.add({ id: `cccccc${String(i).padStart(2, "0")}`, owner: "ada", title: `Old ${i}`, created: 1 });
  expect([(await listed())[0].length, (await listed())[1], (await listed({ limit: 100 }))[1]]).toEqual([20, 4, 0]);
  // Deleting: one of theirs, never the one the agent is in, never someone else's.
  r = await run(ada, "delete_document", { document: "/ada/deck" });
  expect(r.deleted.address).toBe("/ada/deck");
  expect((await listed({ limit: 100 }))[0]).not.toContain("/ada/deck");
  expect((await failure(run(ada, "delete_document", { document: "/ada/plan" }))).status).toBe(409);
  expect((await failure(run(ada, "delete_document", { document: "bbbbbbbb" }))).status).toBe(403);
  expect((await failure(run(ada, "delete_document", {}))).status).toBe(400);
  expect((await toolsFor(ada, true)).flatMap(opsOf)).toContain("delete_document");
});

test("API keys: an admin clears one (the change log says who), and is never offered a tool to set one", async () => {
  const dir = fresh({ admins: ["root"], credentialSecret: "a-secret-for-the-tests-0123456789" });
  const root = { dir, who: { login: "root", admin: true } };
  await dir.credentials.set(root.who, "anthropic", "sk-ant-api03-test-1234567890abcd");
  expect((await run(root, "settings")).apiKeys.find((k: { name: string }) => k.name == "anthropic").stored).toBe(true);
  const r = await run(root, "clear_api_key", { name: "anthropic" });
  expect([r.cleared, r.stored]).toEqual(["anthropic", false]);
  const log = await run(root, "settings", { changes: true });
  expect([log.changes[0].by, log.changes[0].changes[0].key, log.changes[0].changes[0].credential]).toEqual([
    "root",
    "ANTHROPIC_API_KEY",
    "cleared",
  ]);
  expect((await failure(run(root, "clear_api_key", { name: "nope" }))).status).toBe(400);
  expect((await failure(run({ dir, who: { login: "bo" } }, "clear_api_key", { name: "anthropic" }))).status).toBe(403);
  expect(
    allTools()
      .map((t) => t.name)
      .filter((n) => /^set_.*key|(make|mint|create|new)_token/.test(n))
  ).toEqual([]);
});

test("one set of tools for every agent: a person's own agent has what they may (an admin's, every operation); an admin token all; a document token none that reach beyond it", async () => {
  const dir = fresh({ admins: ["root"] });
  await dir.users.add({ login: "root", admin: true }, "bo");
  const names = async (c: Caller) => (await toolsFor(c)).flatMap(opsOf);
  const all = OPERATIONS.map((o) => o.name);
  // A person's own agent: an admin's has admin power (agents/person/sessions.ts), and every operation; the document tools for any document.
  for (const via of [VIA.agent, VIA.token("CI")]) {
    const tools = await names({ dir, who: { login: "root", admin: true, via } });
    for (const op of all) expect(tools).toContain(op);
    expect(tools).toContain("edit");
  }
  // Someone who isn't an admin: their agent has no admin operation, and one asked of it is refused.
  expect(await names({ dir, who: { login: "bo", via: VIA.agent } })).not.toContain("people");
  expect((await failure(run({ dir, who: { login: "bo", via: VIA.agent } }, "people"))).status).toBe(403);
  // A document token: nothing that reaches beyond its document.
  const one = await names({ dir, who: { login: "root", onlyDoc: "aaaaaaaa", via: VIA.token("one") } });
  for (const op of OPERATIONS.filter((o) => o.wide)) expect(one).not.toContain(op.name);
  expect(one).toContain("share_document");
});

test("a person's agent's document tools: the document open on their page, or another named, in its host as their agent, never with admin power", async () => {
  const dir = fresh({ admins: ["root"] });
  await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1 });
  await dir.add({ id: "bbbbbbbb", owner: "ada", title: "Notes", created: 1 });
  await dir.add({ id: "cccccccc", owner: "cy", title: "Secret", created: 1 });
  const sent: Request[] = [];
  const platform = {
    directory: dir,
    docs: {
      fetch: async (_doc: unknown, r: Request) => {
        sent.push(r);
        return Response.json({ ok: true, content: [{ type: "text", text: "Edited notes.html" }] });
      },
    },
  } as unknown as Platform;
  const agent: Caller = { dir, who: { login: "ada", via: VIA.agent }, name: "Ada", here: "aaaaaaaa", platform };
  const edit = documentToolsHere().find((t) => t.name == "edit")!,
    read = documentToolsHere().find((t) => t.name == "read")!;
  // No document named: the one open on her page (Caller.here), in its host, as her agent.
  await runTool(edit, { path: "index.html", edits: [] }, agent);
  expect(new URL(sent[0].url).pathname).toBe("/api/tools/edit");
  // Another of Ada's, named: there, as her agent.
  const out = await runTool(edit, { document: "/ada/notes", path: "index.html", edits: [] }, agent);
  expect(out).toEqual([{ type: "text", text: "Edited notes.html" }]);
  const r = sent[1];
  expect(new URL(r.url).pathname).toBe("/api/tools/edit");
  expect(JSON.parse(await r.text())).toEqual({ path: "index.html", edits: [] });
  expect(r.headers.get("x-erga-agent")).toBeTruthy();
  // Its edits are Ada's, via her agent ("ada, via their agent"), and it has no admin power there.
  expect(JSON.parse(r.headers.get("x-erga-via")!)).toBe(VIA.agent);
  expect(JSON.parse(r.headers.get("x-erga-who")!)).toEqual({ login: "ada", via: VIA.agent });
  expect(JSON.parse(r.headers.get("x-erga-person")!)).toMatchObject({ id: "ada", name: "Ada" });
  // Someone else's, not shared with her: refused, as it would be to her.
  expect((await failure(runTool(read, { document: "cccccccc", path: "index.html" }, agent))).status).toBe(403);
  expect(sent.length).toBe(2);
});

test("list_documents' all is an admin's: someone else is refused", async () => {
  const dir = fresh({ admins: ["root"] });
  await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Plan", created: 1 });
  // (A signed-in session comes with admin power; the directory says whether its person is an admin.)
  expect((await failure(run({ dir, who: { login: "someone-else", admin: true } }, "list_documents", { all: true }))).status).toBe(403);
  await dir.add({ id: "bbbbbbbb", owner: "ada", title: "Notes", created: 1 });
  const root: Caller = { dir, who: { login: "root", admin: true } };
  const { documents: found, moreDocuments } = await run(root, "list_documents", { all: true });
  expect([found.length, moreDocuments]).toEqual([2, 0]);
  expect((await run(root, "list_documents", { all: true, limit: 1 })).moreDocuments).toBe(1);
  expect(found[0]).toMatchObject({
    address: expect.stringMatching(/^\/[^/]+\/[^/]+$/),
    kind: expect.stringMatching(/^(document|project)$/),
  });
});

// The cases below run on the whole app in memory (tests/helpers/app.ts): real documents, the tools over HTTP.

test("an admin changes the readers' options on the homepage project (/_home), which has no owner", async () => {
  const s = server();
  // (The deploy makes the homepage project.)
  await s.fetch("/api/deploys/home", { method: "POST" });
  const on = async () => ((await overHttp(s, "ls", { document: "/_home" })).result?.access as { pageLlm?: { on: boolean } })?.pageLlm?.on;
  const was = await on();
  expect(was).toBe(false);
  expect((await overHttp(s, "share_document", { document: "/_home", page_llm: !was })).status).toBe(200);
  expect(await on()).toBe(!was);
  // Someone who isn't an admin can't.
  expect((await overHttp(s, "share_document", { document: "/_home", page_llm: was }, { user: "Bo" })).status).toBe(403);
  expect(await on()).toBe(!was);
});

test("an agent makes a scratch document (create_document, scratch) and saves it (save_document), as its person can", async () => {
  const p = await person(server());
  const made = await p.tool<{ id: string; address: string; expires: string }>("create_document", { scratch: true, title: "Notes" });
  expect(made.status).toBe(200);
  const { id, address, expires } = made.result!;
  expect(address).toBe(`/${p.login}/${id}`);
  expect(expires).toContain("unless someone saves it");
  expect(p.row(id, await p.docs())).toBe("(not listed)");
  const saved = await p.tool("save_document", { document: id });
  expect(saved.status).toBe(200);
  expect(saved.result.saved.address).toBe(`/${p.login}/notes`);
  expect(p.row(id, await p.docs())).not.toBe("(not listed)");
  expect((await p.tool("save_document", { document: id })).status).toBe(409);
});

test("ls says who a document is shared with, to its owner only; the list marks it shared, with a share button", async () => {
  const p = await person(server());
  const id = await p.make();
  await p.share(id, "Ada", "viewer");
  type Access = { permissions: { login: string; role: string }[]; notUsers: string[] };
  const sharedWith = (await p.tool<{ access: Access }>("ls", { document: id })).result!.access;
  expect(sharedWith.permissions.map((x) => `${x.login}:${x.role}`)).toEqual([`${p.login}:owner`, "ada:viewer"]);
  expect(Array.isArray(sharedWith.notUsers)).toBe(true);
  const asAda = await p.tool<{ access?: Access }>("ls", { document: id }, "Ada");
  expect([asAda.status, asAda.result?.access]).toEqual([200, undefined]);
  const row = (await p.docs()).split(/<li[ >]/).find((li) => li.includes(`/${p.login}/untitled"`)) ?? "";
  expect(row).toContain(">Shared<");
  expect(row).toContain(`class="act share"`);
});

test("scratch documents follow delete_docs_after_hours: one made while it is 7 goes after 7 hours; while it is never, one is never deleted, and the pages say so", async () => {
  const s = server();
  const p = await person(s);
  /** The setting, set as the admin (the dev login) sets it. */
  const set = async (value: number | null) => (await overHttp(s, "set_setting", { key: "delete_docs_after_hours", value })).status;
  /** A scratch document's id, and its page as its maker gets it. */
  const scratch = async () => {
    const at = (await p.get("/scratch")).headers.get("location") ?? "";
    const id = at.split("/")[2].replace(/\?edit$/, "");
    return { id, page: await (await p.get(at.replace(/\?edit$/, ""))).text() };
  };
  /** When the agent's answer says it goes (create_document's expires), in hours from now; null if it never goes. */
  const madeFor = async () => {
    const made = await p.tool("create_document", { scratch: true });
    const expires = made.result.expires as string | undefined;
    return expires ? Math.round((Date.parse(expires.split(",")[0]) - Date.now()) / 3_600_000) : null;
  };
  expect(await set(7)).toBe(200);
  expect(await p.docs()).toContain(`data-tip="Unsaved scratch docs are deleted in 7h"`);
  expect(await madeFor()).toBe(7);
  expect((await scratch()).page).toContain("Unsaved scratch docs are deleted in 7h");

  expect(await set(null)).toBe(200);
  const docs = await p.docs();
  expect(docs).toContain(`data-tip="Not on your documents list until you save it"`);
  expect(docs).not.toContain("Unsaved scratch docs are deleted");
  expect(await madeFor()).toBe(null);
  const never = await scratch();
  expect(never.page).toContain("Save to your documents list.");
  expect(never.page).not.toContain("Unsaved scratch docs are deleted");
  expect(p.row(never.id, await p.docs())).toBe("(not listed)");
});
