// view_page and eval_in_page on a document whose owner isn't the caller: the render's token and pages origin name
// the document's real owner (its permissions'), so the page's own files load. The bug (production): the homepage
// project adopted from an admin's /<admin>/landing (server/documents/landing.ts adoptLanding) is owned by "-home", but
// its host still keeps the admin it was made with, and the render's token named that admin: its files gave 404.
import { expect, servers, test } from "../../helpers/fixtures";
import type { Server } from "../../helpers/server";
import { runTool, textOf } from "../../helpers/tools";
import { docOf, front, setLanding } from "../home/home";
import { person } from "../versions/versions";

// Its own server: the adoption happens only where there's no homepage project yet.
const own = () => servers.of("view-owner");
await own();

const SCRIPT = "function probeFn() { return 42; }\n";
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#c00"/></svg>\n`;
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Probe</title><script src="probe.js"></script></head>
<body><h1>Probe</h1><img id="logo" src="probe-logo.svg" alt="logo"></body></html>
`;

/**
 * Writes a page with a script file and an image into the document, as DEV_LOGIN's (tester's) agent with an admin token
 * (the homepage project is the admins'), and asks the render whether both loaded.
 */
async function probe(server: Server, document: string) {
  const token = await (await person(server, "tester")).token("view owner tests", "admin");
  const tool = async (name: string, args: object) => {
    const r = await runTool(server.root, name, { document, ...args }, { token });
    return { ok: r.ok, text: r.ok ? textOf(r.result) : (r.error ?? "") };
  };
  for (const [path, content] of [
    ["probe.js", SCRIPT],
    ["probe-logo.svg", LOGO],
    ["index.html", PAGE],
  ]) {
    const w = await tool("write", { path, content });
    expect(w.ok, `write ${path}: ${w.text}`).toBe(true);
  }
  const ev = (expression: string) => tool("eval_in_page", { expression });
  const fn = await ev("typeof probeFn");
  expect(fn.text, fn.text).toMatch(/^"function"/);
  const img = await ev(`(() => { const i = document.getElementById("logo"); return i.complete && i.naturalWidth; })()`);
  expect(img.text, img.text).toMatch(/^40/);
  const view = await tool("view_page", {});
  expect(view.ok, view.text).toBe(true);
  expect(view.text).not.toMatch(/probeFn|404/);
}

test("in the homepage project adopted from an admin's document (owner -home), the render loads the page's script and image", async () => {
  const server = await own();
  const token = await (await person(server, "tester")).token("view owner tests", "admin");
  // The old homepage, /tester/landing, made before anything opened / (which would make a homepage project of its own).
  const made = await runTool<{ id: string }>(
    server.root,
    "create_document",
    { files: { "index.html": "<!doctype html><title>Erga</title><h1>Old</h1>" }, slug: "landing" },
    { token }
  );
  expect(made.error).toBeUndefined();
  expect((await setLanding(server, made.result!.id)).error).toBeUndefined();
  // The first / adopts it.
  expect(docOf((await front(server)).html)).toBe(made.result!.id);
  await probe(server, "/_home");
});

test("in a document of another person's that the caller may edit, the render loads the page's script and image", async () => {
  const server = await own();
  const owner = await person(server, "renderowner");
  const { id } = await owner.newDoc();
  const shared = await owner.share(id, "tester", "editor");
  expect(shared.ok, shared.error).toBe(true);
  await probe(server, id);
});
