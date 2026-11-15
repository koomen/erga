// A domain's publishing (server/sites/publishing.ts) as the Durable Object runs it, on fake storage and a fake alarm.

import { expect, test } from "bun:test";
import { docRow, memorySite } from "./helpers/sites";

const HOME = docRow("d1");
const BLOG = docRow("d2", "Blog", "ada", "blog");
const files = (title: string, version: number) => ({ index: "index.html", files: { "index.html": `<h1>${title}</h1>` }, version });

function site(stored: Record<string, unknown> = {}, notify?: (id: string) => Promise<void>) {
  return memorySite({
    stored,
    notify,
    testFailures: true,
    document: async (id) => [HOME, BLOG].find((d) => d.id == id) ?? null,
    current: async (id) => (id == "d1" ? files("Home", 3) : id == "d2" ? files("Blog", 1) : null),
  });
}

/** The homepage's snapshot and deploy state, as the release before publishing stored them. */
const BEFORE = {
  state: { state: "deployed", docId: "d1", by: null, epoch: 2, running: false },
  live: {
    gen: "g0",
    docId: "d1",
    address: "/_home",
    before: "<h1>Old</h1>",
    after: "",
    files: ["index.html"],
    site: { bars: true, redirects: [] },
    at: 1,
    version: 2,
  },
  "f:g0:index.html": new TextEncoder().encode("<h1>Old</h1>"),
};

test("the homepage of the release before is the same document, published to the domain: it serves on, and nothing publishes", async () => {
  const { site: s, alarm } = site(BEFORE);
  await s.load();
  expect(await s.status()).toMatchObject({ state: "published", doc: "d1", bars: true, live: { doc: "d1", version: 2, at: 1 } });
  expect(alarm.at).toBeNull();
  const served = await s.served(null);
  expect(served && !served.same && served.served).toMatchObject({ bars: true, page: { gen: "g0", before: "<h1>Old</h1>" } });
  expect(await s.file("g0", "index.html")).not.toBeNull();
});

test("a snapshot of another shape in storage is no snapshot: the domain serves nothing until the next publish", async () => {
  const { files: _, ...old } = BEFORE.live;
  const { site: s, alarm } = site({ live: old });
  await s.load();
  expect(await s.served(null)).toBeNull();
  expect((await s.status()).state).toBe("free");
  expect(alarm.at).toBeNull();
});

test("link, publish, the header bar, replace, unlink: what the domain serves after each", async () => {
  const { site: s, ring, told, storage } = site();
  await s.load();
  // A link serves nothing.
  expect((await s.link({ doc: "d1", bars: true, replace: false, by: "ada" })).status).toMatchObject({
    state: "linked",
    doc: "d1",
    live: null,
  });
  expect(await s.served(null)).toBeNull();
  // A publish puts the document's version live.
  expect((await s.publish("d1", "ada")).status.state).toBe("publishing");
  await ring();
  expect(await s.status()).toMatchObject({ state: "published", by: "ada", live: { doc: "d1", version: 3 } });
  const first = await s.served(null);
  if (!first || first.same) throw new Error("nothing is served");
  const { page } = first.served as { page: { gen: string; files: string[] } };
  expect(page.files).toEqual(["index.html"]);
  // The header bar off: at once, the same snapshot under another tag.
  await s.link({ doc: "d1", bars: false, replace: false, by: "ada" });
  expect(await s.served(`${page.gen}:1`)).toMatchObject({ same: false, served: { bars: false, page: { gen: page.gen } } });
  expect(await s.served(`${page.gen}:0`)).toEqual({ same: true, tag: `${page.gen}:0` });
  // Another document: refused without replace; with it, linked, and the old version serves on.
  expect((await s.link({ doc: "d2", bars: false, replace: false, by: "bo" })).refused).toEqual({ claimed: "d1" });
  expect((await s.link({ doc: "d2", bars: false, replace: true, by: "bo" })).status).toMatchObject({
    state: "linked",
    doc: "d2",
    live: { doc: "d1" },
  });
  expect(await s.served(`${page.gen}:0`)).toEqual({ same: true, tag: `${page.gen}:0` });
  expect((await s.publish("d1", "ada")).refused).toEqual({ claimed: "d2" });
  await s.publish("d2", "bo");
  await ring();
  expect(await s.status()).toMatchObject({ state: "published", doc: "d2", live: { doc: "d2", version: 1 } });
  expect(told).toContain("d2");
  // Not published: free at once, and every file is gone.
  expect(await s.unlink("d2")).toMatchObject({ state: "free", live: null });
  expect(await s.served(null)).toBeNull();
  expect([...storage.keys()].filter((k) => k.startsWith("f:"))).toEqual([]);
});

test("a publish that fails leaves the last version live, and says why", async () => {
  let page = "<h1>Home</h1>";
  const s = memorySite({
    testFailures: true,
    document: async () => HOME,
    current: async () => ({ index: "index.html", files: { "index.html": page }, version: 4 }),
  });
  await s.site.load();
  await s.site.link({ doc: "d1", bars: true, replace: false, by: "ada" });
  await s.site.publish("d1", "ada");
  await s.ring();
  page = "<!-- erga:test-fail-publish -->";
  await s.site.publish("d1", "ada");
  await s.ring();
  expect(await s.site.status()).toMatchObject({
    state: "failed",
    error: "This test page asks for its publish to fail.",
    live: { doc: "d1", version: 4 },
  });
  expect(await s.site.served(null)).not.toBeNull();
});

test("a deleted document: its domain is free, and serves nothing", async () => {
  const { site: s, ring } = site();
  await s.load();
  await s.link({ doc: "d1", bars: true, replace: false, by: "ada" });
  await s.publish("d1", "ada");
  await ring();
  await s.forget("d1");
  expect((await s.status()).state).toBe("free");
  expect(await s.served(null)).toBeNull();
});

test("a publish asked for while the last one tells its end still runs", async () => {
  let last: (() => void) | null = null;
  let hold = false;
  const {
    site: s,
    alarm,
    ring,
  } = site({}, async () => {
    if (hold)
      await new Promise<void>((done) => {
        last = done;
      });
  });
  await s.load();
  await s.link({ doc: "d1", bars: true, replace: false, by: "ada" });
  await s.publish("d1", "ada");
  hold = true;
  // The publish runs; it tells everyone when it's done, and someone presses Publish meanwhile.
  const first = ring();
  for (let i = 0; i < 100 && !(last && (await s.status()).state == "published"); i++) await new Promise((r) => setTimeout(r, 5));
  hold = false;
  alarm.at = null;
  await s.publish("d1", "ada");
  // Cloudflare runs the alarm the publish set, while the first alarm still waits.
  await ring();
  (last as (() => void) | null)?.();
  await first;
  expect((await s.status()).state).toBe("published");
});
