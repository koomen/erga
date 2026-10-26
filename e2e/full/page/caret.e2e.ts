// The caret on the page is drawn by the editor: wider than the browser's 1 px, and wider in large type.
import { expect, servers, test } from "../../helpers/fixtures";
import { F, openEditor } from "../../helpers/editor";

await servers.main();

/** The drawn caret: whether it shows, its size, and how far it is from the selection's own place. */
const CARET = `(() => {
  const c = ${F}.querySelector("erga-caret");
  if (!c) return null;
  const r = c.getBoundingClientRect(), s = ${F}.getSelection().getRangeAt(0).getBoundingClientRect();
  return { shown: getComputedStyle(c).display != "none", width: r.width, height: r.height, off: Math.abs(r.left + r.width / 2 - s.left) + Math.abs(r.top - s.top) };
})()`;

test("the drawn caret shows in place of the native one, is wider than 1 px, and is wider in a heading than in body text", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page");
  type Caret = { shown: boolean; width: number; height: number; off: number } | null;
  await ed.clickEnd("h1");
  await ed.type("!");
  await expect.poll(async () => { const c = await ed.frame<Caret>(CARET); return !!c?.shown && c.off < 2; }).toBe(true);
  const heading = (await ed.frame<Caret>(CARET))!;
  expect(heading.width).toBeGreaterThan(2);
  expect(heading.height).toBeGreaterThan(20);
  // The native caret is transparent, so there aren't two.
  expect(await ed.frame<string>(`getComputedStyle(${F}.querySelector("h1")).caretColor`)).toBe("rgba(0, 0, 0, 0)");
  // It has the text's colour.
  const colors = await ed.frame<[string, string]>(`[getComputedStyle(${F}.querySelector("erga-caret")).backgroundColor, getComputedStyle(${F}.querySelector("h1")).color]`);
  expect(colors[0]).toBe(colors[1]);

  await ed.clickEnd("p.lede em");
  await expect.poll(async () => { const c = await ed.frame<Caret>(CARET); return !!c?.shown && c.off < 2; }).toBe(true);
  const body = (await ed.frame<Caret>(CARET))!;
  expect(body.width).toBeGreaterThan(1);
  expect(body.width).toBeLessThan(heading.width);

  // A selection of text has no caret.
  await ed.selectChars("p.lede em", 2);
  await expect.poll(async () => (await ed.frame<Caret>(CARET))?.shown).toBe(false);
});
