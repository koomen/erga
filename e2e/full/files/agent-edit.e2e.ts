// edit as an outside agent calls it (MCP's edit tool, op edit): replaceAll changes each match in a file, and a glob path
// changes each file it matches in one call (as sed would), leaving the rest alone; a glob that changes nothing says so.
import { expect, servers, test } from "../../helpers/fixtures";
import { person } from "../versions/versions";

await servers.main();

test("edit: replaceAll changes every match; a glob path edits each file it matches, in one call", async () => {
  const server = await servers.main();
  const ada = await person(server, `ada${crypto.randomUUID().slice(0, 6)}`);
  const token = await ada.token("Edit test");
  const mcp = async (name: string, args: object) => {
    const r = await fetch(`${server.root}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const { result } = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: result.content.map((c) => c.text).join(""), error: !!result.isError };
  };
  const nav = (here: string) => `<nav><a href="${here}old.html">Old</a> <a href="${here}index.html">Home</a></nav>`;
  const made = await mcp("documents", {
    op: "create_document",
    kind: "project",
    files: {
      "index.html": `<!doctype html><html><body>${nav("")}<p>See old.html, then old.html again.</p></body></html>`,
      "old.html": `<!doctype html><html><body>${nav("")}<p>Old page.</p></body></html>`,
      "docs/a.html": `<!doctype html><html><body>${nav("../")}</body></html>`,
      "notes.txt": "old.html is kept here.",
    },
  });
  expect(made.error).toBe(false);
  const document = JSON.parse(made.text).id as string;
  const read = async (path: string) => (await mcp("read", { document, path })).text;

  // One file, every match.
  const all = await mcp("edit", {
    document,
    path: "index.html",
    edits: [{ oldText: "old.html again", newText: "new.html again", replaceAll: true }],
  });
  expect(all).toEqual({ text: "Edited index.html (1 change).", error: false });
  const twice = await mcp("edit", { document, path: "index.html", edits: [{ oldText: 'href="', newText: 'href="./' }] });
  expect(twice.error).toBe(true);
  expect(twice.text).toContain("replaceAll");

  // Every page, in one call; the text file the glob doesn't match keeps its text.
  const many = await mcp("edit", { document, path: "**/*.html", edits: [{ oldText: 'old.html">Old', newText: 'new.html">New' }] });
  expect(many.error).toBe(false);
  expect(many.text.split("\n").sort()).toEqual([
    "Edited docs/a.html (1 change).",
    "Edited index.html (1 change).",
    "Edited old.html (1 change).",
  ]);
  expect(await read("docs/a.html")).toContain('<a href="../new.html">New</a>');
  expect(await read("index.html")).toBe(
    `<!doctype html><html><body><nav><a href="new.html">New</a> <a href="index.html">Home</a></nav><p>See old.html, then new.html again.</p></body></html>`
  );
  expect(await read("notes.txt")).toBe("old.html is kept here.");

  // grep's line is the file's own, after "path:line:"; an oldText copied with one space too many still finds it.
  const grep = await mcp("read", { document, op: "grep", pattern: "Old page" });
  expect(grep.text).toBe(
    'old.html:1:<!doctype html><html><body><nav><a href="new.html">New</a> <a href="index.html">Home</a></nav><p>Old page.</p></body></html>'
  );
  const spaced = await mcp("edit", { document, path: "old.html", edits: [{ oldText: "<p>Old  page.</p>", newText: "<p>Gone.</p>" }] });
  expect(spaced).toEqual({ text: "Edited old.html (1 change). (oldText: found with other white space than given.)", error: false });
  expect(await read("old.html")).toContain("<p>Gone.</p>");

  // read with a glob: each file it matches, after its path.
  expect((await mcp("read", { document, path: "docs/*.html" })).text).toBe(
    `==> docs/a.html <==\n<!doctype html><html><body><nav><a href="../new.html">New</a> <a href="../index.html">Home</a></nav></body></html>\n`
  );

  const none = await mcp("edit", { document, path: "docs/*.html", edits: [{ oldText: "not there", newText: "x" }] });
  expect(none).toEqual({ text: "No file that docs/*.html matches has any of the oldTexts: nothing was changed.", error: true });
});
