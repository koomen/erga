// The smoke run: the editor's core, end to end, on one dev server, in about a minute. `bun run test` runs it after
// the typecheck and the unit tests; the rest of the end-to-end tests are in e2e/full (bun run test:full).
// Keep it small: a test here is one that would catch a broken editor. Add one only if it replaces another, or the run
// stays well under its limit (E2E_SMOKE_LIMIT_S in e2e/run.ts).
import { expect, servers, test } from "../fixtures";
import { editor, openEditor } from "../editor";
import { docShows, openViewer } from "../full/viewer/viewer";

await servers.main();

test("the front page and the documents list answer", async () => {
  const s = await servers.main();
  for (const path of ["/", "/docs"]) expect((await fetch(`${s.root}${path}`)).status, path).toBe(200);
});

test("typing on an HTML page updates the page, the source and the file on disk", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  await ed.clickEnd("h1");
  await ed.type(" v2");
  await expect.poll(() => ed.textOf("h1")).toBe("Launch notes v2");
  expect(await ed.source()).toContain("<h1>Launch notes v2</h1>");
  await expect.poll(() => ed.disk()).toContain("<h1>Launch notes v2</h1>");
});

test("undo takes a typed edit back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  const original = await ed.source();
  await ed.clickEnd("h1");
  await ed.type(" draft");
  await expect.poll(() => ed.textOf("h1")).toBe("Launch notes draft");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
  expect(await ed.textOf("h1")).toBe("Launch notes");
});

test("an edit made to the file on disk reaches the open page", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  ed.write(ed.disk().replace("Where the leads go.", "Where the leads went."));
  await expect.poll(() => ed.textOf("figcaption")).toBe("Where the leads went.");
});

test("from the reader, the pencil to the first edit: measured, and well under the limit", async ({ tab }) => {
  // The measure the files plan names (step 4, one Yjs document for each text file): the time from the pencil to the first
  // typed character in the document's text. It prints, for a before and after; the limit only catches a broken switch.
  const server = await servers.main();
  const { dir, address } = await server.fixture("page");
  const page = tab.page;
  tab.strict = true;
  await openViewer(page, address);
  await docShows(page, "Launch notes");
  const ed = editor(page, { address, dir, file: `${dir}/index.html` });
  const clicked = Date.now();
  await page.locator(".erga-edit-button").click();
  await ed.loaded();
  const ready = Date.now() - clicked;
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => ed.source(), { timeout: 10_000 }).toContain("<h1>Launch notes!</h1>");
  const first = Date.now() - clicked;
  console.log(`[measure] the pencil to the first edit: ${first} ms (the editor ready: ${ready} ms)`);
  expect(first).toBeLessThan(10_000);
});

test("two tabs on one document: typing in one shows in the other, without a reload", async ({ tab }) => {
  const a = await openEditor(tab, await servers.main(), "page");
  const page = await tab.page.context().newPage();
  await page.goto(`${a.address}?edit`);
  const b = editor(page, { address: a.address, dir: a.dir, file: a.file });
  await b.loaded();
  await a.clickEnd("h1");
  await a.type(" (shared)");
  await expect.poll(() => b.textOf("h1")).toBe("Launch notes (shared)");
  await page.close();
});
