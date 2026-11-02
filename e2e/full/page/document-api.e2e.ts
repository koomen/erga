// A page's own edits, as an agent calls them (POST /api/tools/<name>, with the document): document_api lists erga/text's
// edits with their inputs, call_edit runs one in the document's object, and the person's page shows it at once.
import { expect, servers, test } from "../../helpers/fixtures";
import { DISK_MS } from "../../helpers/editor";
import { deck } from "./view-page";

await servers.main();

test("document_api lists the page's edits; call_edit runs one, the file and the page show it; one that can't, says why", async ({
  tab,
}) => {
  const { ed, tool, fails } = await deck(tab, "page");
  const api = JSON.parse((await tool("document_api", { path: "index.html" })).text) as { api: string; edits: { name: string }[] };
  expect(api.api).toBe("erga/text");
  expect(api.edits.map((e) => e.name)).toContain("replace_text");
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
