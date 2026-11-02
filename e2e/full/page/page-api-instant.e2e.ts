// A page's own edits show at once, as a typed letter does (agents/document/PROMPT.md, "A page's own edits"): the editor
// runs the page's API module in the page and makes its change in the same frame. The room and the source follow.
import { expect, servers, test } from "../../helpers/fixtures";
import { F, W, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const order = (ed: Editor) => ed.frame<string[]>(`[...${F}.querySelectorAll("ul.todo > li p")].map((p) => p.textContent)`);

/** From now on, the list's order in each frame the page draws, and when the pointer went up. */
const record = (ed: Editor) =>
  ed.frame(`(() => {
    const log = (${W}.__frames = []);
    ${F}.addEventListener("pointerup", () => (${W}.__up = performance.now()), true);
    const tick = (t) => { log.push({ t, order: [...${F}.querySelectorAll("ul.todo > li p")].map((p) => p.textContent).join(",") }); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`);
/** Drags with the mouse from a point to `y`, holding it there `hold` ms before the drop. */
async function dragTo(ed: Editor, from: { x: number; y: number }, y: number, hold = 0) {
  const mouse = ed.page.mouse;
  await mouse.move(from.x, from.y);
  await mouse.down();
  for (let i = 1; i <= 8; i++) await mouse.move(from.x, from.y + ((y - from.y) * i) / 8);
  // (The person holds the item there: a time of theirs, not a wait for the page.)
  if (hold) await new Promise((r) => setTimeout(r, hold));
  await mouse.up();
}
const frames = (ed: Editor) =>
  ed.frame<{ up: number; frames: { t: number; order: string }[] }>(`({ up: ${W}.__up, frames: ${W}.__frames })`);

for (const fixture of ["page-api-todo", "erga-plans-todo"])
  test(`${fixture}: an item dragged to a new place is there in the next frame, and never goes back`, async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), fixture);
    expect(await order(ed)).toEqual(["Milk", "Eggs", "Bread", "Butter"]);
    await record(ed);
    // Milk's grip, dragged below Bread.
    const from = await ed.rectOf("ul.todo > li:nth-child(1) .grip");
    const to = await ed.rectOf("ul.todo > li:nth-child(3)");
    await dragTo(ed, from, to.y + 6);
    await expect.poll(() => ed.source()).toMatch(/<li><p>Eggs<\/p><\/li>\s*<li><p>Bread<\/p><\/li>\s*<li><p>Milk<\/p><\/li>/);
    // 60 frames more (about a second): nothing comes back later to put it back, or to move it again.
    const done = async () => {
      const { up, frames: log } = await frames(ed);
      return { up, after: log.filter((f) => f.t > up) };
    };
    await expect.poll(async () => (await done()).after.length, { timeout: 5000 }).toBeGreaterThan(60);
    const { up, after } = await done();
    const moved = after.find((f) => f.order == "Eggs,Bread,Milk,Butter");
    expect(after[0].order, `the item is at its new place ${Math.round(moved!.t - up)} ms after the drop`).toBe("Eggs,Bread,Milk,Butter");
    expect(after.filter((f) => f.order != "Eggs,Bread,Milk,Butter")).toEqual([]);
  });

test("a long drag drops too: the drop is the person's own gesture", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page-api-todo");
  const from = await ed.rectOf("ul.todo > li:nth-child(4) .grip");
  const to = await ed.rectOf("ul.todo > li:nth-child(1)");
  // Held longer than a page's edit may come after the pointer went down (5 s, at the tests' timescale).
  await dragTo(ed, from, to.y - 6, 800);
  expect(await order(ed)).toEqual(["Butter", "Milk", "Eggs", "Bread"]);
  await expect.poll(() => ed.source()).toMatch(/<li><p>Butter<\/p><\/li>\s*<li><p>Milk<\/p><\/li>/);
});
