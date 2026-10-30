// The operations inside a document (server/operations/editor.ts), on a real document and directory: the editor's
// agent calls them from its tool list, defaulting to its own document, as its person may; someone who may only view
// reads, and is refused a change.

import * as Effect from "effect/Effect";
import { expect, test } from "bun:test";
import { agentToolsFor, allTools, runTool } from "../agents/tools";
import type { Caller } from "../server/operations/index.ts";
import type { Platform } from "../server/platform";
import { VIA } from "../shared/attribution";
import { setup } from "./helpers/files-fixture";

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
    directory: s.dir,
    docs: {
      tree: () => call((c) => c.tree()),
      treeOp: async (_d: unknown, op: never) => (await call((c) => c.treeOp(op)))!,
      files: () => call((c) => c.files()),
      rename: async (_d: unknown, person: never, patch: never) => (await call((c) => c.rename(person, patch)))!,
      versions: (_d: unknown, o: never) => s.doc.versionsState(o),
      version: (_d: unknown, ref: string) => s.doc.version(ref),
      versionFile: (_d: unknown, ref: string, path: string) => s.doc.versionFile(ref, path),
      restore: (_d: unknown, ref: string, by: string, path: string | null) => s.doc.restore(ref, by, path),
    },
  } as unknown as Platform;
  return { ...s, platform };
}

/** An agent's tool call, as its loop makes it: the text it reads back. */
const ask = async (tools: Awaited<ReturnType<typeof agentToolsFor>>, name: string, args: Record<string, unknown> = {}) => {
  const tool = tools.find((t) => t.name == name);
  if (!tool) throw new Error(`no tool ${name}`);
  const out = await tool.execute("call", args);
  return (out.content[0] as { text: string }).text;
};

test("the editor's agent renames its document, lists, makes, moves and deletes pages, and restores a version, from its tool list", async () => {
  const { platform, dir, doc } = await world();
  const agent: Caller = {
    dir,
    who: { login: "ada", via: VIA.agent },
    name: "Ada",
    here: "doc12345",
    platform,
    origin: "https://erga.test",
  };
  const tools = await agentToolsFor(agent);
  for (const t of [
    "get_title",
    "rename_document",
    "list_pages",
    "ls",
    "new_page",
    "mkdir",
    "mv",
    "rm",
    "make_project",
    "make_document",
    "list_versions",
    "read_version",
    "restore_version",
  ])
    expect(tools.map((x) => x.name)).toContain(t);
  // Its name, from the directory; a rename moves the address.
  expect(JSON.parse(await ask(tools, "get_title")).address).toBe("/ada/files");
  const named = JSON.parse(await ask(tools, "rename_document", { title: "Field notes" }));
  expect([named.title, named.address, named.url]).toEqual(["Field notes", "/ada/field-notes", "https://erga.test/ada/field-notes"]);
  expect((await dir.get("doc12345"))!.title).toBe("Field notes");
  // A document has one page: a second is refused, saying how; as a project it takes more.
  await expect(ask(tools, "new_page", { path: "about" })).rejects.toThrow(/make it a project first/);
  expect(JSON.parse(await ask(tools, "make_project")).kind).toBe("project");
  await ask(tools, "new_page", { path: "about" });
  await ask(tools, "mkdir", { path: "blog" });
  await ask(tools, "mv", { from: "about.html", to: "blog/about.html" });
  const pages = JSON.parse(await ask(tools, "list_pages"));
  expect(pages.canEdit).toBe(true);
  expect(pages.entries.find((e: { path: string }) => e.path == "blog/about.html").address).toBe("/ada/field-notes/blog/about");
  const files = JSON.parse(await ask(tools, "ls", { path: "blog" }));
  expect(files.files.map((f: { path: string }) => f.path)).toEqual(["blog/about.html"]);
  await ask(tools, "rm", { path: "blog" });
  expect(await doc.paths()).toEqual(["index.html"]);
  // Versions: listed, read, and one brought back as the agent's person's.
  await doc.publish({ "index.html": "<h1>Changed</h1>" }, []);
  await new Promise((r) => setTimeout(r, 120));
  const v = JSON.parse(await ask(tools, "list_versions"));
  expect(v.total).toBeGreaterThan(1);
  expect(await ask(tools, "read_version", { version: "v1", path: "index.html" })).toBe("<h1>Files</h1>");
  const r = JSON.parse(await ask(tools, "restore_version", { version: "v1", path: "index.html" }));
  expect(r.files).toEqual(["index.html"]);
  expect(r.current.authors).toEqual(["ada, via their agent"]);
});

test("someone who may only view lists the pages and versions, and is refused a change, in the operation's words", async () => {
  const { platform, dir } = await world();
  const bo: Caller = { dir, who: { login: "bo" }, name: "Bo", platform };
  const tool = (name: string) => allTools().find((t) => t.name == name)!;
  const pages = (await runTool(tool("list_pages"), { document: "doc12345" }, bo)) as { canEdit: boolean };
  expect(pages.canEdit).toBe(false);
  expect(((await runTool(tool("list_versions"), { document: "/ada/files" }, bo)) as { canEdit: boolean }).canEdit).toBe(false);
  for (const [name, args] of [
    ["new_page", { path: "x" }],
    ["rename_document", { title: "Mine" }],
    ["restore_version", { version: "v1" }],
  ] as const)
    await expect(runTool(tool(name), { document: "doc12345", ...args }, bo)).rejects.toMatchObject({ status: 403 });
});
