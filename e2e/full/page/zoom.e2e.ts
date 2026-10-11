// Zoom in the editor zooms the page, not Erga (client/zoom.ts): the keys and ctrl with the wheel scale the page;
// the controls at the top and the agent's panel keep their size; a click on the zoomed page puts the caret there.
import { expect, servers, test } from "../../fixtures";
import { F, openEditor } from "../../editor";

await servers.main();

test("⌘+, ⌘− and ctrl with the wheel zoom the page only; a click on the zoomed page types there; ⌘0 resets", async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "page", { agent: true });
  await ed.openAgent();
  const page = tab.page;
  /** The page's scale, and the h1's box in the tab. */
  const zoomed = () => ed.frame<{ scale: number; width: number; height: number }>(`(() => {
    const f = document.getElementById("page"), b = f.getBoundingClientRect(), scale = b.width / f.offsetWidth;
    const h = ${F}.querySelector("h1").getBoundingClientRect();
    return { scale, width: h.width * scale, height: h.height * scale };
  })()`);
  /** The sizes of Erga's own parts. */
  const chrome = () => ed.eval<{ header: number; font: number; agent: number; agentFont: number; dpr: number }>(`(() => {
    const h = document.querySelector("header.chrome-top"), a = document.getElementById("agent");
    return { header: h.getBoundingClientRect().height, font: parseFloat(getComputedStyle(h).fontSize), agent: a.getBoundingClientRect().width,
      agentFont: parseFloat(getComputedStyle(document.getElementById("agent-input")).fontSize), dpr: devicePixelRatio };
  })()`);
  /** A point in the tab, `at` along an element's width, on the page as it's drawn (scaled). */
  const pointOn = async (selector: string, at = 0.5) => {
    const f = await ed.frameAt();
    const r = await ed.frame<{ x: number; y: number }>(`(() => {
      const fr = document.getElementById("page"), b = fr.getBoundingClientRect(), k = b.width / fr.offsetWidth;
      const r = ${F}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: b.left + (r.left + r.width * ${at}) * k, y: b.top + (r.top + r.height / 2) * k };
    })()`);
    return { x: f.x + r.x, y: f.y + r.y };
  };
  const clickEnd = async (selector: string) => { const r = await pointOn(selector, 0.98); await ed.click(r.x, r.y); };
  const before = await zoomed(), shell = await chrome();
  expect(before.scale).toBeCloseTo(1, 3);
  expect(shell.agent).toBeGreaterThan(100);

  // The keys, from the agent's box (the shell) and from the page (the frame forwards them).
  await ed.press("ControlOrMeta+Equal");
  await expect.poll(async () => (await zoomed()).scale).toBeCloseTo(1.1, 2);
  await clickEnd("h1");
  await ed.press("ControlOrMeta+Equal");
  await expect.poll(async () => (await zoomed()).scale).toBeCloseTo(1.25, 2);
  expect((await ed.toast()).text).toBe("Zoom 125%");
  const big = await zoomed();
  expect(big.height).toBeGreaterThan(before.height * 1.2);
  expect(await chrome()).toEqual(shell);

  // A click on the zoomed page lands where it's aimed: at the end of the h1, typing goes there.
  await clickEnd("h1");
  await ed.type("!");
  await expect.poll(() => ed.textOf("h1")).toBe("Launch notes!");

  // Ctrl with the wheel, over the page and over the controls: a step out each time.
  const p = await pointOn("p.lede");
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await zoomed()).scale).toBeCloseTo(1.1, 2);
  const head = await ed.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector("header.chrome-top").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.mouse.move(head.x, head.y);
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await zoomed()).scale).toBeCloseTo(1, 2);
  await ed.press("ControlOrMeta+Minus");
  await expect.poll(async () => (await zoomed()).scale).toBeCloseTo(0.9, 2);
  expect(await chrome()).toEqual(shell);

  // ⌘0: back to 100%, kept for the document across a reload.
  await ed.press("ControlOrMeta+Equal");
  await ed.press("ControlOrMeta+Equal");
  await expect.poll(async () => (await zoomed()).scale).toBeCloseTo(1.1, 2);
  await page.reload();
  await ed.loaded();
  await expect.poll(async () => (await zoomed()).scale).toBeCloseTo(1.1, 2);
  await ed.press("ControlOrMeta+Digit0");
  await expect.poll(async () => (await zoomed()).scale).toBeCloseTo(1, 3);
  expect((await zoomed()).height).toBeCloseTo(before.height, 0);
});
