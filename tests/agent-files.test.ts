// The agent's tools on every file (agents/document/session.ts, through the document's /api/tools/<name>, as the server
// runs them for an agent): read gives a PDF (a range of its pages) and an image, write takes bytes, ls says each file's kind, size and
// time, grep searches PDFs through their text (extracted once, kept by the PDF's hash), edit refuses a file kept whole,
// and someone who may only view has the tools that change nothing.

import * as Effect from "effect/Effect";
import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { sha256Hex } from "../shared/bytes";
import { person, server, tool as overHttp } from "./helpers/app";
import { bytesOf, pdf, setup } from "./helpers/files-fixture";
import { until } from "./helpers/until";

type Content = { type: string; text?: string; data?: string; mimeType?: string };

/** A document, its files, and its tools as an agent token's person calls them. */
async function withTools() {
  const s = await setup();
  await s.doc.setPermissions([{ login: "ada", role: "owner" }, { login: "bob", role: "viewer" }]);
  const as = (who: string) => ({ "x-erga-person": JSON.stringify({ id: who, name: who }), "x-erga-who": JSON.stringify({ login: who }), "x-erga-agent": "token-1" });
  const tool = async (name: string, args: object, who = "ada") => {
    const r = await s.doc.handle(
      new Request(`http://doc/api/tools/${name}`, {
        method: "POST",
        body: JSON.stringify(args),
        headers: { "content-type": "application/json", ...as(who) },
      })
    );
    const body = (await r.json()) as { ok: boolean; content?: Content[]; error?: string };
    return {
      status: r.status,
      ok: body.ok,
      content: body.content ?? [],
      text: (body.content ?? [])
        .filter((c) => c.type == "text")
        .map((c) => c.text)
        .join("\n"),
      error: body.error ?? "",
    };
  };
  return { ...s, tool };
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

test("the files' list (ls) gives each file's kind, type, size and time; edit refuses a file kept whole", async () => {
  const { tool, put, doc } = await withTools();
  await put("receipts/a.pdf", pdf("A"));
  await put("receipts/notes.md", "# Notes");
  const list = (await Effect.runPromise(doc.self.call((c) => c.files())))!;
  const a = list.files.find((f) => f.path == "receipts/a.pdf")!;
  expect(a).toMatchObject({ kind: "file", type: "application/pdf" });
  expect(a.size).toBeGreaterThan(0);
  expect(a.at).toBeGreaterThan(0);
  expect(list.files.find((f) => f.path == "receipts/notes.md")).toMatchObject({ kind: "text", size: 7 });
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
  expect(JSON.parse(blobs.keptValues.get(`pdf-text/${await sha256Hex(goodwill)}`)!)).toEqual([
    "Goodwill Industries",
    "Charitable contribution receipt",
  ]);
  await put("copy/goodwill.pdf", goodwill);
  expect((await tool("grep", { pattern: "contribution", glob: "copy/*.pdf" })).text).toBe("copy/goodwill.pdf:2: Charitable contribution receipt");
});

test("someone who may only view has the tools that change nothing: read, find and grep work; write is refused", async () => {
  const { tool, put } = await withTools();
  await put("a.pdf", pdf("Shared"));
  expect((await tool("grep", { pattern: "Shared" }, "bob")).text).toBe("a.pdf:1: Shared");
  const w = await tool("write", { path: "x.md", content: "x" }, "bob");
  expect(w.ok).toBe(false);
  expect(w.error).toContain("can only view this document");
});

// On the whole app in memory (tests/helpers/app.ts): versions is the server's operation, read with version the document's.
// The edits are publishes with the person's token: a version is cut once they pause. (The tools of the token would hold
// the cut back 8 seconds, as an agent's turn does: no tool is called before the versions are there.)
test("versions lists them, and read with version reads an old file; there's no publish_version", async () => {
  const s = server();
  const owner = await person(s);
  const document = await owner.make();
  const token = await owner.token("versions test");
  const tool = (name: string, args: Record<string, unknown>) => overHttp(s, token, name, { document, ...args });
  const total = async () => (JSON.parse((await tool("versions", {})).text) as { versions: unknown[] }).versions.length;
  let page = await (await owner.get(`/d/${document}/doc/index.html`)).text();
  for (const [n, word] of [" alpha", " beta"].entries()) {
    page = page.replace("</h1>", `${word}</h1>`);
    const sent = await s.fetch("/api/publish", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ document, files: { "index.html": page } }),
    });
    expect(sent.status).toBe(200);
    await until(async () => (await total()) == n + 2);
  }
  let t = await tool("versions", {});
  expect(t.status).toBe(200);
  const listing = JSON.parse(t.text) as { current: { id: string }; versions: { id: string; description: string }[] };
  expect(listing.current.id).toBe("v3");
  expect(listing.versions.find((v) => v.id == "v2")?.description).toBe("Edited index.html");
  expect(t.text).not.toContain("Published");
  t = await tool("read", { version: "v2", path: "index.html" });
  expect(t.status).toBe(200);
  expect(t.text).toContain("alpha");
  expect(t.text).not.toContain("beta");
  // One element of it, as read takes it from the file as it is now.
  t = await tool("read", { version: "v2", path: "index.html", selector: "h1" });
  expect(t.text).toMatch(/^\[index\.html, line \d+: the element "h1"\]\n<h1>.*alpha<\/h1>$/);
  t = await tool("read", { version: "v2", path: "nope.html" });
  expect([t.status, t.text]).toEqual([400, "v2 has no file nope.html. Its files: index.html"]);
  t = await tool("publish_version", { mode: "manual", version: "v3" });
  expect(t.status).not.toBe(200);
  const listed = (await (await s.fetch("/api/tools", { headers: { Authorization: `Bearer ${token}` } })).json()) as {
    tools: { name: string; parameters: { properties: { op: { description: string } } } }[];
  };
  const ops = listed.tools.flatMap((x) => x.parameters.properties.op.description.split("\n").map((l: string) => l.split("(")[0]));
  expect(ops).toContain("restore_version");
  expect(ops).not.toContain("publish_version");
});
