// An id is unique in the page: an element an edit in the editor adds (Enter, a custom edit) loses an id (or a link's
// name) that the page has already. The element that was there keeps it ("An id is unique in the page").
import { expect, servers, test } from "../../fixtures";
import { F, openEditor, type Editor } from "../../editor";

await servers.main();

const ids = (ed: Editor) => ed.frame<string[]>(`[...${F}.querySelectorAll("[id]")].map((e) => e.id)`);

test("Enter at the end of a block with an id: the new block has its class but not its id, and typing goes in it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "unique-ids");
  await ed.clickEnd("#target");
  await ed.press("Enter");
  await ed.type("new");
  await expect.poll(() => ed.source()).toContain(`<p id="target" class="lead">A block with an id.</p>\n  <p class="lead">new</p>`);
  expect(await ed.count("[id=target]")).toBe(1);
});

test("Enter at the start of a block with an id: the id stays with the text, and the blank block before has none", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "unique-ids");
  await ed.clickEnd("#target");
  await ed.press("Home");
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toContain(`<p class="lead"><br></p>\n  <p id="target" class="lead">A block with an id.</p>`);
  await ed.type("X");
  await expect.poll(() => ed.source()).toContain(`<p id="target" class="lead">XA block with an id.</p>`);
  expect(await ed.frame<boolean>(`${F}.activeElement.matches("#target")`)).toBe(true);
});

test("Enter inside a link with an id and a name: the second half of the link keeps its href, not its id or name", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "unique-ids");
  const p = await ed.charAt("#link", 4);
  await ed.click(p.x, p.y);
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toContain(`<p id="linked">See <a id="link" name="link" href="#target">the </a></p>\n  <p><a href="#target">target block</a> above.</p>`);
  expect(await ed.count("[id=link]")).toBe(1);
  expect(await ed.count("[name=link]")).toBe(1);
});

/** Copies (or cuts) the selection and pastes it at the end of `to`, through the editor's own clipboard handlers. */
async function copyTo(ed: Editor, how: "copy" | "cut", to: string) {
  await ed.frame(`(() => { window.__clip = new DataTransfer(); ${F}.activeElement.dispatchEvent(new ClipboardEvent(${JSON.stringify(how)}, { clipboardData: __clip, bubbles: true, cancelable: true })); return __clip.getData("text/html"); })()`);
  await ed.clickEnd(to);
  await ed.frame(`(${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: __clip, bubbles: true, cancelable: true })), 1)`);
}

test("copy and paste of a block with an id: the original keeps its id, and the paste adds no id", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "unique-ids");
  const before = await ids(ed);
  await ed.selectAllOf("#linked");
  await copyTo(ed, "copy", ".other");
  await expect.poll(() => ed.source()).toContain(`<p class="other">Another block.See <a href="#target">the target block</a> above.</p>`);
  expect(await ids(ed)).toEqual(before);
});

test("cut and paste of text in a block with an id: the block keeps its id, and the paste adds none", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "unique-ids");
  const before = await ids(ed);
  await ed.selectAllOf("#link");
  await copyTo(ed, "cut", ".other");
  await expect.poll(() => ed.source()).toContain(`<p class="other">Another block.the target block</p>`);
  expect(await ids(ed)).toEqual(before);
});

/** Clicks a card's button (copy, up). */
async function press(ed: Editor, card: string, button: string) {
  const at = await ed.rectOf(`${card} > .ctl .${button}`);
  await ed.click(at.x, at.y);
  await ed.settle();
}

test("a custom edit that copies a card: the copy loses the id, the original keeps it; a move keeps the id; undo brings back the page", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "unique-ids");
  const original = await ed.source();
  await press(ed, "#card-1", "copy");
  await expect.poll(() => ed.source()).toContain(`<article class="card">\n      <h3>First card (copy)</h3>\n    </article>`);
  expect(await ids(ed)).toEqual(["target", "linked", "link", "card-1", "card-2"]);
  await press(ed, "#card-2", "up");
  await expect.poll(() => ed.frame<string[]>(`[...${F}.querySelectorAll(".card h3")].map((h) => h.textContent)`)).toEqual(["First card", "Second card", "First card (copy)"]);
  expect(await ids(ed)).toEqual(["target", "linked", "link", "card-1", "card-2"]);
  await ed.press("ControlOrMeta+z");
  await ed.press("ControlOrMeta+z");
  await expect.poll(() => ed.source()).toBe(original);
});
