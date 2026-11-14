// An agent's file on its own disk (document/waits.ts): its write names the bytes' sha-256 and size and waits, and a
// PUT with no session brings the bytes. The waits' state machine alone, then the whole app in memory, as an outside
// agent uses it: the tool over MCP, the bytes as its shell sends them.

import { expect, setSystemTime, test } from "bun:test";
import { step, WAIT_MINUTES, type Waits, type Writer } from "../document/waits";
import { TEXT_MAX } from "../document/blobs";
import { sha256Hex } from "../shared/bytes";
import { mcp, mint, person, server, signedOut, tool, type Server } from "./helpers/app";

const ada: Writer = { who: { login: "ada", via: "Claude Code" }, name: "Ada", origin: "https://erga.dev" };
const MINUTE = 60_000;

test("a wait: a write starts it, its bytes end it one time, and it ends by itself; another server's bytes aren't its", () => {
  const a = { hash: "a".repeat(64), size: 3 };
  let waits: Waits = step(
    {},
    { on: "write", files: { "a.png": a, "copy/a.png": a, "b.png": { hash: "b".repeat(64), size: 9 } }, by: ada, now: 0 }
  ).waits;
  expect(Object.keys(waits)).toEqual(["a.png", "copy/a.png", "b.png"]);
  expect(waits["a.png"]).toEqual({ ...ada, ...a, until: WAIT_MINUTES * MINUTE });
  // A copy of the document on another server (staging's) takes no bytes for it.
  expect(step(waits, { on: "bytes", hash: a.hash, origin: "https://staging.erga.dev", now: 1 }).put).toEqual([]);
  // The bytes: every path that waits for them, and they wait no more.
  const came = step(waits, { on: "bytes", hash: a.hash, origin: ada.origin, now: MINUTE });
  expect(came.put.map(([path, w]) => `${path} by ${w.who.login}`)).toEqual(["a.png by ada", "copy/a.png by ada"]);
  expect(Object.keys(came.waits)).toEqual(["b.png"]);
  expect(step(came.waits, { on: "bytes", hash: a.hash, origin: ada.origin, now: MINUTE }).put).toEqual([]);
  // A newer write of the path takes the wait's place, with a time of its own.
  waits = step(came.waits, { on: "write", files: { "b.png": { hash: "c".repeat(64), size: 5 } }, by: ada, now: 10 * MINUTE }).waits;
  expect(step(waits, { on: "bytes", hash: "b".repeat(64), origin: ada.origin, now: 11 * MINUTE }).put).toEqual([]);
  // Past its time, it is gone at the next event.
  const late = step(waits, { on: "bytes", hash: "c".repeat(64), origin: ada.origin, now: (10 + WAIT_MINUTES) * MINUTE });
  expect([late.put, late.waits]).toEqual([[], {}]);
});

/** Bytes that are no text, `n` of them. */
const bytesOf = (n: number, seed = 7) => {
  const b = new Uint8Array(n);
  for (let i = 0, x = seed; i < n; i++) b[i] = (x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16;
  b[0] = 0xff;
  return b;
};

/** An agent's write of `files` over MCP (the edit tool, op write): the answer's JSON. */
async function write(s: Server, token: string, document: string, files: Record<string, unknown>) {
  const r = await mcp(s, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "edit", arguments: { op: "write", document, files } },
  });
  return JSON.parse(r.body.result.content[0].text) as {
    written: string[];
    refused: { path: string; why: string }[];
    waiting?: string[];
    upload?: string;
  };
}

/** The bytes as an agent's shell sends them (curl -T): no session, no token. `length`: another Content-Length than theirs. */
async function send(s: Server, id: string, hash: string, bytes: Uint8Array<ArrayBuffer>, length = bytes.length) {
  const r = await s.fetch(`/d/${id}/api/blobs/${hash}`, {
    method: "PUT",
    body: bytes,
    headers: { ...signedOut(), "content-length": String(length) },
  });
  return { status: r.status, ...((await r.json()) as { ok: boolean; written?: string[]; error?: string }) };
}

async function setup(o: { staging?: boolean } = {}) {
  const s = server(o);
  // (On a server for admins only, the dev login: its admin.)
  const p = o.staging ? null : await person(s);
  const token = p ? await p.token() : (await mint(s, null, { label: "Agent", scope: "documents" })).token;
  const id = (await tool(s, token, "create_document", { template: "page", title: "Shots" })).data.id as string;
  const file = async (path: string) => {
    const r = await s.fetch(`/d/${id}/doc/${path}`, p ? { headers: { Cookie: p.cookie } } : {});
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : r.status;
  };
  return { s, p, token, id, file };
}

test("an agent's write of a file on its disk waits for the bytes; a PUT with no session brings them, one time, and only those bytes", async () => {
  const { s, p, token, id, file } = await setup();
  const png = bytesOf(350_000);
  const hash = await sha256Hex(png);
  // No write waits: it answers before it reads (the body here has no end to read to).
  const none = await s.fetch(`/d/${id}/api/blobs/${hash}`, {
    method: "PUT",
    body: new ReadableStream({ pull() {} }),
    headers: signedOut(),
    duplex: "half",
  } as RequestInit);
  expect(none.status).toBe(404);
  // (A document that isn't there answers the same: the address tells nothing of one.)
  expect(await (await s.fetch(`/d/zzzzzzzz/api/blobs/${hash}`, { method: "PUT", headers: signedOut() })).text()).toBe(await none.text());
  // A new document takes no such file: its answer says the way.
  const made = await tool(s, token, "create_document", {
    files: { "index.html": "<p>Hi</p>", "shot.png": { blob: hash, size: png.length } },
  });
  expect([made.ok, made.text]).toEqual([
    false,
    `shot.png: a new document takes no {"blob"}. Make it without this file, then add the file with edit's write.`,
  ]);
  // Without its size, the write doesn't wait.
  expect((await write(s, token, id, { "images/shot.png": { blob: hash } })).refused[0].why).toContain("give its size in bytes too");
  const waited = await write(s, token, id, {
    "images/shot.png": { blob: hash, size: png.length },
    "copy/shot.png": { blob: hash, size: png.length },
  });
  expect([waited.written, waited.refused, waited.waiting]).toEqual([[], [], ["images/shot.png", "copy/shot.png"]]);
  expect(waited.upload).toContain(`curl -T <file> ${p!.origin}/d/${id}/api/blobs/<its sha-256>`);
  expect(await file("images/shot.png")).toBe(404);
  // Another size, more bytes than the Content-Length says, other bytes of the same size: refused, and the write still waits.
  expect((await send(s, id, hash, bytesOf(1000))).status).toBe(400);
  expect((await send(s, id, hash, bytesOf(2 * png.length), png.length)).status).toBe(400);
  expect((await send(s, id, hash, bytesOf(png.length, 8))).error).toContain("aren't the bytes the write named");
  expect(await file("images/shot.png")).toBe(404);
  // The bytes: each path that waited has them.
  expect(await send(s, id, hash, png)).toEqual({
    status: 200,
    ok: true,
    written: ["copy/shot.png", "images/shot.png"],
    size: png.length,
  } as never);
  expect(await file("images/shot.png")).toEqual(png);
  expect(await file("copy/shot.png")).toEqual(png);
  // One time: the address does nothing more, and the bytes of a wait that ended neither.
  expect((await send(s, id, hash, png)).status).toBe(404);
  const again = bytesOf(5000, 9);
  await write(s, token, id, { "late.bin": { blob: await sha256Hex(again), size: again.length } });
  setSystemTime(Date.now() + (WAIT_MINUTES + 1) * MINUTE);
  try {
    expect((await send(s, id, await sha256Hex(again), again)).status).toBe(404);
  } finally {
    setSystemTime();
  }
  expect(await file("late.bin")).toBe(404);
});

test("the bytes of any kind and size: a big file streams to the blob store, which checks it; a text file is text; the limits hold", async () => {
  const { s, token, id, file } = await setup();
  const big = bytesOf(TEXT_MAX + 1);
  const hash = await sha256Hex(big);
  await write(s, token, id, { "files/big.bin": { blob: hash, size: big.length } });
  const kept = s.blobs.data.size;
  expect((await send(s, id, hash, bytesOf(big.length, 8))).status).toBe(400);
  expect(s.blobs.data.size).toBe(kept);
  expect((await send(s, id, hash, big)).written).toEqual(["files/big.bin"]);
  expect(s.blobs.data.has(hash)).toBe(true);
  // A text file from disk is text, as any text that arrives whole (the page too).
  const html = new TextEncoder().encode("<!doctype html><title>From disk</title><h1>From disk</h1>");
  const page = await sha256Hex(html);
  expect((await write(s, token, id, { "index.html": { blob: page, size: html.length } })).waiting).toEqual(["index.html"]);
  expect((await send(s, id, page, html)).written).toEqual(["index.html"]);
  expect((await tool(s, token, "read", { document: id, path: "index.html" })).text).toContain("<h1>From disk</h1>");
  // Bytes that Erga keeps already (a version's): written at once, and a text is text still.
  const css = new TextEncoder().encode("h1 { color: teal }");
  await s.blobs.put(await sha256Hex(css), css, css.length);
  expect((await write(s, token, id, { "kept.css": { blob: await sha256Hex(css), size: css.length } })).written).toEqual(["kept.css"]);
  expect((await tool(s, token, "ls", { document: id })).data.entries.find((f: { path: string }) => f.path == "kept.css").kind).toBe("text");
  // A file over the admin's limit never waits.
  const over = await write(s, token, id, { "files/over.bin": { blob: "0".repeat(64), size: 900_000_000_000 } });
  expect(over.refused[0].why).toContain("max_file_mb");
  expect(await file("files/over.bin")).toBe(404);
});

test("who may: only a write by someone who may edit waits, the bytes land only while they still may, and a document token's reach is its document", async () => {
  const { s, p, id, file } = await setup();
  const q = await person(s);
  const theirs = await q.token();
  const png = bytesOf(4000);
  const hash = await sha256Hex(png);
  const files = { "shot.png": { blob: hash, size: png.length } };
  // No access, and a viewer: no write, so no wait, and the bytes go nowhere.
  expect((await tool(s, theirs, "edit", { op: "write", document: id, files })).ok).toBe(false);
  await p!.share(id, q.login, "viewer");
  expect((await tool(s, theirs, "edit", { op: "write", document: id, files })).ok).toBe(false);
  expect((await send(s, id, hash, png)).status).toBe(404);
  // An editor's write waits; their share ends before the bytes come: refused.
  await p!.share(id, q.login, "editor");
  expect((await write(s, theirs, id, files)).waiting).toEqual(["shot.png"]);
  await p!.share(id, q.login, "none");
  const late = await send(s, id, hash, png);
  expect([late.status, late.error]).toEqual([403, `${q.login} can't edit this document now.`]);
  expect(await file("shot.png")).toBe(404);
  // A token for one document writes there, and nowhere else.
  const other = (await p!.tool("create_document", { template: "page", title: "Other" })).result.id as string;
  const one = (await mint(s, p!.cookie, { label: "One", scope: "document", doc: other })).token;
  expect((await tool(s, one, "edit", { op: "write", document: id, files })).ok).toBe(false);
  expect((await write(s, one, other, files)).waiting).toEqual(["shot.png"]);
  expect((await send(s, id, hash, png)).status).toBe(403);
  expect((await send(s, other, hash, png)).written).toEqual(["shot.png"]);
});

test("staging, for admins only: the bytes of an admin's write get in with no session, and nothing else of the address does", async () => {
  const { s, token, id, file } = await setup({ staging: true });
  const png = bytesOf(4000);
  const hash = await sha256Hex(png);
  expect((await send(s, id, hash, png)).status).toBe(404);
  expect((await s.fetch(`/d/${id}/api/blobs/${hash}`, { headers: signedOut() })).status).toBe(403);
  expect((await s.fetch(`/d/${id}/api/files/shot.png`, { method: "PUT", body: png, headers: signedOut() })).status).toBe(403);
  expect((await write(s, token, id, { "shot.png": { blob: hash, size: png.length } })).waiting).toEqual(["shot.png"]);
  expect((await send(s, id, hash, png)).written).toEqual(["shot.png"]);
  expect(await file("shot.png")).toEqual(png);
});
