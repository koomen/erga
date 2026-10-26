// A document's files on disk as a Storage (document/disk.ts): files and
// folders go to the dev server over the mirror's socket, every other key to
// the storage it wraps; a single file linked on its own is the one file there.
// The dev server here is a fake folder answering the mirror's asks.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { DiskLink, type FromDisk, type ToDisk } from "../document/disk";
import { fileStoreOf, MemoryStorage } from "../document/storage";

/** A fake dev server: a folder in memory on the other end of the socket. */
function folder(files: Record<string, string> = {}, dirs: string[] = []) {
  const disk = new Map(Object.entries(files).map(([p, t]) => [p, new TextEncoder().encode(t)]));
  const folders = new Set(dirs);
  const listeners = new Map<string, ((e: { data: string }) => void)[]>();
  const log: string[] = [];
  const socket = {
    addEventListener: (type: string, fn: (e: { data: string }) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    close: () => {},
    send: (data: string) => {
      const m = JSON.parse(data) as ToDisk;
      if (m.t == "flushed") return;
      log.push(m.t + (("path" in m) ? ` ${m.path}` : ""));
      const reply = (r: Partial<Extract<FromDisk, { t: "reply" }>>) => { for (const fn of listeners.get("message") ?? []) fn({ data: JSON.stringify({ t: "reply", id: m.id, ...r }) }); };
      if (m.t == "list") return reply({ paths: [...disk.keys()] });
      if (m.t == "folders") return reply({ dirs: [...folders] });
      if (m.t == "read") { const b = disk.get(m.path); return reply({ b64: b ? Buffer.from(b).toString("base64") : null }); }
      if (m.t == "write") { disk.set(m.path, m.b64 != null ? new Uint8Array(Buffer.from(m.b64, "base64")) : new TextEncoder().encode(m.text ?? "")); return reply({}); }
      if (m.t == "remove") { disk.delete(m.path); return reply({}); }
      if (m.t == "mkdir") { folders.add(m.path); return reply({}); }
      if (m.t == "rmdir") { folders.delete(m.path); for (const p of [...disk.keys()]) if (p.startsWith(m.path + "/")) disk.delete(p); return reply({}); }
    },
    /** The dev server says a file changed. */
    changed: (path: string) => { for (const fn of listeners.get("message") ?? []) fn({ data: JSON.stringify({ t: "changed", path } satisfies FromDisk) }); },
  };
  return { disk, folders, socket, log, text: (p: string) => new TextDecoder().decode(disk.get(p)) };
}

test("files and folders live on the folder, the other keys in the wrapped storage; deleting all keeps the files", async () => {
  const f = folder({ "index.html": "<h1>Hi</h1>", "img/a.png": "png" }, ["img"]);
  const changed: string[] = [];
  const link = new DiskLink({ changed: (p) => changed.push(p), connected: () => {}, flush: async () => {} });
  link.accept(f.socket as unknown as WebSocket);
  const inner = new MemoryStorage();
  const s = link.storage(inner, null);

  expect(new TextDecoder().decode(await s.get<Uint8Array>("files/index.html"))).toBe("<h1>Hi</h1>");
  expect(await s.get("files/nope.html")).toBeUndefined();
  expect(await s.get<boolean>("folders/img")).toBe(true);
  expect(await s.get("folders/nope")).toBeUndefined();
  expect([...(await s.list({ prefix: "files/" })).keys()]).toEqual(["files/img/a.png", "files/index.html"]);
  expect([...(await s.list({ prefix: "files/img/" })).keys()]).toEqual(["files/img/a.png"]);
  expect([...(await s.list({ prefix: "folders/" })).keys()]).toEqual(["folders/img"]);

  await s.put("files/new.txt", new TextEncoder().encode("new"));
  expect(f.text("new.txt")).toBe("new");
  await s.put({ info: { id: "x" }, "files/two.txt": new TextEncoder().encode("two") });
  expect(f.text("two.txt")).toBe("two");
  expect(inner.data.get("info")).toEqual({ id: "x" });
  expect(f.disk.has("info")).toBe(false);
  expect(await s.get<{ id: string }>("info")).toEqual({ id: "x" });
  await s.put("folders/docs", true);
  expect(f.folders.has("docs")).toBe(true);
  expect(await s.delete("files/two.txt")).toBe(true);
  expect(await s.delete("files/two.txt")).toBe(false);
  expect(await s.delete(["files/new.txt", "info", "files/nope"])).toBe(2);
  expect(f.disk.has("new.txt")).toBe(false);
  expect(inner.data.has("info")).toBe(false);
  await s.delete("folders/img");
  expect(f.folders.has("img")).toBe(false);
  expect(f.disk.has("img/a.png")).toBe(false);

  // Everything in one list, in key order, after a key, at most a limit.
  await inner.put({ "room-state": new Uint8Array([1]), "versions/head": 1 });
  expect([...(await s.list()).keys()]).toEqual(["files/index.html", "folders/docs", "room-state", "versions/head"]);
  expect([...(await s.list({ startAfter: "files/index.html", limit: 2 })).keys()]).toEqual(["folders/docs", "room-state"]);
  expect([...(await s.list({ prefix: "versions/" })).keys()]).toEqual(["versions/head"]);

  // The alarm and deleteAll are the wrapped storage's; the files stay.
  await s.setAlarm(Date.now() + 60_000);
  expect(await inner.getAlarm()).not.toBeNull();
  await s.deleteAll();
  expect(inner.data.size).toBe(0);
  expect(f.disk.has("index.html")).toBe(true);
  await s.deleteAlarm();

  // What the dev server says reaches the link's owner.
  f.socket.changed("index.html");
  expect(changed).toEqual(["index.html"]);
});

test("a single file linked on its own: it is the one file; another path stays off the disk", async () => {
  const f = folder({ "notes.md": "# Notes", "other.md": "other" });
  const link = new DiskLink({ changed: () => {}, connected: () => {}, flush: async () => {} });
  link.accept(f.socket as unknown as WebSocket);
  const s = link.storage(new MemoryStorage(), "notes.md");
  expect([...(await s.list({ prefix: "files/" })).keys()]).toEqual(["files/notes.md"]);
  expect(await s.get("files/other.md")).toBeUndefined();
  expect([...(await s.list({ prefix: "folders/" })).keys()]).toEqual([]);
  await s.put("files/beside.md", new TextEncoder().encode("beside"));
  expect(f.disk.has("beside.md")).toBe(false);
  expect(await s.delete("files/other.md")).toBe(false);
  expect(f.disk.has("other.md")).toBe(true);
  await s.put("files/notes.md", new TextEncoder().encode("# Notes, edited"));
  expect(f.text("notes.md")).toBe("# Notes, edited");
});

test("the room's file store over it reads, writes and removes on the folder, and notes each change", async () => {
  const f = folder({ "index.html": "<h1>One</h1>" }, []);
  const link = new DiskLink({ changed: () => {}, connected: () => {}, flush: async () => {} });
  link.accept(f.socket as unknown as WebSocket);
  const s = link.storage(new MemoryStorage(), null);
  let touched = 0;
  const files = fileStoreOf(s, { touch: async () => { touched++; } });
  expect(await Effect.runPromise(files.list)).toEqual(["index.html"]);
  await Effect.runPromise(files.write("index.html", "<h1>Two</h1>"));
  expect(f.text("index.html")).toBe("<h1>Two</h1>");
  await Effect.runPromise(files.mkdir!("a/b"));
  expect([...f.folders]).toEqual(["a", "a/b"]);
  await Effect.runPromise(files.writeBytes!("a/b/x.bin", new Uint8Array([1, 2])));
  expect([...f.disk.get("a/b/x.bin")!]).toEqual([1, 2]);
  expect(await Effect.runPromise(files.folders!)).toEqual(["a", "a/b"]);
  await Effect.runPromise(files.rmdir!("a"));
  expect(f.disk.has("a/b/x.bin")).toBe(false);
  expect(f.folders.has("a")).toBe(false);
  await Effect.runPromise(files.remove!("index.html"));
  expect(f.disk.size).toBe(0);
  // write, mkdir, writeBytes, rmdir and remove each count as a change to the document.
  expect(touched).toBe(5);
});
