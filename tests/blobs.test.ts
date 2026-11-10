// A document's files that aren't text, as blobs (document/blobs.ts): one
// document on MemoryStorage with MemoryBlobs, uploaded to, served, versioned,
// moved, restored and copied. R2 is the only place a blob's bytes are.

import * as Effect from "effect/Effect";
import { expect, test } from "bun:test";
import { BLOB_HEADER, OBJECT_MAX } from "../document/blobs";
import { sha256Hex } from "../shared/bytes";
import { KEYS, MemoryStorage } from "../document/storage";
import { Document } from "../document/document";
import { promised } from "./helpers/promised";
import { bytesOf, setup } from "./helpers/files-fixture";
import { until } from "./helpers/until";
import { files } from "../document/content";
import type { Room } from "../document/room";

/** The version that holds `path`: cut once the edits pause. */
const versionWith = (doc: Awaited<ReturnType<typeof setup>>["doc"], path: string) =>
  until(async () => {
    const v = (await doc.version((await doc.versionsState())!.current.n))!;
    return v.files.includes(path) ? v : null;
  });

test("an upload over 2 MB is a blob: only its ref in the object, served by hash with ranges, and in the versions by hash", async () => {
  const { doc, blobs, storage, get, put } = await setup();
  const pdf = bytesOf(3_000_000);
  const hash = await sha256Hex(pdf);
  const r = await put("receipts/tax.pdf", pdf);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, path: "receipts/tax.pdf", kind: "file", size: pdf.length, hash, replaced: false });
  expect(blobs.data.get(hash)).toEqual(pdf);
  // The object keeps its ref, not its bytes (they'd pass a value's 2 MiB).
  expect(storage.data.get(KEYS.ref + "receipts/tax.pdf")).toMatchObject({ hash, size: pdf.length });
  expect(storage.data.has(KEYS.file + "receipts/tax.pdf")).toBe(false);
  expect(await doc.paths()).toEqual(["index.html", "receipts/tax.pdf"]);

  // The document answers with a pointer; the Worker sends the blob.
  const pointer = await doc.handle(new Request("http://doc/doc/receipts/tax.pdf", { headers: { "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-who": JSON.stringify({ login: "ada" }) } }));
  expect(pointer.headers.get(BLOB_HEADER)).toBe(hash);
  expect((await pointer.arrayBuffer()).byteLength).toBe(0);
  const whole = await get("/doc/receipts/tax.pdf");
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-type")).toBe("application/pdf");
  expect(whole.headers.get("etag")).toBe(`"${hash}"`);
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(pdf);
  const part = await get("/doc/receipts/tax.pdf", { range: "bytes=100-199" });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 100-199/${pdf.length}`);
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(pdf.subarray(100, 200));
  expect((await get("/doc/receipts/tax.pdf", { "if-none-match": `"${hash}"` })).status).toBe(304);
  expect((await get("/doc/receipts/tax.pdf", { range: `bytes=${pdf.length}-` })).status).toBe(416);

  // A version has it by its hash, with no copy of its bytes in the object.
  const v = await versionWith(doc, "receipts/tax.pdf");
  expect(storage.data.has("blobs/" + hash)).toBe(false);
  expect(await doc.versionFile(v.n, "receipts/tax.pdf")).toEqual(pdf);
});

test("a small upload is a blob too: only its ref in the object, and in the versions only in the blob store", async () => {
  const { doc, storage, blobs, get, put } = await setup();
  const png = bytesOf(5_000, 3);
  const hash = await sha256Hex(png);
  expect((await (await put("logo.png", png)).json()).kind).toBe("file");
  expect(storage.data.has(KEYS.file + "logo.png")).toBe(false);
  expect(storage.data.get(KEYS.ref + "logo.png")).toMatchObject({ hash });
  expect(new Uint8Array(await (await get("/doc/logo.png")).arrayBuffer())).toEqual(png);
  await versionWith(doc, "logo.png");
  expect(storage.data.has("blobs/" + hash)).toBe(false);
  expect(blobs.data.get(hash)).toEqual(png);
});

test("a new document's image is a blob from the start; a copy left in the object is never read", async () => {
  const { doc, storage, blobs, get } = await setup();
  const png = bytesOf(3_000, 23);
  const hash = await sha256Hex(png);
  const made = await setup();
  const storage2 = new MemoryStorage();
  const fresh = promised(new Document({ ...made.deps, storage: storage2 }));
  expect(
    await fresh.create("ada", "new12345", { "index.html": "<h1>New</h1>", "logo.png": png }, "index.html", {
      expires: null,
      modified: Date.now(),
    })
  ).toBe(true);
  expect(storage2.data.has(KEYS.file + "logo.png")).toBe(false);
  expect(storage2.data.get(KEYS.ref + "logo.png")).toMatchObject({ hash, size: png.length });
  expect(made.blobs.data.get(hash)).toEqual(png);
  // A copy an older server kept beside the ref: the blob store's bytes are the file's.
  await doc.publish({ "p.png": png }, []);
  storage.data.set(KEYS.file + "p.png", bytesOf(3_000, 99));
  expect(new Uint8Array(await (await get("/doc/p.png")).arrayBuffer())).toEqual(png);
  // Without the blob in the store, the file isn't found: nothing else has its bytes.
  blobs.data.delete(hash);
  expect((await get("/doc/p.png")).status).toBe(404);
});

test("a text file arrives as text; a second upload replaces the first, and says so", async () => {
  const { doc, put, get } = await setup();
  expect(await (await put("notes.md", "# One")).json()).toEqual({ ok: true, path: "notes.md", kind: "text", size: 5, replaced: false });
  expect(await (await put("notes.md", "# Two")).json()).toMatchObject({ kind: "text", replaced: true });
  expect(await (await get("/doc/notes.md")).text()).toBe("# Two");
  // A text file's name with bytes that aren't UTF-8: a blob.
  expect((await (await put("data.csv", new Uint8Array([0xff, 0xfe, 0x00]))).json()).kind).toBe("file");
  // A blob replaced by text becomes text: a file changes kind only when it's replaced whole.
  expect((await (await put("data.csv", "a,b\n1,2\n")).json())).toMatchObject({ kind: "text", replaced: true });
  expect(await (await get("/doc/data.csv")).text()).toBe("a,b\n1,2\n");
  expect((await Effect.runPromise(doc.self.call((c) => c.files())))!.files.find((f) => f.path == "data.csv")!.kind).toBe("text");
  expect(await doc.paths()).toEqual(["data.csv", "index.html", "notes.md"]);
});

test("uploads past the limits are refused, with the setting that says so", async () => {
  const { dir, put, storage } = await setup();
  await dir.config.set({ login: "ada", admin: true }, "max_file_mb", 1);
  const big = await put("big.bin", bytesOf(1_500_000));
  expect(big.status).toBe(413);
  expect((await big.json()).error).toContain("max_file_mb");
  await dir.config.set({ login: "ada", admin: true }, "max_file_mb", 100);
  await dir.config.set({ login: "ada", admin: true }, "max_project_gb", 1);
  // The project has 950 MB already (a blob's ref says its size); 60 MB more passes 1 GB. (Refused before the body is read.)
  storage.data.set(KEYS.ref + "old.bin", { hash: "a".repeat(64), size: 950_000_000, at: 1 });
  const huge = await put("huge.bin", bytesOf(100), { "content-length": String(60_000_000) });
  expect(huge.status).toBe(413);
  expect((await huge.json()).error).toContain("max_project_gb");
  // A viewer may not upload.
  const asViewer = await put("x.bin", bytesOf(10), { "x-erga-who": JSON.stringify({ login: "bob" }) });
  expect(asViewer.status).toBe(403);
  // Nor may a file go inside a file, or take a folder's place.
  await put("a.bin", bytesOf(10));
  expect((await put("a.bin/b.bin", bytesOf(10))).status).toBe(409);
  await put("dir/c.bin", bytesOf(10));
  expect((await put("dir", bytesOf(10))).status).toBe(409);
});

test("a big upload streams with its hash given, and a wrong hash stores nothing", async () => {
  const { blobs, put } = await setup();
  const video = bytesOf(4_000_000, 11);
  const hash = await sha256Hex(video);
  const had = blobs.data.size;
  const wrong = await put("clip.mp4", video, { "x-erga-sha256": "0".repeat(64) });
  expect(wrong.status).toBe(400);
  expect(blobs.data.size).toBe(had);
  const ok = await put("clip.mp4", video, { "x-erga-sha256": hash });
  expect(await ok.json()).toMatchObject({ ok: true, hash, size: video.length });
  expect(blobs.data.get(hash)).toEqual(video);
});

test("a blob moves by its ref, is deleted with its file, and comes back with a restore", async () => {
  const { doc, storage, blobs, put, get } = await setup();
  const pdf = bytesOf(2_500_000, 5);
  await put("a.pdf", pdf);
  const before = (await versionWith(doc, "a.pdf")).n;
  expect((await Effect.runPromise(doc.self.call((c) => c.treeOp({ op: "move", from: "a.pdf", to: "docs/b.pdf" }))))!.ok).toBe(true);
  expect(storage.data.has(KEYS.ref + "a.pdf")).toBe(false);
  expect(storage.data.get(KEYS.ref + "docs/b.pdf")).toMatchObject({ hash: await sha256Hex(pdf) });
  expect(new Uint8Array(await (await get("/doc/docs/b.pdf")).arrayBuffer())).toEqual(pdf);
  expect((await Effect.runPromise(doc.self.call((c) => c.treeOp({ op: "delete", path: "docs/b.pdf" }))))!.ok).toBe(true);
  expect(storage.data.has(KEYS.ref + "docs/b.pdf")).toBe(false);
  expect((await get("/doc/docs/b.pdf")).status).toBe(404);
  // The blob stays: a version has it.
  expect(blobs.data.has(await sha256Hex(pdf))).toBe(true);
  const r = await doc.restore(before, "ada");
  expect(r.ok).toBe(true);
  expect(new Uint8Array(await (await get("/doc/a.pdf")).arrayBuffer())).toEqual(pdf);
});

test("a text file that grows past 2 MB in edits stays text; its stored copy goes to the blob store", async () => {
  const { doc, storage, blobs, get } = await setup();
  const big = "<p>" + "x".repeat(OBJECT_MAX + 10) + "</p>";
  await doc.publish({ "index.html": "<h1>Small</h1>" }, []);
  // An edit (here a publish of the whole text, merged into the room as an edit is) that takes it past the limit.
  // The room as a tab sees it: its text, edited in place.
  const opened = await (doc as unknown as { room(): Promise<{ room: Room } > }).room();
  const edit = (text: string) => { const t = files(opened.room.doc).get("index.html")!; opened.room.doc.transact(() => { t.delete(0, t.length); t.insert(0, text); }); };
  edit(big);
  await doc.flush();
  expect(opened.room.text("index.html")).toBe(big);
  expect(storage.data.has(KEYS.file + "index.html")).toBe(false);
  const ref = storage.data.get(KEYS.ref + "index.html") as { hash: string };
  expect(blobs.data.has(ref.hash)).toBe(true);
  expect(await (await get("/doc/index.html")).text()).toBe(big);
  // Back under the limit: its copy is in the object again, and the ref goes.
  edit("<h1>Small again</h1>");
  await doc.flush();
  expect(storage.data.has(KEYS.ref + "index.html")).toBe(false);
  expect(new TextDecoder().decode(storage.data.get(KEYS.file + "index.html") as Uint8Array)).toBe("<h1>Small again</h1>");
});

test("a copy of a document takes its blobs by their refs", async () => {
  const { doc, put } = await setup();
  const pdf = bytesOf(2_200_000, 19);
  await put("a.pdf", pdf);
  const snap = (await doc.snapshot())!;
  expect(snap.files["index.html"]).toBe("<h1>Files</h1>");
  expect(snap.files["a.pdf"]).toMatchObject({ hash: await sha256Hex(pdf), size: pdf.length });
});
