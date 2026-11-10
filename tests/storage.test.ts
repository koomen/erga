// The document's Storage (document/storage.ts): MemoryStorage behaves as a
// Durable Object's storage does for what the document uses, and the store
// helpers read and write files, folders and the room's state through it.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { fileStoreOf, KEYS, kvOf, MemoryStorage } from "../document/storage";
import { until } from "./helpers/until";

test("get, put and delete, one key or many; list in key order, by prefix, after a key, at most a limit", async () => {
  const s = new MemoryStorage();
  await s.put("b", 2);
  await s.put({ a: 1, c: 3, "p:x": "x", "p:y": "y" });
  expect(await s.get<number>("a")).toBe(1);
  expect(await s.get("nope")).toBeUndefined();
  expect([...(await s.get(["a", "c", "nope"])).entries()]).toEqual([["a", 1], ["c", 3]]);
  expect([...(await s.list()).keys()]).toEqual(["a", "b", "c", "p:x", "p:y"]);
  expect([...(await s.list({ prefix: "p:" })).keys()]).toEqual(["p:x", "p:y"]);
  expect([...(await s.list({ startAfter: "b", limit: 2 })).keys()]).toEqual(["c", "p:x"]);
  expect(await s.delete("a")).toBe(true);
  expect(await s.delete("a")).toBe(false);
  expect(await s.delete(["b", "c", "zz"])).toBe(2);
  await s.setAlarm(Date.now() + 60_000);
  await s.deleteAll();
  expect((await s.list()).size).toBe(0);
  expect(await s.getAlarm()).not.toBeNull();
  await s.deleteAlarm();
  expect(await s.getAlarm()).toBeNull();
});

test("the alarm wakes once it is due; set again, only the last one counts", async () => {
  let woke = 0;
  const s = new MemoryStorage(() => { woke++; });
  await s.setAlarm(Date.now() + 10_000);
  await s.setAlarm(Date.now() + 20);
  expect(await s.getAlarm()).toBeGreaterThan(Date.now() - 1);
  await until(() => woke > 0);
  expect(woke).toBe(1);
  expect(await s.getAlarm()).toBeNull();
});

test("files and folders go through the storage, each change noted", async () => {
  const s = new MemoryStorage();
  let touched = 0;
  const files = fileStoreOf(s, { touch: async () => { touched++; } });
  const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
  await run(files.write("index.html", "<h1>Hi</h1>"));
  await run(files.write("notes/a.md", "# A"));
  await run(files.writeBytes!("img/logo.png", new Uint8Array([1, 2, 3])));
  await run(files.mkdir!("drafts/old"));
  expect(await run(files.list)).toEqual(["img/logo.png", "index.html", "notes/a.md"]);
  expect(await run(files.folders!)).toEqual(["drafts", "drafts/old"]);
  expect(new TextDecoder().decode((await run(files.read("index.html")))!)).toBe("<h1>Hi</h1>");
  expect(await run(files.read("nope.html"))).toBeNull();
  expect(await s.get<Uint8Array>(KEYS.file + "img/logo.png")).toEqual(new Uint8Array([1, 2, 3]));
  await run(files.rmdir!("drafts"));
  expect(await run(files.folders!)).toEqual([]);
  await run(files.remove!("notes/a.md"));
  expect(await run(files.list)).toEqual(["img/logo.png", "index.html"]);
  // Two writes, writeBytes, mkdir, rmdir and remove each count as a change to the document.
  expect(touched).toBe(6);

  const kv = kvOf(s);
  await kv.put({ "v:1": { n: 1 }, "v:2": { n: 2 } });
  expect(await kv.get<{ n: number }>("v:2")).toEqual({ n: 2 });
  expect([...(await kv.get<{ n: number }>(["v:1", "v:3"])).keys()]).toEqual(["v:1"]);
});
