// The Canvas presentation template: frames on one large canvas, each a step; going to the
// next step zooms out to the whole canvas, then in on the next frame, which ends in the middle; viewing and editing.
import type { Page } from "playwright-core";
import { expect, servers, test } from "../../fixtures";
import { templateById } from "../../../server/pages/index.ts";
import { bar, clickOn, editorReady, inPage, newDoc, openTab } from "./templates";

await servers.main();

const LABELS = ["One big canvas", "Zoom out, zoom in", "Make it yours", "Add a frame"];

/** The camera's zoom, and where the current frame's middle is against the window's (0, 0 when centred). */
const CAMERA = `(() => {
  const m = new DOMMatrix(getComputedStyle(document.querySelector(".canvas")).transform), f = document.querySelector(".frame.current").getBoundingClientRect();
  return { s: m.a, dx: Math.round(f.left + f.width / 2 - innerWidth / 2), dy: Math.round(f.top + f.height / 2 - innerHeight / 2), at: ergaSteps.current() };
})()`;
const camera = (page: Page) => inPage<{ s: number; dx: number; dy: number; at: number } | null>(page, `window.ergaSteps && document.querySelector(".canvas") ? ${CAMERA} : null`);

/**
 * Goes forward one step from `from`, the page sampling the zoom on every frame on the way (not the test, every
 * 40 ms, which a loaded machine stretches): it must drop below both ends, and end on the next frame, centred.
 */
async function flies(page: Page, from: number) {
  const start = (await camera(page))!;
  const sampled = inPage<{ least: number; end: { s: number; dx: number; dy: number; at: number } }>(page, `new Promise((done) => {
    const cam = () => ${CAMERA};
    let least = Infinity, end = cam();
    const tick = () => {
      end = cam(); least = Math.min(least, end.s);
      if (end.at == ${from + 1} && Math.abs(end.dx) <= 2 && Math.abs(end.dy) <= 2) done({ least, end });
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })`);
  await clickOn(page, ".erga-steps-next");
  const { least, end } = await sampled;
  expect((await bar(page)).at).toBe(`${from + 2} / 4`);
  expect(least).toBeLessThan(start.s * 0.6);
  expect(least).toBeLessThan(end.s * 0.6);
}

test("/new?template=canvas makes a document, in the Presentation group", async () => {
  expect(templateById("canvas")?.group).toBe("Presentation");
  expect((await newDoc(await servers.main(), "canvas")).status).toBe(302);
});

test("viewing: 1 / 4 on frame 1, centred; the list has four labelled steps, each with a picture; forward zooms out, then in on the next frame, centred, twice", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "canvas");
  const page = tab.page;
  await openTab(tab, made.address, { width: 1100, height: 720 });
  await expect.poll(async () => { const b = await bar(page); return b.shown && b.at; }).toBe("1 / 4");
  await expect.poll(async () => { const c = await camera(page); return !!c && c.at == 0 && Math.abs(c.dx) <= 2 && Math.abs(c.dy) <= 2; }).toBe(true);
  await clickOn(page, ".erga-steps-toggle");
  await expect.poll(async () => { const b = await bar(page); return b.items.length == 4 && b.items.every((i) => i.img.startsWith("blob:")); }).toBe(true);
  expect((await bar(page)).items.map((i) => i.label)).toEqual(LABELS);
  await clickOn(page, ".erga-steps-toggle");
  await flies(page, 0);
  await flies(page, 1);
});

test("editing: the controls show, forward flies the same way, and the frames' text is editable", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "canvas");
  const page = tab.page;
  await openTab(tab, `${made.address}#edit`, { width: 1100, height: 720 });
  await editorReady(page);
  await expect.poll(async () => (await bar(page)).shown && (await camera(page))?.at == 0).toBe(true);
  await flies(page, 0);
  expect(await inPage<boolean>(page, `(() => { const h = document.querySelector(".frame.current h2"); return h ? h.isContentEditable : null; })()`)).toBe(true);
});
