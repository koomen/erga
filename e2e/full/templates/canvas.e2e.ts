// The Canvas presentation template: frames on one large canvas, each a step; going to the
// next step glides to the next frame in one smooth move, which ends with it in the middle; viewing and editing.
import type { Page } from "playwright-core";
import { expect, servers, test } from "../../helpers/fixtures";
import { editor, F } from "../../helpers/editor";
import { templateById } from "../../../server/pages/index.ts";
import { bar, clickOn, editorReady, inPage, newDoc, openTab } from "./templates";

await servers.main();

const LABELS = ["One big canvas", "Glide to the next", "Make it yours", "Add a frame"];

/** The camera's zoom, and where the current frame's middle is against the window's (0, 0 when centred). */
const CAMERA = `(() => {
  const m = new DOMMatrix(getComputedStyle(document.querySelector(".canvas")).transform), f = document.querySelector(".frame.current").getBoundingClientRect();
  return { s: m.a, dx: Math.round(f.left + f.width / 2 - innerWidth / 2), dy: Math.round(f.top + f.height / 2 - innerHeight / 2), at: ergaSteps.current() };
})()`;
const camera = (page: Page) => inPage<{ s: number; dx: number; dy: number; at: number } | null>(page, `window.ergaSteps && document.querySelector(".canvas") ? ${CAMERA} : null`);

/**
 * Goes forward one step from `from`, the page sampling the zoom on every frame on the way (not the test, every
 * 40 ms, which a loaded machine stretches): it may pull back a little, never to the whole canvas, and must end on the next frame, centred.
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
  expect(least).toBeGreaterThan(start.s * 0.5);
  expect(least).toBeGreaterThan(end.s * 0.5);
}

test("/new?template=canvas makes a document, which the New menu calls Canvas", async () => {
  expect(templateById("canvas")?.name).toBe("Canvas");
  expect((await newDoc(await servers.main(), "canvas")).status).toBe(302);
});

test("viewing: 1 / 4 on frame 1, centred; the list has four labelled steps, each with a picture; forward glides to the next frame, centred, twice", async ({
  tab,
}) => {
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
  await openTab(tab, `${made.address}?edit`, { width: 1100, height: 720 });
  await editorReady(page);
  await expect.poll(async () => (await bar(page)).shown && (await camera(page))?.at == 0).toBe(true);
  await flies(page, 0);
  expect(await inPage<boolean>(page, `(() => { const h = document.querySelector(".frame.current h2"); return h ? h.isContentEditable : null; })()`)).toBe(true);
});

test("editing: the camera zooms past the editor's limits, by ctrl and the wheel and by the zoom keys, and a drag pans; a press on the text places the caret and doesn't pan", async ({ tab }) => {
  const made = await newDoc(await servers.main(), "canvas");
  const page = tab.page;
  await openTab(tab, `${made.address}?edit`, { width: 1100, height: 720 });
  await editorReady(page);
  const ed = editor(page, { address: made.address, dir: "", file: "" });
  await ed.loaded();
  await expect.poll(async () => { const c = await camera(page); return !!c && c.at == 0 && Math.abs(c.dx) <= 2 && Math.abs(c.dy) <= 2; }).toBe(true);
  const fit = (await camera(page))!.s;
  const zoom = async () => (await camera(page))!.s;
  /** The editor's own zoom: the page's frame against its size. It stays at 100%, the header and the agent as they were. */
  const frameScale = () => ed.frame<number>(`(() => { const f = ({ offsetWidth: innerWidth, offsetHeight: innerHeight, getBoundingClientRect() { const k = window.ergaFrame?.zoom ?? 1; return { left: 0, top: 0, x: 0, y: 0, width: innerWidth * k, height: innerHeight * k, right: innerWidth * k, bottom: innerHeight * k }; } }); return f.getBoundingClientRect().width / f.offsetWidth; })()`);
  const middle = await ed.frame<{ x: number; y: number }>(`(() => { const r = ({ offsetWidth: innerWidth, offsetHeight: innerHeight, getBoundingClientRect() { const k = window.ergaFrame?.zoom ?? 1; return { left: 0, top: 0, x: 0, y: 0, width: innerWidth * k, height: innerHeight * k, right: innerWidth * k, bottom: innerHeight * k }; } }).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const at = await ed.frameAt(), mx = at.x + middle.x, my = at.y + middle.y;

  // Ctrl and the wheel (a pinch on a trackpad): out to below 10%, then in to above 400%.
  await page.mouse.move(mx, my);
  await page.keyboard.down("Control");
  for (let i = 0; i < 40 && (await zoom()) > 0.08; i++) await page.mouse.wheel(0, 100);
  expect(await zoom()).toBeLessThan(0.08);
  for (let i = 0; i < 60 && (await zoom()) < 5; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  expect(await zoom()).toBeGreaterThan(5);
  expect(await frameScale()).toBeCloseTo(1, 3);

  // The zoom keys, with the caret in the page: ⌘0 goes back to the frame, ⌘− and ⌘+ step past 50% and 300% of it.
  await ed.click(...Object.values(await ed.charAt(".frame.current p", 4)) as [number, number]);
  await ed.press("ControlOrMeta+0");
  await expect.poll(async () => { const c = await camera(page); return !!c && Math.abs(c.s - fit) < 0.01 && Math.abs(c.dx) <= 2 && Math.abs(c.dy) <= 2; }).toBe(true);
  for (let i = 0; i < 8; i++) await ed.press("ControlOrMeta+Minus");
  await expect.poll(zoom).toBeLessThan(fit * 0.2);
  await ed.press("ControlOrMeta+0");
  await expect.poll(async () => Math.abs((await zoom()) - fit)).toBeLessThan(0.01);
  for (let i = 0; i < 8; i++) await ed.press("ControlOrMeta+Equal");
  await expect.poll(zoom).toBeGreaterThan(fit * 5);
  expect(await frameScale()).toBeCloseTo(1, 3);

  // A drag from the space between the frames moves the canvas with the pointer.
  await ed.press("ControlOrMeta+0");
  await expect.poll(async () => Math.abs((await zoom()) - fit)).toBeLessThan(0.01);
  for (let i = 0; i < 4; i++) await ed.press("ControlOrMeta+Minus");
  await expect.poll(zoom).toBeLessThan(fit * 0.5);
  /** A point of the canvas, in the tab: the canvas's own (60, 60), a corner no frame covers. */
  const corner = async () => {
    const p = await ed.frame<{ x: number; y: number; free: boolean }>(`(() => {
      const r = ({ offsetWidth: innerWidth, offsetHeight: innerHeight, getBoundingClientRect() { const k = window.ergaFrame?.zoom ?? 1; return { left: 0, top: 0, x: 0, y: 0, width: innerWidth * k, height: innerHeight * k, right: innerWidth * k, bottom: innerHeight * k }; } }).getBoundingClientRect(), cv = ${F}.querySelector(".canvas"), c = cv.getBoundingClientRect(), k = c.width / cv.offsetWidth;
      const x = c.left + 60 * k, y = c.top + 60 * k;
      return { x: r.left + x, y: r.top + y, free: !${F}.elementFromPoint(x, y)?.closest(".frame") };
    })()`);
    const f = await ed.frameAt();
    return { x: f.x + p.x, y: f.y + p.y, free: p.free };
  };
  const from = await corner();
  expect(from.free).toBe(true);
  await ed.drag(from.x, from.y, from.x + 150, from.y + 90, 10);
  const to = await corner();
  expect(Math.abs(to.x - from.x - 150)).toBeLessThan(3);
  expect(Math.abs(to.y - from.y - 90)).toBeLessThan(3);

  // A press on the text and a drag: it selects the text; the canvas stays.
  const before = await corner();
  const h = await ed.charAt(".frame.current h2", 0);
  await ed.drag(h.x, h.y, h.x + 120, h.y, 8);
  const after = await corner();
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1);
  expect(await ed.frame<string>(`${F}.getSelection().toString()`)).not.toBe("");
});
