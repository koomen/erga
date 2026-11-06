// view_page's browser (cloudflare/browser.ts): one connection for each Durable Object, kept HOLD_MS after the last
// render in flight. A fake binding answers the calls; its sockets answer each CDP call at once.

import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { browsers } from "../cloudflare/browser";
import { step, type Hold, type HoldEvent } from "../cloudflare/browser-hold";
import { connect, type BrowserBinding } from "../cloudflare/cdp";

/** A socket that answers each call: with `fail`'s error for those methods, else an empty result (ids for the few that need one). */
function socket(fail: string[] = []) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const ws = {
    closed: false,
    accept() {},
    addEventListener(type: string, f: (e: any) => void) {
      (listeners[type] ??= []).push(f);
    },
    send(text: string) {
      const m = JSON.parse(text);
      const result = { targetId: "t1", sessionId: "s1", browserContextId: "c1" };
      const reply = fail.includes(m.method) ? { id: m.id, error: { message: `no ${m.method}` } } : { id: m.id, result };
      queueMicrotask(() => {
        for (const f of listeners.message ?? []) f({ data: JSON.stringify(reply) });
      });
    },
    close() {
      ws.closed = true;
      for (const f of listeners.close ?? []) f({});
    },
  };
  return ws;
}

function binding(fail: string[] = []) {
  const made: ReturnType<typeof socket>[] = [];
  const b: BrowserBinding = {
    fetch: async (input) => {
      const url = new URL(input);
      if (url.pathname == "/v1/sessions") return Response.json({ sessions: [] });
      if (url.pathname == "/v1/devtools/browser") return Response.json({ sessionId: `x${made.length}` });
      const ws = socket(fail);
      made.push(ws);
      return Object.assign(new Response(null), { webSocket: ws });
    },
  };
  return { b, made };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a render that ends keeps no timer on another render's connection", async () => {
  const { b } = binding();
  const mine = browsers(b);
  const a = await mine.use();
  const r = await mine.use();
  expect([a.how, r.how]).toEqual(["launched", "reused"]);
  mine.done(); // render A ends; render B goes on (up to 60 s)
  jest.advanceTimersByTime(31_000);
  expect(r.browser.connected).toBe(true);
  mine.done(); // render B ends: the connection stays HOLD_MS, then goes
  jest.advanceTimersByTime(29_000);
  expect(r.browser.connected).toBe(true);
  jest.advanceTimersByTime(2_000);
  expect(r.browser.connected).toBe(false);
});

test("a render in the hold reuses the connection, and the hold starts again after it", async () => {
  const { b, made } = binding();
  const mine = browsers(b);
  const a = await mine.use();
  mine.done();
  jest.advanceTimersByTime(20_000);
  const r = await mine.use();
  expect(r.how).toBe("reused");
  jest.advanceTimersByTime(20_000);
  expect(a.browser.connected).toBe(true);
  mine.done();
  jest.advanceTimersByTime(31_000);
  expect(a.browser.connected).toBe(false);
  expect((await mine.use()).how).toBe("launched");
  expect(made.length).toBe(2);
});

test("a page that fails to start leaves no listener on the kept connection", async () => {
  const { b } = binding(["Log.enable"]);
  const browser = await connect(b, "x");
  await expect(browser.newPage()).rejects.toThrow("no Log.enable");
  expect((browser as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
});

// The machine alone (cloudflare/browser-hold.ts), with no IO.
const run = (events: HoldEvent<string>[]) => {
  let s: Hold<string> = { at: "none", n: 0 };
  const effects: string[] = [];
  for (const e of events) {
    const [next, fx] = step(s, e);
    s = next;
    effects.push(...fx.map((f) => f.do));
  }
  return { s, effects };
};
const use = { type: "use", alive: true } as const;
const done = { type: "done" } as const;
const started = { type: "started", browser: "b" } as const;

test("the hold starts only when no render is left in flight", () => {
  expect(run([use, started, use, done])).toEqual({ s: { at: "in use", n: 1, browser: "b" }, effects: ["start"] });
  expect(run([use, started, use, done, done, { type: "timer" }])).toEqual({
    s: { at: "none", n: 0 },
    effects: ["start", "arm", "disconnect"],
  });
});

test("a render in the hold disarms it; a closed connection starts a new one", () => {
  expect(run([use, started, done, use]).s).toEqual({ at: "in use", n: 1, browser: "b" });
  expect(run([use, started, done, use]).effects).toEqual(["start", "arm", "disarm"]);
  expect(run([use, started, use, { type: "use", alive: false }])).toEqual({ s: { at: "starting", n: 3 }, effects: ["start", "start"] });
});

test("renders that end while the connection starts are counted", () => {
  // Both renders gave up (their time limit) before the connection came: it is held, then goes.
  expect(run([use, use, done, done, started])).toEqual({ s: { at: "held", browser: "b" }, effects: ["start", "arm"] });
  // A failed start: the renders still in flight are counted until they end.
  expect(run([use, use, { type: "failed" }, use]).s).toEqual({ at: "starting", n: 3 });
  expect(run([use, { type: "failed" }, done, use, started]).s).toEqual({ at: "in use", n: 1, browser: "b" });
});

test("a stray event changes nothing it shouldn't", () => {
  expect(run([{ type: "timer" }, done]).s).toEqual({ at: "none", n: 0 });
  expect(run([use, started, { type: "started", browser: "c" }])).toEqual({
    s: { at: "in use", n: 1, browser: "b" },
    effects: ["start", "disconnect"],
  });
});
