// The agent's tools on every file (editor-agent/session.ts, through the document's /api/ext, as an external agent calls
// them): read gives a PDF (a range of its pages) and an image, write takes bytes, ls says each file's kind, size and
// time, grep searches PDFs through their text (extracted once, kept by the PDF's hash), edit refuses a file kept whole,
// and someone who may only view has the tools that change nothing.

import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { sha256 } from "../document/blobs";
import { withDocuments } from "../agents/models";
import { withBlobs, GONE, type ChatSave, type ChatStore, type StoredChat } from "../agents/checkpoint";
import { MemoryBlobs } from "../document/blobs";
import { bytesOf, pdf, setup } from "./files-fixture";

type Content = { type: string; text?: string; data?: string; mimeType?: string };

/** A document, its files, and its tools as an agent token's person calls them. */
async function withTools() {
  const s = await setup();
  await s.doc.setPermissions([{ login: "ada", role: "owner" }, { login: "bob", role: "viewer" }]);
  const as = (who: string) => ({ "x-erga-person": JSON.stringify({ id: who, name: who }), "x-erga-who": JSON.stringify({ login: who }), "x-erga-agent": "token-1" });
  const tool = async (name: string, args: object, who = "ada") => {
    const r = await s.doc.handle(new Request(`http://doc/api/ext/tools/${name}`, { method: "POST", body: JSON.stringify(args), headers: { "content-type": "application/json", ...as(who) } }));
    const body = (await r.json()) as { ok: boolean; content?: Content[]; error?: string };
    return { status: r.status, ok: body.ok, content: body.content ?? [], text: (body.content ?? []).filter((c) => c.type == "text").map((c) => c.text).join("\n"), error: body.error ?? "" };
  };
  const tools = async (who = "ada") => ((await (await s.doc.handle(new Request("http://doc/api/ext/tools", { headers: as(who) }))).json()) as { tools: { name: string }[] }).tools.map((t) => t.name);
  return { ...s, tool, tools };
}

test("read gives a PDF as a document, a range of pages at a time, and an image as a picture", async () => {
  const { put, tool } = await withTools();
  const many = pdf(...Array.from({ length: 25 }, (_, i) => `Page ${i + 1} of the 1099-DIV`));
  expect((await put("1099-div.pdf", many)).status).toBe(200);
  const first = await tool("read", { path: "1099-div.pdf" });
  expect(first.ok).toBe(true);
  expect(first.text).toContain('1099-div.pdf: pages 1-20 of 25');
  expect(first.text).toContain('Read pages "21-25" for more.');
  const doc = first.content.find((c) => c.type == "document")!;
  expect(doc.mimeType).toBe("application/pdf");
  expect((await PDFDocument.load(Buffer.from(doc.data!, "base64"))).getPageCount()).toBe(20);
  const rest = await tool("read", { path: "1099-div.pdf", pages: "21-25" });
  expect((await PDFDocument.load(Buffer.from(rest.content.find((c) => c.type == "document")!.data!, "base64"))).getPageCount()).toBe(5);
  expect((await tool("read", { path: "1099-div.pdf", pages: "1-30" })).error).toContain("at most 20 at a time");
  expect((await tool("read", { path: "1099-div.pdf", pages: "40" })).error).toContain("page 40 isn't one of them");
  // A small PDF comes whole.
  await put("one.pdf", pdf("Just one page"));
  const one = await tool("read", { path: "one.pdf" });
  expect(one.text).toContain("one.pdf: 1 page (PDF");
  // An image as a picture.
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  await put("dot.png", png);
  expect((await tool("read", { path: "dot.png" })).content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  // Another kind of file: what it is.
  await put("data.zip", bytesOf(5000));
  expect((await tool("read", { path: "data.zip" })).text).toContain("data.zip is a file kept whole (application/zip, 5.0 KB)");
});

test("write takes bytes: a file kept whole (or text, if they're text), within the upload limits", async () => {
  const { tool, get, dir, doc } = await withTools();
  const bytes = bytesOf(3000, 29);
  const w = await tool("write", { path: "scans/receipt.bin", content_base64: Buffer.from(bytes).toString("base64") });
  expect(w.text).toBe("Wrote scans/receipt.bin (3.0 KB, a file kept whole).");
  expect(new Uint8Array(await (await get("/doc/scans/receipt.bin")).arrayBuffer())).toEqual(bytes);
  const again = await tool("write", { path: "scans/receipt.bin", content_base64: Buffer.from(bytesOf(10)).toString("base64") });
  expect(again.text).toStartWith("Replaced scans/receipt.bin");
  expect((await tool("write", { path: "notes.md", content_base64: Buffer.from("# Hi").toString("base64") })).text).toContain("as text");
  expect(await (await get("/doc/notes.md")).text()).toBe("# Hi");
  // One of the two, and base64.
  expect((await tool("write", { path: "x.bin" })).error).toContain("one of them");
  expect((await tool("write", { path: "x.bin", content_base64: "not base64!" })).error).toContain("isn't base64");
  // The limits an upload has.
  await dir.config.set({ login: "ada", admin: true }, "max_file_mb", 1);
  expect((await tool("write", { path: "big.bin", content_base64: Buffer.from(bytesOf(1_200_000)).toString("base64") })).error).toContain("max_file_mb");
  expect(await doc.paths()).not.toContain("big.bin");
});

test("ls gives each file's kind, size and time; edit refuses a file kept whole", async () => {
  const { tool, put } = await withTools();
  await put("receipts/a.pdf", pdf("A"));
  await put("receipts/notes.md", "# Notes");
  const ls = await tool("ls", { path: "receipts" });
  const [aLine, notesLine] = ls.text.split("\n");
  expect(aLine).toMatch(/^file\s+\d+ B\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+a\.pdf {2}\(application\/pdf\)$/);
  expect(notesLine).toMatch(/^text\s+7 B\s+.*notes\.md$/);
  expect((await tool("ls", {})).text).toMatch(/^dir\s+receipts\/$/m);
  const e = await tool("edit", { path: "receipts/a.pdf", edits: [{ oldText: "A", newText: "B" }] });
  expect(e.ok).toBe(false);
  expect(e.error).toContain("a file kept whole (not text), so it can't be edited");
});

test("grep searches PDFs through their text, page by page, extracted once and kept by the PDF's hash", async () => {
  const { tool, put, blobs } = await withTools();
  const goodwill = pdf("Goodwill Industries", "Charitable contribution receipt");
  await put("receipts/2026-03-goodwill.pdf", goodwill);
  await put("receipts/2026-11-redcross.pdf", pdf("Thank you for your charitable gift"));
  await put("receipts/other.pdf", pdf("Nothing to see"));
  const g = await tool("grep", { pattern: "charitable", ignoreCase: true, glob: "receipts/*.pdf" });
  expect(g.text.split("\n")).toEqual([
    "receipts/2026-03-goodwill.pdf:2: Charitable contribution receipt",
    "receipts/2026-11-redcross.pdf:1: Thank you for your charitable gift",
  ]);
  // Kept by the PDF's hash (for every isolate: in the blob store), so a copy of the same PDF elsewhere is the same text.
  expect(JSON.parse(blobs.keptValues.get(`pdf-text/${await sha256(goodwill)}`)!)).toEqual(["Goodwill Industries", "Charitable contribution receipt"]);
  await put("copy/goodwill.pdf", goodwill);
  expect((await tool("grep", { pattern: "contribution", glob: "copy/*.pdf" })).text).toBe("copy/goodwill.pdf:2: Charitable contribution receipt");
});

test("someone who may only view has the tools that change nothing: read, ls, find and grep work; write is refused", async () => {
  const { tool, tools, put } = await withTools();
  await put("a.pdf", pdf("Shared"));
  const mine = await tools("bob");
  for (const t of ["read", "ls", "find", "grep"]) expect(mine).toContain(t);
  for (const t of ["edit", "write", "mv", "rm", "mkdir", "new_page", "set_title", "restore_version"]) expect(mine).not.toContain(t);
  expect((await tools("ada"))).toContain("write");
  expect((await tool("grep", { pattern: "Shared" }, "bob")).text).toBe("a.pdf:1: Shared");
  const w = await tool("write", { path: "x.md", content: "x" }, "bob");
  expect(w.ok).toBe(false);
  expect(w.error).toContain("can only view this document");
});

test("the model gets a PDF as a document; a conversation keeps big pictures and PDFs in the blob store, by hash", async () => {
  const messages = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.pdf" }, { type: "image", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }] }] }];
  expect(withDocuments(messages)).toEqual([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.pdf" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }] }] }]);

  const blobs = new MemoryBlobs();
  let kept: StoredChat | null = null;
  const store: ChatStore = { load: async () => kept, save: async (c: ChatSave) => { kept = { messages: c.messages.items, log: [], state: c.state }; }, clear: async () => { kept = null; } };
  const big = Buffer.from(bytesOf(300_000)).toString("base64");
  const msg = { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "x" }, { type: "image", data: big, mimeType: "application/pdf" }], isError: false, timestamp: 1 };
  const state = { running: false, queued: [], calls: {}, model: null, stable: 0, meta: {}, at: 1 };
  const wrapped = withBlobs(store, blobs);
  await wrapped.save({ messages: { from: 0, items: [msg as never] }, log: { from: 0, items: [] }, state });
  // Stored by hash, not inline.
  const stored = (kept!.messages[0] as unknown as { content: { data?: string }[] }).content[1].data!;
  expect(stored).toStartWith("erga-blob:");
  expect(blobs.data.size).toBe(1);
  // Loaded whole again.
  expect(((await wrapped.load())!.messages[0] as unknown as { content: { data?: string }[] }).content[1].data).toBe(big);
  // Gone from the store: the model hears so.
  blobs.data.clear();
  expect(((await wrapped.load())!.messages[0] as unknown as { content: { text?: string }[] }).content[1].text).toBe(GONE);
});
