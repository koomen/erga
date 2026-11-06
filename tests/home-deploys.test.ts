// The homepage's deploys (server/home/deploys.ts) as the Durable Object runs them, on fake storage and a fake alarm.

import { expect, test } from "bun:test";
import { HomeDeploys, type HomeDeps } from "../server/home/deploys.ts";

function deploys(stored: Record<string, unknown> = {}, notify: (id: string) => Promise<void> = async () => {}) {
  const storage = new Map(Object.entries(stored));
  const alarm = { at: null as number | null };
  const doc = { id: "d1", owner: "-home", slug: "home", title: "Home", test: false };
  const deps = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (a: string | Record<string, unknown>, b?: unknown) => {
        for (const [k, v] of typeof a == "string" ? [[a, b] as const] : Object.entries(a)) storage.set(k, v);
      },
      delete: async (keys: string | string[]) => {
        for (const k of [keys].flat()) storage.delete(k);
      },
      list: async (prefix: string) => [...storage.keys()].filter((k) => k.startsWith(prefix)),
    },
    alarm: { set: async (at: number) => void (alarm.at = at), delete: async () => void (alarm.at = null) },
    directory: {
      config: { isLocked: () => true, get: async () => doc.id, stored: async () => null },
      find: async (id: string) => (id == doc.id ? doc : null),
    },
    current: async () => ({ index: "index.html", files: { "index.html": "<h1>Home</h1>" }, version: 3 }),
    notify,
    mimeOf: () => "text/html",
    log: () => {},
  } as unknown as HomeDeps;
  return { home: new HomeDeploys(deps), alarm, storage };
}

test("a snapshot of an older shape in storage is no snapshot: the next / deploys again", async () => {
  // A release before `files` (say) stored this one; the next new field makes the same.
  const { home, alarm } = deploys({
    live: {
      gen: "g0",
      docId: "d1",
      address: "/_home",
      before: "<h1>Old</h1>",
      after: "",
      site: { bars: true, redirects: [] },
      at: 1,
      version: 2,
    },
  });
  await home.load();
  expect(await home.page(null)).toBeNull();
  await home.ensure();
  expect((await home.status()).state).toBe("deploying");
  expect(alarm.at).not.toBeNull();
  await home.alarm();
  const page = await home.page(null);
  expect(page && !page.same && page.page.files).toEqual(["index.html"]);
});

test("a deploy asked for while the last one tells its end still runs", async () => {
  let last: (() => void) | null = null;
  let hold = false;
  const { home, alarm } = deploys({}, async () => {
    if (hold)
      await new Promise<void>((done) => {
        last = done;
      });
  });
  await home.load();
  await home.deploy("ada");
  hold = true;
  // The deploy runs; it tells everyone when it's done, and someone presses Deploy meanwhile.
  const first = home.alarm();
  for (let i = 0; i < 100 && !(last && (await home.status()).state == "deployed"); i++) await new Promise((r) => setTimeout(r, 5));
  hold = false;
  alarm.at = null;
  await home.deploy("ada");
  // Cloudflare runs the alarm the deploy set, while the first alarm still waits.
  if (alarm.at != null) {
    alarm.at = null;
    await home.alarm();
  }
  (last as (() => void) | null)?.();
  await first;
  expect((await home.status()).state).toBe("deployed");
});
