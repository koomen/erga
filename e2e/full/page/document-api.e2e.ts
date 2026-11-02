// A page's edits, as an agent calls them (POST /api/tools/<name>, with the document): document_api lists its APIs' edits
// with their inputs (erga/text's, and the page's own, run in a sandbox), call_edit runs one in the document's object,
// and the person's page shows it at once.
import { expect, servers, test } from "../../helpers/fixtures";
import { DISK_MS } from "../../helpers/editor";
import { deck } from "./view-page";

await servers.main();

test("document_api lists the page's edits; call_edit runs one, the file and the page show it; one that can't, says why", async ({
  tab,
}) => {
  const { ed, tool, fails } = await deck(tab, "page");
  const { apis } = JSON.parse((await tool("document_api", { path: "index.html" })).text) as {
    apis: { api: string; edits: { name: string }[] }[];
  };
  expect(apis.map((a) => a.api)).toEqual(["erga/text"]);
  expect(apis[0].edits.map((e) => e.name)).toContain("replace_text");
  const done = await tool("call_edit", {
    path: "index.html",
    edit: "replace_text",
    input: { selector: "h1", find: "Launch", text: "Release" },
  });
  expect(done.text).toMatch(/^Replaced "Launch"\. Edited index\.html/);
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("<h1>Release notes</h1>");
  await expect.poll(() => ed.textOf("h1")).toBe("Release notes");
  await tool("call_edit", { path: "index.html", edit: "style", input: { selector: "p.lede", find: "ship them", style: "strong" } });
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("<strong>ship them</strong>");
  expect(
    await fails("call_edit", { path: "index.html", edit: "replace_text", input: { selector: "h1", find: "Launch", text: "x" } })
  ).toMatch(/"Launch" isn't in the text of h1/);
  expect(await fails("call_edit", { path: "index.html", edit: "bold", input: {} })).toMatch(/erga\/text has no edit "bold"/);
});

test("a page with its own API: document_api lists its edits first; call_edit runs one in the sandbox, and the page shows it", async ({
  tab,
}) => {
  const { ed, tool, fails } = await deck(tab, "page-api");
  const { apis } = JSON.parse((await tool("document_api", { path: "index.html" })).text) as {
    apis: { api: string; edits: { name: string }[] }[];
  };
  expect(apis.map((a) => a.api)).toEqual(["views", "erga/text"]);
  expect(apis[0].edits.map((e) => e.name)).toEqual(["add_view", "add_under", "delete_view", "move_view"]);
  expect((await tool("call_edit", { path: "index.html", edit: "delete_view", input: { view: [3] } })).text).toMatch(
    /^Made views's delete_view\. Edited index\.html/
  );
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).not.toContain("<h3>Settings</h3>");
  await expect.poll(() => ed.count("h3")).toBe(7);
  expect(await fails("call_edit", { path: "index.html", edit: "move_view", input: { view: [1], by: -1 } })).toBe(
    "the first view can't move up"
  );
  expect(await fails("call_edit", { path: "index.html", edit: "delete_view", input: { view: [9] } })).toMatch(
    /delete_view can't be made: .*matches 0 elements/
  );
});
