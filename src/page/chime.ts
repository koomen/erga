// The chime: every admin page plays two soft notes when something needs the admin, so a task doesn't sit
// ready to merge for hours with nobody told. It runs in factory-agent.js (on every admin page, and kept across
// them by admin-nav.ts), on the events of the agent panel's own stream (/api/factory/events: the board's task
// changes, and this admin's agent), so it opens no connection of its own.
//
// What chimes (a change from one task event to the next, never the first read of the board):
// - a task becomes ready to merge (from working, from a merge that failed, or from "needs agent" when the
//   task's Claude Code gives up on the merge: back to ready, with the error);
// - a task fails;
// - a task becomes stalled (the server's beat sends the task when it stalls: worker/factory.ts, checkStalls);
// - the admin's agent ends a reply while the page is hidden, or ends it with a question.
// Not what the admin just did: a task this browser changed (a POST, PATCH or DELETE to its /api/factory/tasks/<id>,
// from any tab) in the last OWN_MS doesn't chime. The admin's own steps (Merge, Discard, Restart, new
// instructions, a new task) lead to no state above by themselves anyway.
//
// The sound is made with the Web Audio API (no file). A browser lets a page play only after a click or a key on
// it, so the AudioContext is made (or resumed) on the first one; until then, and if it stays blocked, nothing
// plays and nothing complains. With several admin tabs open, one plays: a tab that can play takes a Web Lock
// (navigator.locks, `ifAvailable`, a localStorage time where there are none) and holds it HOLD_MS, so the
// others' tries for the same event fail. A burst (several tasks at once) is one chime: a tab waits BURST_MS for
// more before it tries.
//
// A hidden tab counts what needs the admin in its title ("(2) Factory · Erga") until the admin looks at it.
// The bell in the board's heading (Tasks, factory/page.ts) mutes and unmutes it, for this
// browser (localStorage MUTE_KEY; on by default). A per-browser choice: the admin's agent has no tool for it.

type Task = { id: number; status: string; updatedAt?: string; stalled?: unknown };
type Message = { type?: string; task?: Task; ev?: { t?: string; delta?: string; busy?: boolean } };

const MUTE_KEY = "erga:chime", MINE_KEY = "erga:chime:mine", AT_KEY = "erga:chime:at";
const OWN_MS = 10_000, HOLD_MS = 2500, BURST_MS = 300, RESEED_MS = 5000;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } },
};
const muted = () => store.get(MUTE_KEY) == "off";
const hidden = () => document.visibilityState == "hidden";

// -- what the admin did themselves

const mineHere = new Map<number, number>();
function markMine(id: number) {
  const now = Date.now();
  mineHere.set(id, now);
  let all: Record<string, number> = {};
  try { all = JSON.parse(store.get(MINE_KEY) ?? "{}") ?? {}; } catch { /* unreadable: start again */ }
  for (const k of Object.keys(all)) if (now - all[k] > OWN_MS) delete all[k];
  all[id] = now;
  store.set(MINE_KEY, JSON.stringify(all));
}
function isMine(id: number) {
  let at = mineHere.get(id) ?? 0;
  try { at = Math.max(at, Number(JSON.parse(store.get(MINE_KEY) ?? "{}")?.[id] ?? 0)); } catch { /* none */ }
  return Date.now() - at < OWN_MS;
}
// The board and the agent panel call fetch: a change to a task, from this page, is the admin's own.
const realFetch = window.fetch;
window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const m = url.origin == location.origin && method != "GET" && method != "HEAD" ? /^\/api\/factory\/tasks\/(\d+)/.exec(url.pathname) : null;
    if (m) markMine(Number(m[1]));
  } catch { /* not ours to judge */ }
  return realFetch.call(window, input, init);
} as typeof fetch;

// -- the sound

type Ctx = AudioContext;
let ctx: Ctx | null = null;
function unlock() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state != "running") ctx.resume().catch(() => {});
  } catch { ctx = null; }
}
addEventListener("pointerdown", unlock, true);
addEventListener("keydown", unlock, true);

/** Two soft sine notes, a fourth apart (A5, then D6), each a quick rise and a long fade: under a second. */
function play() {
  if (!ctx || ctx.state != "running") return;
  try {
    const t0 = ctx.currentTime + 0.02;
    for (const [i, freq] of [587.33 * 1.5, 587.33 * 2].entries()) {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + i * 0.15;
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.75);
    }
  } catch { /* the browser said no: silent */ }
}

/** Whether this tab plays: no other tab has played in the last HOLD_MS. */
function claim(): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks?.request) {
    return new Promise((done) => {
      locks.request("erga:chime", { ifAvailable: true }, async (lock) => {
        done(!!lock);
        if (lock) await new Promise((r) => setTimeout(r, HOLD_MS));
      }).catch(() => done(false));
    });
  }
  const at = Number(store.get(AT_KEY) ?? 0);
  if (Date.now() - at < HOLD_MS) return Promise.resolve(false);
  store.set(AT_KEY, String(Date.now()));
  return Promise.resolve(true);
}

let burst = 0;
function chime() {
  if (burst) return;
  burst = window.setTimeout(async () => {
    burst = 0;
    // A tab that can't play (muted, or no click yet) leaves it to one that can.
    if (muted() || !ctx || ctx.state != "running") return;
    if (await claim()) play();
  }, BURST_MS);
}

// -- the count in the title, while the tab is hidden

const unseen = new Set<string>();
const COUNT = /^\(\d+\) /;
function showCount() {
  const base = document.title.replace(COUNT, "");
  const title = unseen.size && hidden() ? `(${unseen.size}) ${base}` : base;
  if (document.title != title) document.title = title;
}
document.addEventListener("visibilitychange", () => { if (!hidden()) unseen.clear(); showCount(); });
// Another admin page's title (admin-nav.ts) keeps the count.
addEventListener("erga:admin-view", () => { showCount(); mountBell(); });

function attention(what: string) {
  if (hidden()) { unseen.add(what); showCount(); }
  chime();
}

// -- the tasks, as last heard

const known = new Map<number, Task>();
let seeded = false, seededAt = 0;
const needs = (t: Task) => t.status == "complete" || t.status == "failed" || !!t.stalled;

/** A task as it is now: a chime if it has just come to need the admin. */
function task(t: Task) {
  const was = known.get(t.id);
  if (was?.updatedAt && t.updatedAt && t.updatedAt < was.updatedAt) return; // older than what's known (a read that crossed an event)
  known.set(t.id, t);
  if (!needs(t) && unseen.delete("task:" + t.id)) showCount();
  if (!seeded || !was) return;
  const now = (t.status == "complete" && was.status != "complete") || (t.status == "failed" && was.status != "failed") || (!!t.stalled && !was.stalled && !needs(was));
  if (now && !isMine(t.id)) attention("task:" + t.id);
}

/** The stream (re)opened: the tasks read again, so a change missed while it was closed still chimes; the first read never does. */
export function opened() {
  if (seeded && Date.now() - seededAt < RESEED_MS) return;
  seededAt = Date.now();
  realFetch("/api/factory/tasks", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((list: Task[] | null) => {
    if (!Array.isArray(list)) return;
    for (const t of list) task(t);
    seeded = true;
  }).catch(() => {});
}

// -- the admin's agent

let turn = { on: false, text: "" };
function agent(ev: NonNullable<Message["ev"]>) {
  if (ev.t == "user") turn = { on: true, text: "" };
  else if (ev.t == "busy" && ev.busy) turn.on = true;
  else if (ev.t == "text") turn.text = (turn.text + (ev.delta ?? "")).slice(-400);
  else if (ev.t == "reset") turn = { on: false, text: "" };
  else if (ev.t == "busy" && !ev.busy && turn.on) {
    const asks = /\?[\s"'”’)*_`]*$/.test(turn.text);
    turn = { on: false, text: "" };
    if (hidden() || asks) attention("agent");
  }
}

/** An event from /api/factory/events. */
export function heard(m: Message) {
  if (m.type == "task" && m.task) task(m.task);
  else if (m.type == "agent" && m.ev) agent(m.ev);
}

// -- the bell

const BELL = `<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>`;
const SLASH = `<path d="M4 4l16 16"/>`;
function paintBell(b: HTMLButtonElement) {
  const on = !muted();
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Chime when a task needs you: on (click to mute)" : "Chime when a task needs you: muted (click to turn on)";
  b.setAttribute("aria-label", on ? "Mute the chime" : "Turn on the chime");
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${BELL}${on ? "" : SLASH}</svg>`;
}
function mountBell() {
  // In the Tasks heading itself: the board writes its pills (#pills, beside it) again as it learns more.
  const head = document.getElementById("pills")?.parentElement?.querySelector("h2");
  if (!head || document.getElementById("chime-toggle")) return;
  if (!document.getElementById("chime-style")) {
    const s = document.createElement("style");
    s.id = "chime-style";
    s.textContent = `#chime-toggle.chime-toggle { display: inline-flex; vertical-align: -5px; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; margin: 0 0 0 6px; border: 0; border-radius: 6px; background: none; box-shadow: none; color: var(--muted, currentColor); cursor: pointer; }
#chime-toggle.chime-toggle:hover { color: var(--ink, currentColor); background: color-mix(in srgb, currentColor 9%, transparent); }
#chime-toggle.chime-toggle:focus-visible { outline: 2px solid var(--accent, Highlight); outline-offset: 1px; }
#chime-toggle.chime-toggle svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }`;
    document.head.append(s);
  }
  const b = document.createElement("button");
  b.type = "button";
  b.id = "chime-toggle";
  b.className = "chime-toggle";
  paintBell(b);
  b.addEventListener("click", () => {
    store.set(MUTE_KEY, muted() ? null : "off");
    paintBell(b);
    // Turned on: the chime once, so the admin hears what it is (this click unlocked the sound).
    if (!muted()) setTimeout(play, 30);
  });
  head.append(b);
}
// Muted or unmuted in another tab: this tab's bell says so.
window.addEventListener("storage", (e) => { if (e.key == MUTE_KEY) { const b = document.getElementById("chime-toggle"); if (b instanceof HTMLButtonElement) paintBell(b); } });
mountBell();
