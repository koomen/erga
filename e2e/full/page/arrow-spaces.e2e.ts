// Spaces at the ends of a block: every space someone can type shows, and the caret stops at each one, the same
// with ArrowRight as with ArrowLeft. Whitespace with a line break in it is the source's formatting: it collapses as
// on the page and holds no caret ("Arrow keys and spaces").
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

/** Where the caret is: its source position, its block, and where the page draws it. */
type Stop = { head: number; id: string; x: number; y: number };
const stop = async (ed: Editor): Promise<Stop> => {
  const head = (await ed.selection()).head;
  const at = await ed.frame<{ id: string; x: number; y: number }>(`(() => {
    const s = ${F}.getSelection(), r = s.getRangeAt(0), b = r.getClientRects()[0] ?? r.getBoundingClientRect();
    return { id: (s.anchorNode.nodeType == 1 ? s.anchorNode : s.anchorNode.parentElement).closest("[id]")?.id ?? "", x: Math.round(b.left), y: Math.round(b.top) };
  })()`);
  return { head, ...at };
};

/** Puts the caret at the start of a block's text: a click on its first line, then Home. */
async function startOf(ed: Editor, sel: string) {
  const at = await ed.charAt(sel, (await ed.frame<string>(`${F}.querySelector(${JSON.stringify(sel)}).firstChild.nodeValue`)).search(/\S/) + 1);
  await ed.click(at.x, at.y);
  await ed.press("Home");
  await ed.settle();
}

/**
 * The caret's stops in a block, both ways: ArrowRight from the start of its text until the caret leaves it, and
 * ArrowLeft from the start of the next block until the caret is back at the start.
 */
async function walks(ed: Editor, sel: string, next: string) {
  await startOf(ed, sel);
  const right: Stop[] = [await stop(ed)];
  for (let i = 0; i < 80; i++) {
    await ed.press("ArrowRight");
    await ed.settle();
    const s = await stop(ed);
    if (s.id != sel.slice(1)) break;
    right.push(s);
  }
  await startOf(ed, next);
  const left: Stop[] = [];
  for (let i = 0; i < 80; i++) {
    await ed.press("ArrowLeft");
    await ed.settle();
    const s = await stop(ed);
    left.unshift(s);
    if (s.head <= right[0].head) break;
  }
  return { right, left };
}

/** The two walks stop at the same places, and the page draws each stop on a line further right than the one before. */
async function symmetric(ed: Editor, sel: string, next: string) {
  const { right, left } = await walks(ed, sel, next);
  expect(left.map((s) => s.head)).toEqual(right.map((s) => s.head));
  for (let i = 1; i < right.length; i++) if (right[i].y == right[i - 1].y) expect(right[i].x, `stop ${i} of ${sel}`).toBeGreaterThan(right[i - 1].x);
  return right;
}

// [the block, the next block, the text before the caret's last stop in the block, as the source has it]
const CASES: [string, string, string][] = [
  ["#spaces", "#after-spaces", "Three spaces at the end   "],
  ["#nbsp", "#after-nbsp", "Two no-break spaces at the end&nbsp;&nbsp;"],
  ["#br", "#after-br", "and a second line"],
  ["#lead", "#pretty", "Two spaces at the start"],
  ["#pretty", "#after-pretty", "Text that the source indents"],
];

for (const [sel, next, end] of CASES) {
  test(`${sel}: ArrowRight stops where ArrowLeft stops, at each space the page shows, and the caret ends after "${end.slice(-12)}"`, async ({ tab }) => {
    const ed = await openEditor(tab, await servers.main(), "trailing-space");
    const src = await ed.source();
    const stops = await symmetric(ed, sel, next);
    expect(stops[stops.length - 1].head).toBe(src.indexOf(end) + end.length);
  });
}

test("spaces before a <br> show, and the caret stops at each of them", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "trailing-space");
  const src = await ed.source();
  const stops = await symmetric(ed, "#br", "#after-br");
  const line = src.indexOf("a break") + "a break".length;
  for (let k = 0; k <= 3; k++) expect(stops.map((s) => s.head)).toContain(line + k);
});

test("spaces typed at the end of a block: ArrowRight goes through them, as ArrowLeft does, and typing goes in after them", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "trailing-space");
  await ed.clickEnd("#after-spaces");
  await ed.type("   ");
  await expect.poll(() => ed.source()).toContain("The next block   </p>");
  const stops = await symmetric(ed, "#after-spaces", "#nbsp");
  expect(stops.slice(-4).map((s) => s.x)).toEqual([...new Set(stops.slice(-4).map((s) => s.x))]);
  await startOf(ed, "#nbsp");
  await ed.press("ArrowLeft");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("The next block   !</p>");
});

test("from the next block, ArrowLeft puts the caret at the end of indented text, not after the source's line break", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "trailing-space");
  await startOf(ed, "#after-pretty");
  await ed.press("ArrowLeft");
  await ed.type("!");
  await expect.poll(() => ed.source()).toContain("indents!\n    </p>");
});

test("Shift+ArrowRight selects the spaces at the end one at a time, then goes on into the next block; Shift+ArrowLeft takes them back", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "trailing-space");
  const src = await ed.source();
  const end = src.indexOf("at the end   ") + "at the end".length;
  await startOf(ed, "#after-spaces");
  await ed.press("ArrowLeft");
  for (let i = 0; i < 3; i++) await ed.press("ArrowLeft");
  await ed.settle();
  expect((await ed.selection()).head).toBe(end);
  for (let k = 1; k <= 3; k++) {
    await ed.press("Shift+ArrowRight");
    await expect.poll(() => ed.selection().then((s) => s.text)).toBe(" ".repeat(k));
  }
  await ed.press("Shift+ArrowRight");
  await expect.poll(() => ed.selection().then((s) => s.text.startsWith("   </p>"))).toBe(true);
  await ed.press("Shift+ArrowLeft");
  await ed.press("Shift+ArrowLeft");
  await expect.poll(() => ed.selection().then((s) => s.text)).toBe("  ");
});

test("End goes after the spaces at the end of a block, Home before the spaces at its start", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "trailing-space");
  const src = await ed.source();
  await startOf(ed, "#spaces");
  await ed.press("End");
  await expect.poll(() => ed.selection().then((s) => s.head)).toBe(src.indexOf("at the end   ") + "at the end   ".length);
  await ed.clickEnd("#lead");
  await ed.press("Home");
  await expect.poll(() => ed.selection().then((s) => s.head)).toBe(src.indexOf("  Two spaces"));
});

test("ArrowUp and ArrowDown keep the caret's column across a block that ends in spaces", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "trailing-space");
  await startOf(ed, "#after-spaces");
  for (let i = 0; i < 5; i++) await ed.press("ArrowRight");
  const before = await stop(ed);
  await ed.press("ArrowUp");
  const up = await stop(ed);
  expect(up.id).toBe("spaces");
  expect(Math.abs(up.x - before.x)).toBeLessThan(10);
  await ed.press("ArrowDown");
  const down = await stop(ed);
  expect(down.id).toBe("after-spaces");
  expect(Math.abs(down.x - before.x)).toBeLessThan(10);
});
