// The first switch into editing, frame by frame (tests/switch.ts): a screencast of the switch, sampled on a grid. No
// frame shows a white block where the agent opens, none loses the document, and the document slides over rather
// than jumps. What it sees moves with the machine's load (frames drop when it's busy); the gate has the
// animation-frame check (switch.e2e.ts).
import { expect, servers, test } from "../fixtures";
import { BG, H, W, rects, switchToEditing, viewerReady } from "./switch";
import { pause, record, throttle } from "./viewer";

await servers.main();

for (const kind of ["light", "dark"] as const) {
  test(`${kind} page: no white block, no blank document, no jump in any frame of the first switch`, async ({ tab }) => {
    const page = tab.page;
    await viewerReady(page, await servers.main(), kind);
    const frames = await record(page, async () => { await pause(150); await switchToEditing(page); await pause(900); });
    await throttle(page, false);
    const results = await page.evaluate(async ({ frames, bg, W, H }) => Promise.all(frames.map(async (b64) => {
      const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
      const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      // The left side, where the agent opens (below the top controls, above the agent's button).
      let white = 0, n = 0;
      for (let y = 80; y < c.height - 80; y += 20) for (let x = 0; x < 420 * c.width / W; x += 20) {
        const i = (y * c.width + x) * 4;
        n++;
        if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) white++;
      }
      // The document's text, wherever it is: pixels well off the page's background, in the band its heading and paragraphs are in.
      let ink = 0, m = 0;
      for (let y = Math.round(60 * c.height / H); y < 360 * c.height / H; y += 2) for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        m++;
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 120) ink++;
      }
      return { white: white / n, ink: ink / m };
    })), { frames, bg: BG[kind], W, H });
    const inks = results.map((r) => r.ink);
    expect(Math.max(...results.map((r) => r.white)), "the most white on the left in any frame").toBeLessThan(0.02);
    expect(Math.min(...inks) / inks[0], "the least of the document's text in any frame, against the viewer's").toBeGreaterThan(0.5);
    // The slide moves the page ~400px over its 560ms, a few dozen px a frame (more when frames drop); the old jump was all of it at once.
    const log = await rects(page);
    let jump = 0;
    for (let i = 1; i < log.length; i++) jump = Math.max(jump, Math.abs(log[i][1] - log[i - 1][1]));
    expect(jump, "the biggest move of the document between animation frames").toBeLessThan(300);
  });
}
