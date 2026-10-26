// The agent's tools on every file, in the Worker as it runs (PDF.js and pdf-lib under workerd): over an agent token, the
// way an external agent calls them (/api/ext/tools) and over MCP: ls with kinds and sizes, grep through PDFs, read of a
// PDF as a document (an embedded resource over MCP), and write of bytes, which the files view then lists.
import { expect, servers, test, until, type Server } from "../../helpers/fixtures";
import { person } from "../versions/versions";

await servers.main();

/** A small PDF: one page for each line given. */
function pdf(...pages: string[]): Uint8Array {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (const line of pages) {
    const content = `BT /F1 18 Tf 72 720 Td (${line}) Tj ET`;
    kids.push(`${objs.length + 1} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objs.length + 2} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o.replace("FONT", String(objs.length))}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function owner(server: Server) {
  const ada = await person(server, `ada${crypto.randomUUID().slice(0, 6)}`);
  const { id, address } = await ada.newDoc();
  const token = await ada.token("Files test");
  const call = async (name: string, args: object) => {
    const r = await fetch(`${server.root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ document: id, ...args }) });
    const body = (await r.json()) as { ok: boolean; content?: { type: string; text?: string; data?: string; mimeType?: string }[]; error?: string };
    return { ...body, text: body.content?.filter((c) => c.type == "text").map((c) => c.text).join("\n") ?? body.error ?? "" };
  };
  const mcp = async (name: string, args: object) => {
    const r = await fetch(`${server.root}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { document: id, ...args } } }) });
    return ((await r.json()) as { result: { content: { type: string; text?: string; resource?: { mimeType: string; blob: string } }[]; isError?: boolean } }).result;
  };
  const put = (path: string, body: Uint8Array | string) => ada.get(`/d/${id}/api/files/${path}`, { method: "PUT", body: body as BodyInit });
  return { ada, id, address, call, mcp, put };
}

test("ls says each file's kind and size; grep finds words in PDFs, by page; read gives a PDF as a document, over the API and over MCP", async () => {
  const { call, mcp, put } = await owner(await servers.main());
  expect((await put("receipts/2026-03-goodwill.pdf", pdf("Goodwill Industries", "Charitable contribution receipt"))).status).toBe(200);
  expect((await put("receipts/2026-11-redcross.pdf", pdf("Thank you for your charitable gift"))).status).toBe(200);
  const ls = await call("ls", { path: "receipts" });
  expect(ls.ok).toBe(true);
  expect(ls.text).toMatch(/^file\s+\d+ B\s+\S+ \S+\s+2026-03-goodwill\.pdf {2}\(application\/pdf\)$/m);
  const grep = await call("grep", { pattern: "charitable", ignoreCase: true, glob: "receipts/*.pdf" });
  expect(grep.text.split("\n")).toEqual([
    "receipts/2026-03-goodwill.pdf:2: Charitable contribution receipt",
    "receipts/2026-11-redcross.pdf:1: Thank you for your charitable gift",
  ]);
  const read = await call("read", { path: "receipts/2026-03-goodwill.pdf" });
  expect(read.text).toContain("2 pages (PDF");
  const doc = read.content!.find((c) => c.type == "document")!;
  expect(doc.mimeType).toBe("application/pdf");
  expect(atob(doc.data!).startsWith("%PDF-")).toBe(true);
  const over = await mcp("read", { path: "receipts/2026-03-goodwill.pdf" });
  expect(over.isError).toBeFalsy();
  const resource = over.content.find((c) => c.type == "resource")!.resource!;
  expect(resource.mimeType).toBe("application/pdf");
  expect(atob(resource.blob).startsWith("%PDF-")).toBe(true);
});

test("write of bytes makes a file kept whole, which the files view lists and serves", async () => {
  const server = await servers.main();
  const { ada, id, call } = await owner(server);
  const bytes = pdf("Written by the agent");
  const w = await call("write", { path: "made/agent.pdf", content_base64: Buffer.from(bytes).toString("base64") });
  expect(w.ok).toBe(true);
  expect(w.text).toContain("a file kept whole");
  const files = await until(async () => {
    const list = ((await (await ada.get(`/d/${id}/api/files`)).json()) as { files: { path: string; kind: string; size: number }[] }).files;
    return list.find((f) => f.path == "made/agent.pdf");
  }, 5000, "the files list has the agent's file");
  expect(files).toMatchObject({ kind: "file", size: bytes.length });
  expect(new Uint8Array(await (await ada.get(`/d/${id}/doc/made/agent.pdf`)).arrayBuffer())).toEqual(bytes);
  expect((await call("grep", { pattern: "agent", glob: "made/*.pdf" })).text).toBe("made/agent.pdf:1: Written by the agent");
});
