// A domain served from its snapshot (server/sites/serve.ts), when the edge's cache still holds a copy that another
// release wrote: production on 2026-11-06 had one of another shape, and gave an empty 500 on / and on every address
// that the site could answer. And what the header bar setting does to each page, at once.

import { expect, spyOn, test } from "bun:test";
import * as Effect from "effect/Effect";
import { requestUrl, respond, text } from "../server/http.ts";
import { ERGA, forgetSite, serveDomain, serveRoot, serveSitePath } from "../server/sites/index.ts";
import { type LivePage, tagOf } from "../server/sites/snapshot.ts";
import type { Platform } from "../server/platform.ts";
import { until } from "./helpers/until.ts";

const page: LivePage = {
  gen: "g1",
  docId: "rcyd2f6z",
  address: "/_home",
  before: "<!doctype html><html><head><style>html { overscroll-behavior: none; } /*erga:band*/</style></head><body><h1>Erga</h1>",
  after: "</body></html>",
  files: ["index.html", "about.html"],
  site: { redirects: [] },
  at: 1,
  version: 84,
};
// What the release before wrote in the edge's cache: the snapshot alone, at another key; and a copy of another shape.
const { site: _, ...old } = page;
const URL_ROOT = new URL("https://erga.test/");

function platform(bars = false): Platform & { bars: boolean } {
  const cache = new Map([
    ["https://erga.test/_home-files/page", JSON.stringify(page)],
    ["https://erga.test/_home-files/served", JSON.stringify({ page: old, bars: true })],
  ]);
  const p = {
    bars,
    secret: "s",
    sessionOf: async () => null,
    deploy: { domains: ["site.test"], app: "erga.test" },
    directory: {},
    edge: {
      cache: {
        match: async (key: string) => {
          const body = cache.get(key);
          return body == null ? undefined : new Response(body, { headers: { "x-checked": String(Date.now()) } });
        },
        put: async (key: string, r: Response) => void cache.set(key, await r.text()),
        delete: async (key: string) => cache.delete(key),
      },
      background: () => {},
      siteRecheckMs: 5000,
    },
    site: () => ({
      // The site object's own copy is current.
      served: async (known?: string | null) => {
        const served = { page, bars: p.bars };
        return known == tagOf(served) ? { same: true, tag: known } : { same: false, served };
      },
      file: async (_gen: string, path: string) =>
        page.files.includes(path)
          ? { bytes: new TextEncoder().encode(`<!doctype html><html><head></head><body><p>${path}</p></body></html>`), type: "text/html" }
          : null,
    }),
  };
  return p as unknown as Platform & { bars: boolean };
}

const site = serveSitePath({ notFound: false, taken: async () => false });
// As server/app.ts routes them: / is the published page, any other address may be the site's.
const route = Effect.gen(function* () {
  const root = (yield* requestUrl).pathname == "/" ? yield* serveRoot : null;
  if (root) return root;
  return (yield* site) ?? text("Not the site's", 404);
});

test("a copy another release left in the edge's cache doesn't break / or the site's addresses", async () => {
  const p = platform();
  await forgetSite(p, URL_ROOT, ERGA);
  const root = await respond(route, new Request("https://erga.test/"), p);
  expect(root.status).toBe(200);
  expect(await root.text()).toContain("<h1>Erga</h1>");
  const about = await respond(route, new Request("https://erga.test/about"), p);
  expect(about.status).toBe(200);
  expect(await about.text()).toContain("<p>about.html</p>");
});

test("the header bar: off, no page has Erga's controls or room for them; on, every page of the Erga domain has both, at once", async () => {
  const p = platform(false);
  (p.edge as { siteRecheckMs: number }).siteRecheckMs = 0;
  (p.edge as { cache: unknown }).cache = undefined;
  await forgetSite(p, URL_ROOT, ERGA);
  const get = async (path: string) => (await respond(route, new Request(`https://erga.test${path}`), p)).text();
  for (const path of ["/", "/about"]) {
    const html = await get(path);
    expect(html, path).not.toContain("<erga-controls");
    expect(html, path).not.toContain("padding-top");
  }
  // The same snapshot, the bar on: no publish between.
  p.bars = true;
  for (const path of ["/", "/about"]) {
    const html = await get(path);
    expect(html, path).toContain("<erga-controls");
    expect(html, path).toMatch(/html:root:root \{ padding-top/);
    // The controls end the body: nothing of the app's own corner beside them.
    expect(html, path).toMatch(/<\/script><\/body>/);
  }
});

test("a custom domain: the site's files as they are, and nothing of Erga's but the Document LLM API; nothing published, nothing", async () => {
  const p = platform(true);
  (p.edge as { cache: unknown }).cache = undefined;
  await forgetSite(p, URL_ROOT, "site.test");
  const custom = serveDomain("site.test");
  const root = await respond(custom, new Request("https://site.test/"), p);
  const html = await root.text();
  expect(root.status).toBe(200);
  expect(html).toContain("<p>index.html</p>");
  expect(html).toContain('"/_erga"');
  expect(html).not.toContain("<erga-controls");
  // An address the site hasn't, and a domain with nothing published: a 404 with no body.
  for (const answer of [
    await respond(custom, new Request("https://site.test/missing"), p),
    await respond(custom, new Request("https://site.test/", { method: "POST" }), p),
  ]) {
    expect(answer.status).toBe(404);
    expect(await answer.text()).toBe("");
  }
  (p as { site: unknown }).site = () => ({ served: async () => null });
  await forgetSite(p, URL_ROOT, "site.test");
  const none = await respond(custom, new Request("https://site.test/"), p);
  expect([none.status, await none.text()]).toEqual([404, ""]);
});

test("a route's defect is logged, with its path", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const r = await respond(Effect.die(new TypeError("boom")), new Request("https://erga.test/signin"), platform());
    expect(r.status).toBe(500);
    expect(errors.mock.calls.flat().join(" ")).toMatch(/GET \/signin failed: .*boom/s);
  } finally {
    errors.mockRestore();
  }
});

test("another shape from the site object itself (a release in between) doesn't break /", async () => {
  const p = platform();
  // Nothing in this isolate or at the edge: the site object's answer is the only copy, and it's another release's.
  await forgetSite(p, URL_ROOT, ERGA);
  (p.edge as { cache: unknown }).cache = undefined;
  (p as { site: unknown }).site = () => ({ served: async () => ({ same: false, served: { page: old, bars: true } }) });
  const root = await respond(route, new Request("https://erga.test/"), p);
  expect(root.status).not.toBe(500);
});

test("a publish that forgets the copy while this isolate asks the site object doesn't break /", async () => {
  const p = platform();
  (p.edge as { siteRecheckMs: number }).siteRecheckMs = 0;
  (p.edge as { cache: unknown }).cache = undefined;
  await forgetSite(p, URL_ROOT, ERGA);
  expect((await respond(route, new Request("https://erga.test/"), p)).status).toBe(200);
  // The next / asks with the tag it has; a publish through this isolate forgets it before the answer comes.
  let answer!: () => void;
  const asked = p.site(ERGA).served;
  (p as { site: unknown }).site = () => ({
    served: async (known?: string | null) => {
      await new Promise<void>((done) => {
        answer = done;
      });
      return asked(known);
    },
  });
  const second = respond(route, new Request("https://erga.test/"), p);
  await until(() => !!answer);
  await forgetSite(p, URL_ROOT, ERGA);
  answer();
  expect((await second).status).toBe(200);
});

// One request for / asked for the snapshot two times: as the published page, then as an address of the site.
test("the first publish ends while / is answered: / is not the site's bare index.html", async () => {
  const p = platform();
  (p.edge as { cache: unknown }).cache = undefined;
  await forgetSite(p, URL_ROOT, ERGA);
  const published = p.site(ERGA).served;
  let asked = 0;
  (p as { site: unknown }).site = () => ({ served: async (known?: string | null) => (asked++ ? published(known) : null) });
  const first = await respond(route, new Request("https://erga.test/"), p);
  expect([asked, first.status, await first.text()]).toEqual([1, 404, "Not the site's"]);
  // The next / is the published page.
  expect(await (await respond(route, new Request("https://erga.test/"), p)).text()).toContain("<h1>Erga</h1>");
});
