// A page with problems nobody asked about: each explained in turn, with a button to have the agent fix it ("Broken page").
import { expect, servers, test } from "../fixtures";
import { openEditor, type Editor } from "../editor";

await servers.main();

type Toast = { text: string; shown: boolean; fix: boolean; fixDisabled: string | null; fixTitle: string };
const toast = (ed: Editor) => ed.eval<Toast>(`(() => { const t = document.getElementById("toast"), b = t.querySelector(".toast-fix"); return { text: t.querySelector(".toast-text")?.textContent ?? t.textContent, shown: t.classList.contains("show"), fix: !!b, fixDisabled: b?.getAttribute("aria-disabled") ?? null, fixTitle: b?.title ?? "" }; })()`);

test("a broken page says what's wrong by itself, with a fix button that, with the agent off, is disabled and says why", async ({ tab }) => {
  // The page's script error is the point.
  const ed = await openEditor(tab, await servers.main(), "broken", { allowErrors: true });
  await expect.poll(async () => (await toast(ed)).shown).toBe(true);
  const first = await toast(ed);
  expect(first.text).toMatch(/missing\.css|drawTheChart/);
  expect(first.fix).toBe(true);
  expect(first.fixDisabled).toBe("true");
  expect(first.fixTitle).toMatch(/agent is off/i);
  await ed.eval(`document.querySelector("#toast .toast-fix").click()`);
  await expect.poll(async () => (await toast(ed)).text).toMatch(/agent is off/i);
});

test("the other problem comes next: between them they name the missing stylesheet and the script error", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "broken", { allowErrors: true });
  await expect.poll(async () => (await toast(ed)).shown).toBe(true);
  const first = await toast(ed);
  // A click on the page moves on, once the first has been up its minimum.
  const h1 = await ed.rectOf("h1", 0.5);
  await expect.poll(async () => { await ed.click(h1.x, h1.y); const t = await toast(ed); return t.shown && t.fix && t.text != first.text; }, { timeout: 8000 }).toBe(true);
  const second = await toast(ed);
  expect(second.text).toMatch(/missing\.css|drawTheChart/);
  const both = first.text + " " + second.text;
  expect(both).toMatch(/stylesheet “missing\.css”/);
  expect(both).toMatch(/drawTheChart is not defined/);
});
