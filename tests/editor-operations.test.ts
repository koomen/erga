// The operations inside a document (server/operations/editor.ts), on a real document and directory: the editor's
// agent calls them from its tool list, defaulting to its own document, as its person may; someone who may only view
// reads, and is refused a change. (read with version runs in the document's host: e2e/agent/tools.e2e.ts.)

import * as Effect from "effect/Effect";
import { expect, test } from "bun:test";
import { agentTools, allTools, runTool, toolsFor, toolOf } from "../agents/tools";
import { roomInfo } from "../document/model/content";
import type { Room } from "../document/room/room";
import type { Caller } from "../server/operations/index.ts";
import type { Platform } from "../server/platform";
import { VIA, type Act } from "../shared/attribution";
import { setup } from "./helpers/files-fixture";
import { until } from "./helpers/until";

/** The files fixture's document, as the platform reaches it (the Durable Object's calls). */
async function world() {
  const s = await setup();
  await s.doc.setPermissions([
    { login: "ada", role: "owner" },
    { login: "bo", role: "viewer" },
  ]);
  await s.dir.users.add({ login: "ada", admin: true }, "bo");
  await s.dir.share({ login: "ada" }, "doc12345", "bo", "viewer");
  const call = <A>(f: Parameters<typeof s.doc.self.call<A>>[0]) => Effect.runPromise(s.doc.self.call(f));
  const platform = {
    agentSettings: async () => ({ missing: "no API key" }),
    directory: s.dir,
    // No custom domain, and nothing linked to the Erga domain.
    deploy: { domains: [], app: null },
    site: () => ({ status: async () => ({ state: "free", doc: null, bars: false, live: null, error: null, by: null, linked: null }) }),
    docs: {
      tree: () => call((c) => c.tree()),
      treeOp: async (_d: unknown, op: never, by: Act) => (await call((c) => c.treeOp(op, by)))!,
      files: () => call((c) => c.files()),
      rename: async (_d: unknown, person: never, patch: never) => (await call((c) => c.rename(person, patch)))!,
      versions: (_d: unknown, o: never) => s.doc.versionsState(o),
      version: (_d: unknown, ref: string) => s.doc.version(ref),
      versionFile: (_d: unknown, ref: string, path: string) => s.doc.versionFile(ref, path),
      restore: (_d: unknown, ref: string, by: Act, path: string | null) => s.doc.restore(ref, by, path),
    },
  } as unknown as Platform;
  return { ...s, platform };
}

/** An agent's tool call, as its loop makes it: the text it reads back. */
/** Runs the op `name` as the agent calls it: the tool that has it, with op. */
const ask = async (tools: ReturnType<typeof agentTools>, name: string, args: Record<string, unknown> = {}) => {
  const tool = tools.find((t) => t.name == toolOf(name));
  if (!tool) throw new Error(`no tool has ${name}`);
  const out = await tool.execute("call", { op: name, ...args });
  return (out.content[0] as { text: string }).text;
};

test("a person's agent renames the document open on their page, lists, makes, moves and deletes pages, and restores a version, from its tool list", async () => {
  const { platform, dir, doc } = await world();
  const agent: Caller = {
    dir,
    who: { login: "ada", via: VIA.agent },
    name: "Ada",
    here: "doc12345",
    platform,
    origin: "https://erga.test",
  };
  const tools = agentTools(await toolsFor(agent, true), agent);
  for (const t of ["rename_document", "ls", "new", "mv", "rm", "versions", "restore_version"])
    expect(tools.map((x) => x.name)).toContain(toolOf(t)!);
  // Its name, from the directory; a rename moves the address.
  expect(JSON.parse(await ask(tools, "ls")).address).toBe("/ada/files");
  const named = JSON.parse(await ask(tools, "rename_document", { title: "Field notes" }));
  expect([named.title, named.address, named.url]).toEqual(["Field notes", "/ada/field-notes", "https://erga.test/ada/field-notes"]);
  expect((await dir.get("doc12345"))!.title).toBe("Field notes");
  // Any document takes more pages.
  await ask(tools, "new", { path: "about" });
  await ask(tools, "new", { path: "blog/" });
  await ask(tools, "mv", { from: "about.html", to: "blog/about.html" });
  const pages = JSON.parse(await ask(tools, "ls"));
  expect(pages.canEdit).toBe(true);
  expect(pages.access.permissions.map((p: { login: string }) => p.login)).toContain("bo");
  expect(pages.entries.find((e: { path: string }) => e.path == "blog/about.html")).toMatchObject({
    type: "page",
    address: "/ada/field-notes/blog/about",
    kind: "text",
  });
  const files = JSON.parse(await ask(tools, "ls", { path: "blog" }));
  expect(files.entries.map((f: { path: string }) => f.path)).toEqual(["blog/about.html"]);
  const html = JSON.parse(await ask(tools, "ls", { glob: "*.html" }));
  expect(html.entries.map((f: { path: string }) => f.path).sort()).toEqual(["blog/about.html", "index.html"]);
  await ask(tools, "rm", { path: "blog" });
  expect(await doc.paths()).toEqual(["index.html"]);
  // Versions: listed, read, and one brought back as the agent's person's.
  await doc.write({ "index.html": "<h1>Changed</h1>" }, []);
  await until(async () => (await doc.versionsState())!.total > 1);
  const v = JSON.parse(await ask(tools, "versions"));
  expect(v.total).toBeGreaterThan(1);
  const r = JSON.parse(await ask(tools, "restore_version", { version: "v1", path: "index.html" }));
  expect(r.files).toEqual(["index.html"]);
  expect(r.current.authors).toEqual(["ada, via their agent"]);
});

test("a title that a tab sets in the room names the document; rename_document writes its title in the room; an empty one follows the heading", async () => {
  const { platform, dir, doc } = await world();
  const { room } = await (doc as unknown as { room(): Promise<{ room: Room }> }).room();
  const row = async () => {
    const d = (await dir.get("doc12345"))!;
    return [d.title, d.titleSet, d.slug];
  };
  /** As a tab's replica writes it: any origin but the room's own. */
  const tabSets = (title: string) => room.doc.transact(() => roomInfo(room.doc).set("title", title), "a tab");
  tabSets("Field   notes ");
  await until(async () => (await row())[0] == "Field notes");
  expect(await row()).toEqual(["Field notes", true, "field-notes"]);
  // (The room has it as the directory took it.)
  expect(room.title).toBe("Field notes");
  // An operation's rename: the tabs' replicas have its title.
  const agent: Caller = {
    dir,
    who: { login: "ada", via: VIA.agent },
    name: "Ada",
    here: "doc12345",
    platform,
    origin: "https://erga.test",
  };
  const tools = agentTools(await toolsFor(agent, true), agent);
  await ask(tools, "rename_document", { title: "Minutes" });
  expect(room.title).toBe("Minutes");
  expect(await row()).toEqual(["Minutes", true, "minutes"]);
  // Empty: the title follows the page's first heading again.
  tabSets("");
  await until(async () => (await row())[0] == "Files");
  expect(await row()).toEqual(["Files", false, "files"]);
});

test("someone who may only view lists the pages, and is refused the versions and a change, in the operation's words", async () => {
  const { platform, dir } = await world();
  const bo: Caller = { dir, who: { login: "bo" }, name: "Bo", platform };
  const tool = (name: string) => allTools().find((t) => t.name == name)!;
  const pages = (await runTool(tool("ls"), { document: "doc12345" }, bo)) as { canEdit: boolean; access?: unknown };
  expect(pages.canEdit).toBe(false);
  // Who it's shared with is its owner's to see.
  expect(pages.access).toBeUndefined();
  for (const [name, args] of [
    // Its versions are for those who may edit it: they may hold text removed before it was shared.
    ["versions", {}],
    ["versions", { from: "v1" }],
    ["new", { path: "x" }],
    ["rename_document", { title: "Mine" }],
    ["restore_version", { version: "v1" }],
  ] as const)
    await expect(runTool(tool(name), { document: "doc12345", ...args }, bo)).rejects.toMatchObject({ status: 403 });
});
