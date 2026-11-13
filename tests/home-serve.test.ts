// The homepage served from its snapshot (server/home/serve.ts), when the edge's cache still holds a copy that an older
// release wrote: production on 2026-11-06 had one without `site` (before a232de21), and gave an empty 500 on / and on
// every address that the homepage's site could answer.

import { expect, spyOn, test } from "bun:test";
import * as Effect from "effect/Effect";
import { requestUrl, respond, text } from "../server/http.ts";
import { forgetHome, serveHome, serveHomeSite } from "../server/home/index.ts";
import type { LivePage } from "../server/home/snapshot.ts";
import type { Platform } from "../server/platform.ts";
import { until } from "./helpers/until.ts";

const page: LivePage = {
  gen: "g1",
  docId: "rcyd2f6z",
  address: "/_home",
  before: "<!doctype html><html><head></head><body><h1>Erga</h1>",
  after: "</body></html>",
  files: ["index.html", "about.html"],
  site: { bars: false, redirects: [] },
  at: 1,
  version: 84,
};
// What the release before a232de21 put in the edge's cache: the same generation, with no `site`.
const { site: _, ...old } = page;

function platform(): Platform {
  const cache = new Map([["https://erga.test/_home-files/page", JSON.stringify(old)]]);
  return {
    secret: "s",
    sessionOf: async () => null,
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
      homeRecheckMs: 5000,
    },
    home: {
      // The home object's own copy is current (deploys.ts migrates it when it loads).
      page: async (known?: string | null) => (known == page.gen ? { same: true, gen: page.gen } : { same: false, page }),
      file: async (_gen: string, path: string) =>
        page.files.includes(path) ? { bytes: new TextEncoder().encode(`<p>${path}</p>`), type: "text/html" } : null,
      ensure: async () => {},
    },
  } as unknown as Platform;
}

const site = serveHomeSite({ notFound: false, taken: async () => false });
// As server/app.ts routes them: / is the homepage, any other address may be the site's.
const route = Effect.gen(function* () {
  const home = (yield* requestUrl).pathname == "/" ? yield* serveHome : null;
  if (home) return home;
  return (yield* site) ?? text("Not the site's", 404);
});

test("a snapshot an older release left in the edge's cache doesn't break / or the site's addresses", async () => {
  const p = platform();
  const home = await respond(route, new Request("https://erga.test/"), p);
  expect(home.status).toBe(200);
  expect(await home.text()).toContain("<h1>Erga</h1>");
  const about = await respond(route, new Request("https://erga.test/about"), p);
  expect(about.status).toBe(200);
  expect(await about.text()).toContain("<p>about.html</p>");
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

test("an older shape from the home object itself (a release in between) doesn't break /", async () => {
  const p = platform();
  // Nothing in this isolate or at the edge: the home object's answer is the only copy, and it's an older release's.
  await forgetHome(p, new URL("https://erga.test/"));
  (p.edge as { cache: unknown }).cache = undefined;
  (p.home as { page: unknown }).page = async () => ({ same: false, page: old });
  const home = await respond(route, new Request("https://erga.test/"), p);
  expect(home.status).not.toBe(500);
});

test("a deploy that forgets the snapshot while this isolate asks the home object doesn't break /", async () => {
  const p = platform();
  (p.edge as { homeRecheckMs: number }).homeRecheckMs = 0;
  (p.edge as { cache: unknown }).cache = undefined;
  await forgetHome(p, new URL("https://erga.test/"));
  expect((await respond(route, new Request("https://erga.test/"), p)).status).toBe(200);
  // The next / asks with the generation it has; a deploy through this isolate forgets it before the answer comes.
  let answer!: () => void;
  const asked = p.home.page;
  (p.home as { page: unknown }).page = async (known?: string | null) => {
    await new Promise<void>((done) => {
      answer = done;
    });
    return asked(known);
  };
  const second = respond(route, new Request("https://erga.test/"), p);
  await until(() => !!answer);
  await forgetHome(p, new URL("https://erga.test/"));
  answer();
  expect((await second).status).toBe(200);
});

// One request for / asked for the snapshot two times: as the homepage, then as an address of the site.
test("the first deploy ends while / is answered: / is not the site's bare index.html", async () => {
  const p = platform();
  (p.edge as { cache: unknown }).cache = undefined;
  await forgetHome(p, new URL("https://erga.test/"));
  const deployed = p.home.page;
  let asked = 0;
  (p.home as { page: unknown }).page = async (known?: string | null) => (asked++ ? deployed(known) : null);
  const first = await respond(route, new Request("https://erga.test/"), p);
  expect([asked, first.status, await first.text()]).toEqual([1, 404, "Not the site's"]);
  // The next / is the homepage.
  expect(await (await respond(route, new Request("https://erga.test/"), p)).text()).toContain("<h1>Erga</h1>");
});
