// The agent pane is the editor's own card: its light one, or on a dark page its dark one, never a colour of the page's; and the room around the page (the band above it,
// the room the agent opens beside it) is the page's own surface, with no seam: its colour, and its gradient too
//.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, settle, test, until } from "../../fixtures";
import { F, W, openEditor, type Editor } from "../../editor";
import { diff, pause, sample, screenshot, type RGB } from "../viewer/viewer";

await servers.main();

/** The page gets `css`, and its body's background shows `want` (its colour, or its image). */
async function restyle(ed: Editor, css: string, want: string) {
  const f = join(ed.dir, "index.html");
  writeFileSync(f, readFileSync(f, "utf8").replace(/<\/style>/, ` ${css}</style>`));
  await until(async () => (await ed.frame<string>(`(() => { const cs = getComputedStyle(${F}.body); return cs.backgroundImage + " " + cs.backgroundColor; })()`)).includes(want), 15_000, `the page shows ${want}`);
  await pause(400);
  await settle(ed.page);
}

/** The agent card's look. */
const card = (ed: Editor) => ed.eval<string>(`(() => { const cs = getComputedStyle(document.getElementById("agent").querySelector(".agent-card") ?? document.getElementById("agent")); return [cs.backgroundColor, cs.color, cs.borderColor].join(" / "); })()`);

/**
 * At heights down the window: the colour behind the agent card (the card hidden for the moment: its shadow is its own),
 * and the page's own colour at that height, just inside its edge; and the band above the page against its top edge.
 */
async function seams(ed: Editor) {
  const g = await ed.eval<{ card: number; frame: number; top: number; bottom: number; scale: number }>(`(() => {
    const a = document.getElementById("agent").getBoundingClientRect(), f = document.getElementById("frame").getBoundingClientRect();
    return { card: (a.left + a.right) / 2, frame: f.left, top: f.top, bottom: f.bottom, scale: devicePixelRatio };
  })()`);
  expect(g.frame - g.card, "the room the card is in, beside the page").toBeGreaterThanOrEqual(100);
  const s = g.scale, inside = g.frame + 6;
  const ys = [0.2, 0.5, 0.8].map((k) => g.top + (g.bottom - g.top) * k);
  const points: [number, number][] = ys.flatMap((y) => [[g.card * s, y * s], [inside * s, y * s]] as [number, number][]);
  points.push([inside * s, (g.top - 4) * s], [inside * s, (g.top + 4) * s]);
  await ed.eval(`document.getElementById("agent").style.visibility = "hidden"`);
  await settle(ed.page);
  const [px] = await sample(ed.page, [await screenshot(ed.page)], points);
  await ed.eval(`document.getElementById("agent").style.visibility = ""`);
  const pairs: { what: string; room: RGB; page: RGB }[] = ys.map((y, i) => ({ what: `behind the card at ${Math.round(y)}px`, room: px[2 * i], page: px[2 * i + 1] }));
  pairs.push({ what: "the band above the page", room: px[6], page: px[7] });
  return pairs;
}

async function seamless(ed: Editor, what: string, tolerance: number) {
  for (const p of await seams(ed)) expect(diff(p.room, p.page), `${what}: ${p.what}, the room (${p.room}) is the page's colour (${p.page})`).toBeLessThanOrEqual(tolerance);
}

test("the agent card is the editor's light card on a white page and its dark card on any dark one; the room around the page is the page's colour, or its gradient, at every height", async ({ tab }) => {
  await tab.page.setViewportSize({ width: 1300, height: 860 });
  const ed = await openEditor(tab, await servers.main(), "long");
  await ed.openAgent();
  await pause(700);
  const white = await card(ed);
  await seamless(ed, "a white page", 6);

  await restyle(ed, "body { background: rgb(20, 33, 61); color: #e8e8f0; }", "rgb(20, 33, 61)");
  expect(await ed.eval<boolean>(`document.documentElement.classList.contains("page-dark")`), "the header's text is light on it").toBe(true);
  const dark = await card(ed);
  expect(dark, "the agent card on a dark page is the dark card").not.toBe(white);
  expect(await ed.eval<number>(`(() => { const c = getComputedStyle(document.getElementById("agent").querySelector(".agent-card") ?? document.getElementById("agent")).backgroundColor.match(/[\\d.]+/g).map(Number); return (c[0] + c[1] + c[2]) / 3; })()`), "the dark card is dark grey").toBeLessThan(50);
  await seamless(ed, "a dark page", 6);

  // Another dark page, of another colour: the same dark card, with none of the page's colour in it.
  await restyle(ed, "body { background: rgb(70, 14, 24); color: #f0e8e8; }", "rgb(70, 14, 24)");
  expect(await card(ed), "the agent card on a dark red page").toBe(dark);

  // A gradient down the whole page, as the agent made for "a blue to red background": the room carries it on at the
  // page's own place in it, at the top and scrolled down the page.
  await restyle(ed, "body { background: linear-gradient(rgb(42, 91, 215), rgb(215, 54, 42)); }", "linear-gradient");
  const tone = await ed.eval<boolean>(`document.documentElement.classList.contains("page-dark")`);
  expect(await card(ed), "the agent card on a gradient is one of the two cards").toBe(tone ? dark : white);
  await seamless(ed, "a gradient, at the top", 8);
  await ed.frame(`${W}.scrollTo(0, (${F}.documentElement.scrollHeight - ${W}.innerHeight) / 2)`);
  await pause(300);
  await settle(ed.page);
  await seamless(ed, "a gradient, scrolled half way", 8);
});
