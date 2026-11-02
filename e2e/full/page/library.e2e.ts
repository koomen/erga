// erga/text is a library at one address, /erga/text/editor.js, its newest build (server/pages/assets.ts). Erga adds it to
// a page that brings no editor of its own; a page that imports it itself gets it once, and edits the same.
import { expect, servers, test } from "../../helpers/fixtures";
import { DISK_MS, F, openEditor } from "../../helpers/editor";

await servers.main();

/** The page's scripts from Erga's origin: the library's address, and its build. */
const scripts = (src: string) =>
  `[...${F}.querySelectorAll("script[src]")].map((s) => s.src).filter((u) => u.startsWith(${JSON.stringify(src)}))`;

test("Erga adds erga/text by its one address; a page that imports it itself gets it once, and typing edits it", async ({ tab }) => {
  const server = await servers.main();
  const ed = await openEditor(tab, server, "empty");
  await ed.type("Hello");
  await expect.poll(() => ed.source()).toContain("Hello");
  expect(await ed.frame<string[]>(scripts(`${server.root}/erga/`))).toEqual([`${server.root}/erga/text/editor.js`]);

  // The page imports the library itself: Erga adds nothing, and the page's own import runs the editor.
  ed.write(ed.disk().replace("</head>", `<script type="module" src="${server.root}/erga/text/editor.js"></script>\n</head>`));
  await expect.poll(() => ed.source(), { timeout: DISK_MS }).toContain("/erga/text/editor.js");
  await tab.page.reload();
  await ed.loaded();
  expect(await ed.frame<string[]>(scripts(`${server.root}/erga/`))).toEqual([`${server.root}/erga/text/editor.js`]);
  await ed.clickEnd("p");
  await ed.type(" world");
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("Hello world");
});
