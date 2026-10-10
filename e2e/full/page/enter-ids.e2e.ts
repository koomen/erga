// Enter does not copy an id (or a link's name) to the new block: it stays with the block that keeps the text ("Enter and the placeholder <br>").
import { expect, servers, test } from "../../fixtures";
import { F, openEditor } from "../../editor";

await servers.main();

test("Enter at the end of a block with an id: the new block has its class but not its id, and typing goes in it", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "backspace-empty");
  await ed.clickEnd("#target");
  await ed.press("Enter");
  await ed.type("new");
  await expect.poll(() => ed.source()).toContain(`<p id="target" class="lead">A block with an id.</p>\n    <p class="lead">new</p>`);
  expect(await ed.count("[id=target]")).toBe(1);
});

test("Enter at the start of a block with an id: the id stays with the text, and the blank block before has none", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "backspace-empty");
  await ed.clickEnd("#target");
  await ed.press("Home");
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toContain(`<p class="lead"><br></p>\n    <p id="target" class="lead">A block with an id.</p>`);
  await ed.type("X");
  await expect.poll(() => ed.source()).toContain(`<p id="target" class="lead">XA block with an id.</p>`);
  expect(await ed.frame<boolean>(`${F}.activeElement.matches("#target")`)).toBe(true);
});

test("Enter inside a link with an id and a name: the second half of the link keeps its href, not its id or name", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "backspace-empty");
  const p = await ed.charAt("#link", 4);
  await ed.click(p.x, p.y);
  await ed.press("Enter");
  await expect.poll(() => ed.source()).toContain(`<p id="linked">See <a id="link" name="link" href="#target">the </a></p>\n    <p><a href="#target">target block</a> above.</p>`);
  expect(await ed.count("[id=link]")).toBe(1);
  expect(await ed.count("[name=link]")).toBe(1);
});
