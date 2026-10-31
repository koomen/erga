// The editor's title opens the tree: index.html first, as its own row, then the project's folders, pages and other files ("the editor").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { focused, multi, openCard, openTreeEditor, rows, js } from "./tree";

await servers.main();

test("the title opens the tree: index.html first by its title, marked as the page you're on, then the rest at the same level, folders first; focus goes to the page you're on", async ({
  tab,
}) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  await openTreeEditor(tab, doc.base);
  expect(await js(page, `document.getElementById("pages").hidden`)).toBe(true);
  await openCard(page);
  const r = await rows(page);
  expect(r[0]).toEqual(["index.html", "Field guide", 1, true]);
  // Folders first, then pages, then the project's other files.
  expect(r.slice(1).map((x) => [x[0], x[2]])).toEqual([
    ["assets", 1],
    ["blog", 1],
    ["fonts", 1],
    ["about.html", 1],
    ["contact.html", 1],
    ["style.css", 1],
  ]);
  expect(r.find((x) => x[0] == "about.html")?.[1]).toBe("About us");
  expect(await js(page, `document.getElementById("doc-title").getAttribute("aria-expanded") == "true"`)).toBe(true);
  // (openTreeEditor waits for the editor's page to have the focus first: see it, and the race it avoids.)
  await expect.poll(() => focused(page)).toBe("index.html");
});

test("a project's tree shows every file, as the server and an agent (ls, find) do; a file that isn't a page links to itself, in a new tab", async ({
  tab,
}) => {
  const page = tab.page;
  const doc = await multi(await servers.main());
  const all = await doc.tree();
  for (const f of ["style.css", "assets", "assets/owl.svg", "fonts", "fonts/field.woff2"]) expect(all).toContain(f);
  const ls = await doc.agentTool("ls"), found = await doc.agentTool("find", { pattern: "**/*" });
  for (const f of ['"style.css"', '"assets/owl.svg"', '"fonts"']) expect(ls).toContain(f);
  for (const f of ["assets/owl.svg", "fonts/field.woff2"]) expect(found).toContain(f);
  await openTreeEditor(tab, doc.base);
  await openCard(page);
  await page.evaluate(`document.querySelector('.et-row[data-path="assets"]').click()`);
  await until(async () => (await rows(page)).some((x) => x[0] == "assets/owl.svg"), 5000, "the folder of images opens");
  const link = await js(
    page,
    `(() => { const a = document.querySelector('.et-row[data-path="assets/owl.svg"] .et-name'); return [a.localName, new URL(a.href).pathname, a.target]; })()`
  );
  expect(link).toEqual(["a", `${doc.address}/assets/owl.svg`, "_blank"]);
});
