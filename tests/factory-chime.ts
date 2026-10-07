#!/usr/bin/env bun
// The chime on the admin pages (src/page/chime.ts): a board of fixture tasks on /admin/factory (the page's
// /api/factory requests answered over DevTools, as tests/factory-cards.ts does, so no VM runs), in headless
// Chrome, with AudioContext replaced by a stub that counts the notes it starts (a chime is two).
//
//   bun tests/factory-chime.ts
//
// - Nothing plays on the board's first read, nor before a click on the page (the browser's rule for sound).
// - A task that becomes ready to merge plays one chime.
// - Two tasks that fail at the same moment play one chime.
// - The admin's own step plays none: Merge on a card, and the merge failing at once (back to ready to merge).
// - With two admin tabs open, one chime plays, not two.
// - The bell in the Tasks heading mutes it, in every tab of the browser; turning it on again plays the chime once.
// - While the tab is hidden, its title counts the tasks that need the admin ("(2) ..."); the count goes when
//   the admin looks.
// covers: src/page/chime.ts src/page/factory-agent.ts

import { Browser, type Page } from "./cdp";
import { startHost } from "./host";
import { expect } from "./suite/harness";

const ok = (what: string) => console.log(`ok   ${what}`);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
type Task = Record<string, any> & { id: number; status: string };
let n = 0;
const t = (title: string, status: string): Task => {
  const id = ++n;
  return { id, title, description: "The ask.", status, branch: `task/${id}-x`, base: "0123456789abcdef", log: [{ at: ago(3), message: status }], screenshots: [],
    updatedAt: ago(3), createdAt: ago(30), url: null, error: null, vm: "vm-" + id, startAfter: [], mergeAfter: [] };
};
const tasks = [t("One", "working"), t("Two", "working"), t("Three", "working"), t("Four", "complete"), t("Five", "working"), t("Six", "working"), t("Seven", "working"), t("Eight", "working"), t("Nine", "working")];
const info = { enabled: true, vms: { runner: "sim" }, claude: { signedIn: true, canStore: true } };
const byId = (id: number) => tasks.find((x) => x.id == id)!;
// Every reply to /events carries each task that changed, as it is now: a page hears it on its next reconnect (every
// 250 ms), whichever of its two streams (the board's, the agent panel's) that is. Sent again, a task is no change.
const changed = new Set<number>();
const set = (id: number, fields: Partial<Task>) => {
  Object.assign(byId(id), fields, { updatedAt: new Date().toISOString() });
  byId(id).log.push({ at: byId(id).updatedAt, message: String(fields.status) });
  changed.add(id);
};
const events = () => "retry: 250\n\n" + [...changed].map((id) => "data: " + JSON.stringify({ type: "task", task: byId(id) }) + "\n\n").join("");

// AudioContext, as a page sees it: suspended until resume() (which the page calls on a click), and each oscillator's start counted.
const STUB = `(() => {
  window.__notes = 0;
  const param = (v) => ({ value: v, setValueAtTime() { return this; }, exponentialRampToValueAtTime() { return this; }, linearRampToValueAtTime() { return this; } });
  const node = () => ({ connect: (to) => to, disconnect() {} });
  window.AudioContext = class {
    constructor() { this.state = "suspended"; this.destination = node(); this.t0 = performance.now(); }
    get currentTime() { return (performance.now() - this.t0) / 1000; }
    resume() { this.state = "running"; return Promise.resolve(); }
    createGain() { return Object.assign(node(), { gain: param(1) }); }
    createOscillator() { return Object.assign(node(), { type: "sine", frequency: param(440), start() { window.__notes++; }, stop() {} }); }
  };
})();`;

const host = await startHost(null);
const browser = await Browser.launch();
try {
  const ctx = await browser.context();
  const tab = async () => {
    const p = await browser.page(ctx);
    await p.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
    await p.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/factory*" }] });
    p.onEvent("Fetch.requestPaused", ({ requestId, request }) => {
      const path = new URL(request.url).pathname.replace(/^\/api\/factory/, "");
      const reply = (body: string, type = "application/json") => p.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(body).toString("base64") }).catch(() => {});
      const step = /^\/tasks\/(\d+)\/(merge|restart|discard)$/.exec(path);
      if (path == "/events") reply(events(), "text/event-stream");
      else if (path == "/tasks") reply(JSON.stringify(tasks));
      else if (path == "") reply(JSON.stringify(info));
      else if (step && request.method == "POST") {
        // Merge: merging, and then, at once, back to ready to merge with an error (the merge failed).
        const id = Number(step[1]);
        set(id, { status: "merging" });
        setTimeout(() => set(id, { status: "complete", error: "The merge failed: a step timed out." }), 400);
        reply(JSON.stringify(byId(id)));
      } else p.send("Fetch.continueRequest", { requestId }).catch(() => {});
    });
    await p.open(`${host.root}/admin/factory`, { width: 1300, height: 860, clear: false });
    for (let i = 0; i < 100 && !(await p.eval<boolean>(`!!document.getElementById("chime-toggle") && document.querySelectorAll("#board .card").length > 0`)); i++) await Bun.sleep(50);
    return p;
  };
  const notes = (p: Page) => p.eval<number>("window.__notes");
  const total = async (ps: Page[]) => (await Promise.all(ps.map(notes))).reduce((a, b) => a + b, 0);
  /** Waits until the pages have started `want` notes in all (or 3 s), then a little longer, so a second chime would show. */
  const expectNotes = async (ps: Page[], want: number, what: string) => {
    for (let i = 0; i < 60 && (await total(ps)) < want; i++) await Bun.sleep(50);
    await Bun.sleep(900);
    const got = await total(ps);
    expect(got == want, what, { notes: got, want });
    ok(what);
  };
  // A click on the Tasks heading's text: the page's first gesture, which lets it play.
  const click = async (p: Page) => {
    const r = await p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(".pane-head h2").getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()`);
    await p.click(r.x, r.y);
  };
  const quiet = () => Bun.sleep(2700); // the last chime's hold (chime.ts, HOLD_MS) over

  const a = await tab();
  await Bun.sleep(600);
  await expectNotes([a], 0, "nothing plays on the board's first read");
  set(1, { status: "complete", summary: "Done." });
  await expectNotes([a], 0, "nothing plays before a click on the page");
  await click(a);
  await quiet();

  set(2, { status: "complete", summary: "Done." });
  await expectNotes([a], 2, "a task that becomes ready to merge plays one chime");

  await quiet();
  set(3, { status: "failed", error: "The build failed." });
  set(5, { status: "failed", error: "The build failed." });
  await expectNotes([a], 4, "two tasks that fail together play one chime");

  await quiet();
  await a.eval(`document.querySelector('#board [data-act="merge"][data-id="4"]').click()`);
  for (let i = 0; i < 60 && !byId(4).error; i++) await Bun.sleep(50);
  await Bun.sleep(600); // the event on its way, and the burst's wait (chime.ts, BURST_MS)
  await expectNotes([a], 4, "the admin's own Merge, failed at once, plays none");

  const b = await tab();
  await click(b);
  await Bun.sleep(600);
  await quiet();
  const before = await total([a, b]);
  set(6, { status: "complete", summary: "Done." });
  await expectNotes([a, b], before + 2, "two admin tabs play one chime");

  await quiet();
  await a.eval(`document.getElementById("chime-toggle").click()`);
  expect(await a.eval(`document.getElementById("chime-toggle").getAttribute("aria-pressed")`) == "false", "the bell says the chime is muted");
  for (let i = 0; i < 40 && (await b.eval(`document.getElementById("chime-toggle").getAttribute("aria-pressed")`)) != "false"; i++) await Bun.sleep(50);
  expect(await b.eval(`document.getElementById("chime-toggle").getAttribute("aria-pressed")`) == "false", "the other tab's bell says muted too");
  set(7, { status: "complete", summary: "Done." });
  await expectNotes([a, b], before + 2, "muted, nothing plays in either tab");
  await a.eval(`document.getElementById("chime-toggle").click()`);
  await expectNotes([a, b], before + 4, "turned on again, the bell plays the chime once");

  // Hidden: as the browser says it when the tab is in the background.
  const look = (p: Page, state: "hidden" | "visible") => p.eval(`Object.defineProperty(document, "visibilityState", { get: () => "${state}", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); true`);
  const title0 = await a.eval<string>("document.title");
  await look(a, "hidden");
  set(8, { status: "complete", summary: "Done." });
  set(9, { status: "failed", error: "Tests failed." });
  for (let i = 0; i < 60 && !(await a.eval<string>("document.title")).startsWith("(2) "); i++) await Bun.sleep(50);
  const hiddenTitle = await a.eval<string>("document.title");
  expect(hiddenTitle == "(2) " + title0, "the hidden tab's title counts the two tasks", { hiddenTitle, title0 });
  ok(`the hidden tab's title counts the two tasks ("${hiddenTitle}")`);
  await look(a, "visible");
  expect(await a.eval<string>("document.title") == title0, "the count goes when the admin looks");
  ok("the count goes when the admin looks");

  for (const p of [a, b]) expect(!p.errors.length, "no errors on the page", p.errors);
} finally {
  await browser.close();
  await host.stop();
}
