// The chime's tests (src/page/chime.ts; tests/factory-chime.ts): a board of fixture tasks (fake.ts) in one or two
// tabs of the test's browser context, with AudioContext replaced by a stub that counts the notes it starts (a
// chime is two). The old file waited fixed times to see that nothing played; here the stub also records the
// points where the chime decides, so each check waits for a decision, not for time:
//
//   reads "mine"   chime.ts's isMine(): a task just came to need the admin (and markMine(), on the admin's own step)
//   reads "mute"   muted(), BURST_MS after the first of a burst: whether it plays (also the bell, when drawn)
//   claims         the Web Lock a tab that can play takes; `granted` says which tab got it (and played, at once)
//   seeded         the chime's first read of the board is in (before it, a change isn't one)

import type { BrowserContext } from "playwright-core";
import { expect, servers, until, type Page } from "../fixtures";
import { ago, fake, serve, type Fake, type FakeTask } from "./fake";

const STUB = `(() => {
  const w = window;
  w.__notes = 0; w.__reads = []; w.__claims = 0; w.__granted = 0; w.__seeded = 0;
  const param = (v) => ({ value: v, setValueAtTime() { return this; }, exponentialRampToValueAtTime() { return this; }, linearRampToValueAtTime() { return this; } });
  const node = () => ({ connect: (to) => to, disconnect() {} });
  // Suspended until resume() (which the page calls on a click), and each oscillator's start counted.
  w.AudioContext = class {
    constructor() { this.state = "suspended"; this.destination = node(); this.t0 = performance.now(); }
    get currentTime() { return (performance.now() - this.t0) / 1000; }
    resume() { this.state = "running"; return Promise.resolve(); }
    createGain() { return Object.assign(node(), { gain: param(1) }); }
    createOscillator() { return Object.assign(node(), { type: "sine", frequency: param(440), start() { w.__notes++; }, stop() {} }); }
  };
  const get = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) {
    if (k == "erga:chime") w.__reads.push("mute"); else if (k == "erga:chime:mine") w.__reads.push("mine");
    return get.call(this, k);
  };
  const request = navigator.locks.request.bind(navigator.locks);
  navigator.locks.request = (name, opts, cb) => {
    if (name != "erga:chime") return request(name, opts, cb);
    w.__claims++;
    return request(name, opts, (lock) => { if (lock) w.__granted++; return cb(lock); });
  };
  // The chime's own read of the board (credentials, and nothing else, in its init): counted once the chime has it.
  const f = w.fetch;
  w.fetch = function (input, init) {
    const p = f.call(this, input, init);
    if (String(input) == "/api/factory/tasks" && init && Object.keys(init).join() == "credentials") {
      return p.then((r) => { const json = r.json.bind(r); r.json = () => json().then((v) => { setTimeout(() => w.__seeded++); return v; }); return r; });
    }
    return p;
  };
})();`;

export interface ChimeTab { page: Page; notes(): Promise<number>; reads(): Promise<string[]>; claims(): Promise<{ tried: number; granted: number }>; click(): Promise<void> }

/** Nine tasks, the fourth ready to merge and the rest working; set() changes one, and every reply to /events after carries each task that changed (a page hears it on its next reconnect, every 250 ms; sent again, it is no change). */
export async function chimeBoard(context: BrowserContext, opts: Partial<Fake> = {}) {
  const list: FakeTask[] = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"].map((title, i) => ({
    id: i + 1, title, description: "The ask.", status: i == 3 ? "complete" : "working", branch: `task/${i + 1}-x`, base: "0123456789abcdef", log: [{ at: ago(3), message: "working" }],
    screenshots: [], updatedAt: ago(3), createdAt: ago(30), url: null, error: null, vm: "vm-" + (i + 1), startAfter: [], mergeAfter: [],
  }));
  const changed = new Set<number>();
  const byId = (id: number) => list.find((x) => x.id == id)!;
  const set = (id: number, fields: Partial<FakeTask>) => {
    Object.assign(byId(id), fields, { updatedAt: new Date().toISOString() });
    byId(id).log.push({ at: byId(id).updatedAt, message: String(fields.status) });
    changed.add(id);
  };
  const f = fake(list, { events: () => "retry: 250\n\n" + [...changed].map((id) => "data: " + JSON.stringify({ type: "task", task: byId(id) }) + "\n\n").join(""), ...opts });
  await context.addInitScript(STUB);
  await serve(context, f);
  const root = (await servers.main()).root;
  /** A tab with the board, its bell drawn and the chime's first read in. */
  const open = async (page: Page): Promise<ChimeTab> => {
    await page.setViewportSize({ width: 1300, height: 860 });
    await page.goto(`${root}/admin/factory`);
    await until(() => page.evaluate(`!!document.getElementById("chime-toggle") && document.querySelectorAll("#board .card").length > 0 && window.__seeded > 0`), 10_000, "the board, its bell, and the chime's first read");
    return {
      page,
      notes: () => page.evaluate("window.__notes") as Promise<number>,
      reads: () => page.evaluate("window.__reads") as Promise<string[]>,
      claims: () => page.evaluate("({ tried: window.__claims, granted: window.__granted })") as Promise<{ tried: number; granted: number }>,
      // A click on the Tasks heading's text: the page's first gesture, which lets it play.
      click: async () => { const box = (await page.locator(".pane-head h2").first().boundingBox())!; await page.mouse.click(box.x + 10, box.y + box.height / 2); },
    };
  };
  return { fake: f, set, byId, open };
}

/** Waits until the tab's reads after `from` end with `want` in order (other reads between), and gives them. */
export async function decided(t: ChimeTab, from: number, ...want: string[]) {
  let got: string[] = [];
  await expect.poll(async () => {
    got = (await t.reads()).slice(from);
    let i = 0;
    for (const r of got) if (r == want[i]) i++;
    return i == want.length;
  }, { message: `the chime's reads: ${want.join(", ")}` }).toBe(true);
  return got;
}

/** Hidden or visible, as the browser says it when the tab goes to the background or comes back. */
export const look = (p: Page, state: "hidden" | "visible") => p.evaluate(`Object.defineProperty(document, "visibilityState", { get: () => "${state}", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); true`);
