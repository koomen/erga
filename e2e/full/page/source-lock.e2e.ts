// An agent's edit to the source locks the document for its run of edits (document/room.ts): the person's page is
// read-only meanwhile and says who's editing; their keys change nothing. Once the agent's run ends, they edit again,
// with no reload.
// A page's own edits (call_edit) don't lock.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { DISK_MS, F } from "../../helpers/editor";
import { deck } from "./view-page";

await servers.main();

/** The note on the page while someone holds the lock, or "". */
const note = (ed: Awaited<ReturnType<typeof deck>>["ed"]) =>
  ed.frame<string>(`${F}.querySelector("erga-note")?.shadowRoot?.textContent ?? ""`);

test("while an agent edits the source the page is read-only and says who; after its run, it edits again", { timeout: 45_000 }, async ({
  tab,
}) => {
  const { ed, tool } = await deck(tab, "page");
  await tool("edit", {
    path: "index.html",
    edits: [{ oldText: "<h1>Launch notes</h1>", newText: "<h1>Launch notes</h1>\n    <p>From the agent.</p>" }],
  });
  await expect.poll(() => note(ed)).toMatch(/is editing this page's source/);
  // (The editor stays on the page, read-only: the agent's edits show as they land.)
  expect(await ed.frame<boolean>(`${F}.body.isContentEditable`)).toBe(false);
  // Keys change nothing meanwhile.
  const h1 = await ed.rectOf("h1");
  await ed.page.mouse.click(h1.x, h1.y);
  await ed.page.keyboard.type("X");
  expect(ed.disk()).not.toContain("X");
  // The agent's run ends (a while after its last call): the lock goes, and the page edits again.
  await until(async () => (await note(ed)) == "", 20_000, "the lock goes");
  await ed.loaded();
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("<h1>Launch notes!</h1>");
  expect(ed.disk()).toContain("<p>From the agent.</p>");
});

test("a page's own edit (call_edit) doesn't lock: the page stays editable", async ({ tab }) => {
  const { ed, tool } = await deck(tab, "page");
  await tool("call_edit", { path: "index.html", edit: "replace_text", input: { selector: "h1", find: "Launch", text: "Release" } });
  await expect.poll(() => ed.textOf("h1")).toBe("Release notes");
  expect(await note(ed)).toBe("");
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("<h1>Release notes!</h1>");
});
