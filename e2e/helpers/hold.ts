// A request of the tab that waits for the test: held in the tab itself (its fetch and its XMLHttpRequest), until the
// test says what happens to it. For a slow server, a refusal, a network that is down.
//
// Trap: not a route of the test's that the test takes away again (page.route, then page.unroute). When the last route
// goes, Playwright turns its interception off, and a request that the tab starts in that moment gets no answer, ever:
// any request of the tab, not only one that the route was for (the driver drops the pair of events for it; 3 of 300
// rounds in a probe). It was a flaky failure in several journeys: an upload's row that stayed at 0%, a tree that
// never read the server again. A route that stays for the tab's life is fine: nothing is turned off under a request.
// tests/test-habits.test.ts refuses a new unroute.

import type { Page } from "playwright-core";
import { until } from "./fixtures";

/** Which of the tab's requests a hold takes: all that it names must fit. */
export interface Match {
  /** Its address. */
  url: RegExp;
  method?: string;
  /** In its body (a body that is text). */
  body?: string;
  /** A header, and its value. */
  header?: [name: string, value: string];
}

/** What happens to a request: it goes to the server; it fails, as with no network; or it gets this answer, as JSON. */
export type Fate = "pass" | "fail" | { status: number; body: unknown };

export interface Hold {
  /** How many requests it took, from its start (in the document that the tab shows now). */
  seen(): Promise<number>;
  /** How many of them wait. */
  waiting(): Promise<number>;
  /** The oldest that waits (it waits for one) goes to the server: back once its answer is in the tab. */
  pass(): Promise<void>;
  /** The oldest that waits fails, as with no network. */
  fail(): Promise<void>;
  /** The oldest that waits gets this answer, which the server never sees. */
  answer(status: number, body: unknown): Promise<void>;
  /** The end: those that wait go to the server (back once their answers are in), and the tab's requests are its own again. */
  end(): Promise<void>;
}

type Args = [
  id: string,
  url: string,
  flags: string,
  method: string | null,
  body: string | null,
  header: [string, string] | null,
  each: Fate | null,
];

/** In the tab: the hold `id`, and (one time for each document) the tab's fetch and XMLHttpRequest that ask the holds first. */
function install([id, url, flags, method, body, header, each]: Args) {
  type Decide = (fate: Fate) => Promise<void>;
  interface Held {
    url: RegExp;
    method: string | null;
    body: string | null;
    header: [string, string] | null;
    each: Fate | null;
    seen: number;
    queue: Decide[];
    ended: boolean;
  }
  const w = window as unknown as { __holds?: Record<string, Held>; __holding?: boolean };
  const holds = (w.__holds ??= {});
  holds[id] ??= { url: new RegExp(url, flags), method, body, header, each, seen: 0, queue: [], ended: false };
  if (w.__holding) return;
  w.__holding = true;
  const taker = (url: string, method: string, body: string, head: (name: string) => string | null) =>
    Object.values(holds).find(
      (h) =>
        !h.ended &&
        h.url.test(url) &&
        (!h.method || h.method == method) &&
        (!h.body || body.includes(h.body)) &&
        (!h.header || head(h.header[0]) == h.header[1])
    );
  const take = (h: Held, decide: Decide) => {
    h.seen++;
    if (h.each) void decide(h.each);
    else h.queue.push(decide);
  };

  const send = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const request = input instanceof Request ? input : null;
    const headers = new Headers(init?.headers ?? request?.headers);
    const h = taker(
      new URL(request ? request.url : String(input), location.href).href,
      (init?.method ?? request?.method ?? "GET").toUpperCase(),
      typeof init?.body == "string" ? init.body : "",
      (name) => headers.get(name)
    );
    if (!h) return send.call(this, input, init);
    return new Promise<Response>((answer, fail) => {
      // (Given up meanwhile, as a request on its way is.)
      init?.signal?.addEventListener("abort", () => fail(init.signal!.reason));
      take(h, (fate) => {
        if (fate == "fail") fail(new TypeError("Failed to fetch"));
        else if (fate != "pass")
          answer(new Response(JSON.stringify(fate.body), { status: fate.status, headers: { "content-type": "application/json" } }));
        else {
          const real = send.call(window, input, init);
          answer(real);
          return real.then(
            () => {},
            () => {}
          );
        }
        return Promise.resolve();
      });
    });
  } as typeof fetch;

  // (An upload's bytes: XMLHttpRequest says how many went. It can go to the server or fail; no answer is made for it.)
  const asked = new WeakMap<XMLHttpRequest, [method: string, url: string]>();
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    asked.set(this, [method.toUpperCase(), new URL(String(url), location.href).href]);
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof open;
  const post = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const [method, url] = asked.get(this) ?? ["GET", ""];
    const h = taker(url, method, typeof body == "string" ? body : "", () => null);
    if (!h) return post.call(this, body);
    take(h, (fate) => {
      // (Stopped meanwhile, by the page: it is not open any more, and nothing goes.)
      if (this.readyState != XMLHttpRequest.OPENED) return Promise.resolve();
      if (fate == "pass") post.call(this, body);
      else this.dispatchEvent(new ProgressEvent("error"));
      return Promise.resolve();
    });
  };
}

let holds = 0;

/**
 * Holds the tab's requests that `match` names, from now on, in the document that the tab shows. `each`: none waits,
 * each one gets this at once. `loads`: in each document that the tab loads after this one too.
 */
export async function hold(page: Page, match: Match, o: { each?: Fate; loads?: boolean } = {}): Promise<Hold> {
  const id = `hold${++holds}`;
  const args: Args = [
    id,
    match.url.source,
    match.url.flags,
    match.method?.toUpperCase() ?? null,
    match.body ?? null,
    match.header ?? null,
    o.each ?? null,
  ];
  const later = o.loads ? await page.addInitScript(install, args) : null;
  await page.evaluate(install, args);
  type Held = { seen: number; queue: ((fate: Fate) => Promise<void>)[]; ended: boolean };
  const count = (what: "seen" | "waiting") =>
    page.evaluate(
      ([id, what]) => {
        const h = (window as unknown as { __holds?: Record<string, Held> }).__holds?.[id];
        return !h ? 0 : what == "seen" ? h.seen : h.queue.length;
      },
      [id, what] as const
    );
  const next = async (fate: Fate) => {
    await until(async () => (await count("waiting")) > 0, 10_000, `a request to ${match.url} waits`);
    await page.evaluate(([id, fate]) => (window as unknown as { __holds: Record<string, Held> }).__holds[id].queue.shift()!(fate), [
      id,
      fate,
    ] as const);
  };
  return {
    seen: () => count("seen"),
    waiting: () => count("waiting"),
    pass: () => next("pass"),
    fail: () => next("fail"),
    answer: (status, body) => next({ status, body }),
    async end() {
      await later?.dispose();
      await page.evaluate(async (id) => {
        const h = (window as unknown as { __holds?: Record<string, Held> }).__holds?.[id];
        if (!h) return;
        h.ended = true;
        await Promise.all(h.queue.splice(0).map((decide) => decide("pass")));
      }, id);
    },
  };
}

/**
 * Holds a page's load: a frame that goes to an address like `url`. The tab can't hold its own loads, so a route of the
 * test's does, and it stays for the tab's life: after `release` each such load goes on at once, and nothing is turned
 * off under a request (the trap above).
 */
export async function holdLoads(page: Page, url: RegExp) {
  let asked = 0,
    release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  await page.context().route(url, async (route) => {
    asked++;
    await held;
    await route.continue();
  });
  return {
    /** How many loads it took. */
    asked: () => asked,
    /** Those that wait go on, and each one after them at once. */
    release,
  };
}
