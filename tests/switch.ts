#!/usr/bin/env bun
// The first switch into editing, after a hard reload, on a slow network
// (front.ts, EDIT_BOOT): the editor's code takes a second or so to arrive,
// and meanwhile nothing may flash. With the agent left open last time, it
// opens as it does on any later switch, the page sliding over to make room
// on the same curve; until it's ready, the viewer stays as it was. Every
// frame is recorded (a screencast) and sampled: no white or blank block where
// the agent or the document should be, and the document never jumps. On a
// light page and a dark one.
//
//   bun tests/switch.ts            the checks
//   bun tests/switch.ts --frames   and the frames, as strips, in tests/cdp.ts's SHOTS
// covers: front.ts src/page/main.ts src/page/layout.ts

import { cpSync, mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, type Page, ROOT, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const keepFrames = process.argv.includes("--frames");
const host = await startHost(null);
const browser = await Browser.launch();
const scratch = mkdtempSync(join(tmpdir(), "erga-switch-"));
cpSync(join(ROOT, "tests/fixtures/backdrops"), scratch, { recursive: true });

/** Slows every request in the page and its frames to about a second for the editor's code. */
async function throttle(p: Page, on: boolean) {
  const conditions = on
    ? { offline: false, latency: 250, downloadThroughput: 900_000, uploadThroughput: 900_000 }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  const sessions = [undefined, ...((p as unknown as { frames: Set<string> }).frames)];
  for (const s of sessions) {
    await p.send("Network.enable", {}, 10_000, s).catch(() => {});
    await p.send("Network.emulateNetworkConditions", conditions, 10_000, s).catch(() => {});
  }
}

type Frame = { t: number; png: Buffer };

async function firstSwitch(name: string, dir: string, bg: [number, number, number]) {
  const address = new URL(await host.open(join(scratch, dir))).pathname;
  const ctx = await browser.context();
  const p = await browser.page(ctx);
  const W = 1200, H = 760;
  await p.open(`${host.root}${address}`, { width: W, height: H, dark: dir == "dark" });
  // The agent was left open last time; the editor's files aren't cached (a hard reload).
  await p.eval(`localStorage.setItem("erga:settings:v1", JSON.stringify({ agent: true })), true`);
  await p.send("Network.enable");
  await p.send("Network.clearBrowserCache");
  await p.send("Network.setCacheDisabled", { cacheDisabled: true });
  await p.send("Page.reload", { ignoreCache: true });
  await Bun.sleep(300);
  await until(async () => (await p.inPage<string>(`document.querySelector("h1")?.textContent ?? ""`)).some((t) => t.startsWith("A ")), 15_000, "the viewer shows the page");
  await p.settle();
  await throttle(p, true);

  // Every frame from here on.
  const frames: Frame[] = [];
  p.onEvent("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
    frames.push({ t: f.metadata.timestamp, png: Buffer.from(f.data, "base64") });
    p.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  // And where the document's frame is, on every animation frame.
  await p.eval(`window.__rects = []; (function log() { const r = document.getElementById("frame").getBoundingClientRect(); const e = document.getElementById("erga-editor"); window.__rects.push([performance.now(), r.left, e ? Number(getComputedStyle(e).opacity) : 0]); requestAnimationFrame(log); })(), true`);
  await p.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: W, maxHeight: H });
  await Bun.sleep(150);
  const pencil = await p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(".erga-edit-button").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const clicked = Date.now();
  await p.click(pencil.x, pencil.y);
  await until(() => p.eval<boolean>(`document.body.classList.contains("erga-editor-ready") && document.body.classList.contains("agent-open")`), 30_000, "the editor is ready, the agent open");
  const took = Date.now() - clicked;
  await Bun.sleep(900);
  await p.send("Page.stopScreencast");
  await throttle(p, false);
  console.log(`${name}: ready ${took}ms after the click, ${frames.length} frames`);
  expect(took > 600, `${name}: the throttle makes the editor's code take a while to arrive`, { took });

  // The frames: decoded in the page itself (a canvas), sampled on a grid over the agent's side and the document.
  const results = await p.eval<{ white: number; ink: number }[]>(`Promise.all(${JSON.stringify(frames.map((f) => f.png.toString("base64")))}.map(async (b64) => {
    const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let white = 0, n = 0;
    // The left side, where the agent opens (below the top controls, above the agent's button).
    for (let y = 80; y < c.height - 80; y += 20) for (let x = 0; x < 420 * c.width / ${W}; x += 20) {
      const i = (y * c.width + x) * 4;
      n++;
      if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) white++;
    }
    // The document's text, wherever it is: pixels well off the page's background, in the band its heading and paragraphs are in.
    let ink = 0, m = 0;
    const [r, gr, b] = ${JSON.stringify(bg)};
    for (let y = Math.round(60 * c.height / ${H}); y < 360 * c.height / ${H}; y += 2) for (let x = 0; x < c.width; x += 2) {
      const i = (y * c.width + x) * 4;
      m++;
      if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - gr) + Math.abs(d[i + 2] - b) > 120) ink++;
    }
    return { white: white / n, ink: ink / m };
  }))`);
  const worst = Math.max(...results.map((r) => r.white));
  const inks = results.map((r) => r.ink), fewestInk = Math.min(...inks) / inks[0];
  if (keepFrames) {
    // A strip: up to 12 frames from the click on, each labelled with its time, small, in rows of four.
    const t0 = clicked / 1000;
    const after = frames.filter((f) => f.t >= t0 - 0.05);
    const pick = after.length <= 12 ? after : Array.from({ length: 12 }, (_, i) => after[Math.round((i * (after.length - 1)) / 11)]);
    const strip = await p.eval<string>(`(async () => {
      const shots = ${JSON.stringify(pick.map((f) => ({ b64: f.png.toString("base64"), ms: Math.round((f.t - t0) * 1000) })))};
      const w = 300, h = Math.round(w * ${H / W}), gap = 6, cols = 4, rows = Math.ceil(shots.length / cols);
      const c = document.createElement("canvas"); c.width = cols * (w + gap) + gap; c.height = rows * (h + gap + 18) + gap;
      const g = c.getContext("2d"); g.fillStyle = "#888"; g.fillRect(0, 0, c.width, c.height);
      for (const [i, s] of shots.entries()) {
        const img = new Image(); img.src = "data:image/png;base64," + s.b64; await img.decode();
        const x = gap + (i % cols) * (w + gap), y = gap + Math.floor(i / cols) * (h + gap + 18);
        g.drawImage(img, x, y + 18, w, h);
        g.fillStyle = "#fff"; g.font = "12px sans-serif"; g.fillText((s.ms >= 0 ? "+" : "") + s.ms + " ms", x + 2, y + 13);
      }
      return c.toDataURL("image/png").split(",")[1];
    })()`);
    mkdirSync(SHOTS, { recursive: true });
    const file = join(SHOTS, `switch-${name}.png`);
    await Bun.write(file, Buffer.from(strip, "base64"));
    console.log(`frames: ${file}`);
  }
  // The document never jumps: frame to frame, it moves only as far as the slide does.
  const rects = await p.eval<[number, number, number][]>("window.__rects");
  let jump = 0;
  for (let i = 1; i < rects.length; i++) jump = Math.max(jump, Math.abs(rects[i][1] - rects[i - 1][1]));
  // What caused the flash: the page moving over for the agent before the agent (the editor's controls) could be seen.
  const early = rects.filter(([, left, shown]) => left > 40 && shown < 1).length;
  expect(early == 0, `${name}: the page makes room for the agent only once the agent can be seen`, { early });
  console.log(`${name}: worst white share on the left ${(worst * 100).toFixed(0)}%, least text ${(fewestInk * 100).toFixed(0)}% of the viewer's, biggest jump ${jump.toFixed(0)}px`);
  expect(worst < 0.02, `${name}: no frame shows a white block where the agent opens`, { whites: results.map((r) => r.white.toFixed(2)).join(" ") });
  expect(fewestInk > 0.5, `${name}: no frame loses the document (blank where it should be)`, { inks: inks.map((i) => i.toFixed(4)).join(" ") });
  // The slide moves the page ~400px over its 560ms, a few dozen px a frame (more when frames are dropped, as on a busy machine); the old jump was all of it at once.
  expect(jump < 300, `${name}: the document slides over, it doesn't jump`, { jump });
  const opened = await p.eval<boolean>(`(() => { const r = document.querySelector(".agent-card").getBoundingClientRect(); return document.body.classList.contains("agent-open") && r.width > 300 && getComputedStyle(document.getElementById("erga-editor")).opacity == "1"; })()`);
  expect(opened, `${name}: and the agent ends up open, the editor shown`);
  console.log(`ok   ${name}: the first switch into editing, on a slow network: no white, no blank, no jump`);
}

try {
  await firstSwitch("light", "light", [0xe9, 0xdc, 0xc0]);
  await firstSwitch("dark", "dark", [0x16, 0x18, 0x1d]);
} finally {
  browser.close();
  await host.dispose();
}
