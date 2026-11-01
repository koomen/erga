// The agent pane is glass of the page's own colour, with the editor's dark text on it, or on a dark page its light text; and the
// room around the page (the band above it, the room the agent opens beside it) is the page's own surface, with no seam: its
// colour, and its gradient too.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, settle, test, until } from "../../helpers/fixtures";
import { F, W, openEditor, type Editor } from "../../helpers/editor";
import { diff, sample, screenshot, type RGB } from "../viewer/viewer";
import { sleep } from "../../../shared/time";

await servers.main();

/** The page gets `css`, and its body's background shows `want` (its colour, or its image). */
async function restyle(ed: Editor, css: string, want: string) {
  const f = join(ed.dir, "index.html");
  writeFileSync(f, readFileSync(f, "utf8").replace(/<\/style>/, ` ${css}</style>`));
  await until(async () => (await ed.frame<string>(`(() => { const cs = getComputedStyle(${F}.body); return cs.backgroundImage + " " + cs.backgroundColor; })()`)).includes(want), 15_000, `the page shows ${want}`);
  await sleep(400);
  await settle(ed.page);
}

/** The agent pane's look: its glass's colour, and its text's. */
const card = (ed: Editor) =>
  ed.eval<{ glass: string; text: string }>(
    `(() => ({ glass: getComputedStyle(document.querySelector(".agent-glass")).backgroundColor, text: getComputedStyle(document.querySelector(".agent-card")).color }))()`
  );

/**
 * At heights down the window: the colour behind the agent card (the card hidden for the moment: its shadow is its own),
 * and the page's own colour at that height, just inside its edge; and the band above the page against its top edge, in the
 * gap between the two bars (under a bar is its glass and its shadow).
 */
async function seams(ed: Editor) {
  const g = await ed.eval<{ card: number; frame: number; gap: number; top: number; bottom: number; scale: number }>(`(() => {
    const a = document.getElementById("agent").getBoundingClientRect(), f = document.getElementById("frame").getBoundingClientRect();
    const gap = (document.querySelector(".chrome-nav").getBoundingClientRect().right + document.querySelector(".chrome-top").getBoundingClientRect().left) / 2;
    return { card: (a.left + a.right) / 2, frame: f.left, gap, top: f.top, bottom: f.bottom, scale: devicePixelRatio };
  })()`);
  expect(g.frame - g.card, "the room the card is in, beside the page").toBeGreaterThanOrEqual(100);
  const s = g.scale, inside = g.frame + 6;
  const ys = [0.2, 0.5, 0.8].map((k) => g.top + (g.bottom - g.top) * k);
  const points: [number, number][] = ys.flatMap((y) => [[g.card * s, y * s], [inside * s, y * s]] as [number, number][]);
  points.push([g.gap * s, (g.top - 4) * s], [g.gap * s, (g.top + 4) * s]);
  await ed.eval(`document.getElementById("agent").style.opacity = "0"`);
  await settle(ed.page);
  const [px] = await sample(ed.page, [await screenshot(ed.page)], points);
  await ed.eval(`document.getElementById("agent").style.opacity = ""`);
  const pairs: { what: string; room: RGB; page: RGB }[] = ys.map((y, i) => ({ what: `behind the card at ${Math.round(y)}px`, room: px[2 * i], page: px[2 * i + 1] }));
  pairs.push({ what: "the band above the page", room: px[6], page: px[7] });
  return pairs;
}

async function seamless(ed: Editor, what: string, tolerance: number) {
  for (const p of await seams(ed)) expect(diff(p.room, p.page), `${what}: ${p.what}, the room (${p.room}) is the page's colour (${p.page})`).toBeLessThanOrEqual(tolerance);
}

test("the agent pane is glass of the page's colour, with dark text on a white page and light text on any dark one; the room around the page is the page's colour, or its gradient, at every height", async ({
  tab,
}) => {
  await tab.page.setViewportSize({ width: 1300, height: 860 });
  const ed = await openEditor(tab, await servers.main(), "long");
  await ed.openAgent();
  await sleep(700);
  const white = await card(ed);
  await seamless(ed, "a white page", 6);

  await restyle(ed, "body { background: rgb(20, 33, 61); color: #e8e8f0; }", "rgb(20, 33, 61)");
  expect(await ed.eval<boolean>(`document.documentElement.classList.contains("page-dark")`), "the header's text is light on it").toBe(true);
  const dark = await card(ed);
  expect(dark.glass, "the glass on a dark page is of its colour").not.toBe(white.glass);
  expect(dark.text, "the text on a dark page is light").not.toBe(white.text);
  await seamless(ed, "a dark page", 6);

  // Another dark page, of another colour: the glass takes it, the text is the same light text.
  await restyle(ed, "body { background: rgb(70, 14, 24); color: #f0e8e8; }", "rgb(70, 14, 24)");
  const red = await card(ed);
  expect(red.glass, "the glass on a dark red page").not.toBe(dark.glass);
  expect(red.text, "the text on a dark red page").toBe(dark.text);

  // A gradient down the whole page, as the agent made for "a blue to red background": the room carries it on at the
  // page's own place in it, at the top and scrolled down the page.
  await restyle(ed, "body { background: linear-gradient(rgb(42, 91, 215), rgb(215, 54, 42)); }", "linear-gradient");
  const tone = await ed.eval<boolean>(`document.documentElement.classList.contains("page-dark")`);
  expect((await card(ed)).text, "the text on a gradient is one of the two").toBe((tone ? dark : white).text);
  await seamless(ed, "a gradient, at the top", 8);
  await ed.frame(`${W}.scrollTo(0, (${F}.documentElement.scrollHeight - ${W}.innerHeight) / 2)`);
  await sleep(300);
  await settle(ed.page);
  await seamless(ed, "a gradient, scrolled half way", 8);
});
