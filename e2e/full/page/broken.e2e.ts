// A page with problems nobody asked about: each explained in turn, with a button to have the agent fix it ("Broken page").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";

await servers.main();

type Toast = { text: string; shown: boolean; fix: boolean; fixDisabled: string | null; fixTitle: string };
const toast = (ed: Editor) => ed.eval<Toast>(`(() => { const t = document.getElementById("toast"), b = t.querySelector(".toast-fix"); return { text: t.querySelector(".toast-text")?.textContent ?? t.textContent, shown: t.classList.contains("show"), fix: !!b, fixDisabled: b?.getAttribute("aria-disabled") ?? null, fixTitle: b?.title ?? "" }; })()`);

test("a broken page says what's wrong by itself, with a fix button that, with the agent off, is disabled and says why", async ({ tab }) => {
  // The page's script error is the point.
  const ed = await openEditor(tab, await servers.main(), "broken", { allowErrors: true });
  await expect.poll(async () => (await toast(ed)).shown).toBe(true);
  // The button says "Connecting to the agent…" until the agent's state comes, which can be after the page's problems.
  await expect.poll(async () => (await toast(ed)).fixTitle).toMatch(/agent is off/i);
  const first = await toast(ed);
  expect(first.text).toMatch(/missing\.css|drawTheChart/);
  expect(first.fix).toBe(true);
  expect(first.fixDisabled).toBe("true");
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

test("a problem closes with its × button and with Escape, and doesn't come back when the page loads again", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "broken", { allowErrors: true });
  await expect.poll(async () => (await toast(ed)).shown).toBe(true);
  const first = (await toast(ed)).text;
  await ed.eval(`document.querySelector("#toast .toast-close").click()`);
  await expect
    .poll(async () => {
      const t = await toast(ed);
      return t.shown && t.text != first;
    })
    .toBe(true);
  const second = (await toast(ed)).text;
  // The caret in the text: Escape goes to the shell (the frame passes it on), which closes the problem first.
  await ed.clickEnd("h1");
  await ed.press("Escape");
  await expect.poll(async () => (await toast(ed)).shown).toBe(false);
  // The page made afresh: its script throws again, and its stylesheet fails again. Neither shows again.
  await ed.eval(`window.ergaPage.page.render()`);
  await ed.loaded();
  // The new page's editor has taken its problems (client/inline/page-problems.ts), and the tab has heard them.
  await until(() => ed.frame<boolean>(`!!window.__ergaReport && document.readyState == "complete"`), 5000, "the page reports its problems");
  await ed.settle();
  expect((await toast(ed)).shown, `${first} / ${second}`).toBe(false);
});

test("an error in Erga's own code is not the page's problem: no message, no fix button", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "one-line", { allowErrors: true });
  // An error thrown in the editor's own script (its stack's first file is /_erga/frame-*.js), as the desync threw.
  await ed.frame(`(() => {
    const own = [...document.scripts].map((s) => s.src).find((s) => /\\/_erga\\/frame/.test(s)) || performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\\/_erga\\/frame/.test(n));
    const error = new RangeError("Applying change set to a document with the wrong length");
    error.stack = "RangeError: Applying change set to a document with the wrong length\\n    at B.apply (" + own + ":5:4109)";
    dispatchEvent(new ErrorEvent("error", { message: "Uncaught " + error.message, filename: own, lineno: 5, error }));
    return true;
  })()`);
  // And a rejection with no file, whose stack starts in the editor's code.
  await ed.frame(`(() => {
    const own = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\\/_erga\\/frame/.test(n));
    const reason = new Error("an editor bug"); reason.stack = "Error: an editor bug\\n    at x (" + own + ":7:1)";
    dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason }));
    return true;
  })()`);
  // A page's own error still shows, after them: the editor's never did.
  await ed.frame(`setTimeout(() => { throw new Error("the page's own error"); }), true`);
  await expect.poll(async () => (await toast(ed)).text).toMatch(/the page's own error/);
  expect((await toast(ed)).text).not.toMatch(/wrong length|editor bug/);
  await ed.eval(`document.querySelector("#toast .toast-close").click()`);
  expect((await toast(ed)).shown).toBe(false);
});
