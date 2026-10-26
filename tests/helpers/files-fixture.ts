// A document on MemoryStorage with MemoryBlobs, as the blob and file tool tests use it: the real directory on
// bun:sqlite, and the Worker's way to serve what the document answers (a blob pointer becomes the blob's bytes).

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { Document, type DocumentDeps } from "../../document/document";
import { INLINE_HEADER, MemoryBlobs, serveBlob } from "../../document/blobs";
import { MemoryStorage } from "../../document/storage";
import { Directory, type Param, type Sql } from "../../server/directory/index.ts";
import { documentAgents } from "../../agents/document/session";

const MIGRATIONS = new URL("../../server/migrations/", import.meta.url).pathname;
function memory(): Sql {
  const db = new Database(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + f, "utf8"));
  return {
    all: async <T>(sql: string, ...params: Param[]) => db.query(sql).all(...(params as never[])) as T[],
    run: async (sql: string, ...params: Param[]) => { db.query(sql).run(...(params as never[])); },
    batch: async (statements) => { db.transaction(() => { for (const [sql, ...params] of statements) db.query(sql).run(...(params as never[])); })(); },
  };
}

/** A document on memory with a blob store, and the Worker's way to serve what it answers. */
export async function setup(o: { blobs?: boolean; test?: boolean } = {}) {
  const dir = new Directory(memory(), { admins: ["ada"] });
  const blobs = new MemoryBlobs();
  const storage = new MemoryStorage();
  const log: string[] = [];
  const deps: DocumentDeps = {
    storage, directory: dir,
    tabs: { count: () => 0, closeAll: () => {} },
    agents: documentAgents({ settings: async () => ({ missing: "no key in the tests" }) }),
    home: { forget: async () => {}, changed: async () => {} },
    timing: { idleMs: 40, maxMs: 400, writeDelay: 10 },
    background: (w) => { void w.catch(() => {}); },
    log: (line) => log.push(line),
    ...(o.blobs === false ? {} : { blobs }),
  };
  await dir.add({ id: "doc12345", owner: "ada", title: "Files", created: Date.now(), expires: null });
  const doc = new Document(deps);
  // A test document's agent is the scripted one (no key needed).
  await doc.create("ada", "doc12345", { "index.html": "<h1>Files</h1>" }, "index.html", { expires: null, modified: Date.now(), ...(o.test ? { test: true } : {}) });
  const as = (headers: Record<string, string> = {}) => ({ "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-who": JSON.stringify({ login: "ada" }), ...headers });
  /** A GET as the Worker makes it: a blob pointer becomes the blob's bytes. */
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const request = new Request(`http://doc${path}`, { headers: as(headers) });
    const answer = await doc.handle(request);
    const inline = () => doc.handle(new Request(request, { headers: { ...as(headers), [INLINE_HEADER]: "1" } }));
    return (await serveBlob(answer, request, deps.blobs ?? null, inline)) ?? answer;
  };
  const put = (path: string, body: Uint8Array | string, headers: Record<string, string> = {}) => {
    const bytes = typeof body == "string" ? new TextEncoder().encode(body) : body;
    return doc.handle(
      new Request(`http://doc/api/files/${path}`, {
        method: "PUT",
        body: bytes as Uint8Array<ArrayBuffer>,
        headers: as({ "content-length": String(bytes.length), ...headers }),
      })
    );
  };
  return { doc, dir, blobs, storage, log, get, put, deps };
}

export const bytesOf = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * seed + (i >> 8)) & 0xff);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


/** A small PDF: one page for each line given. */
export function pdf(...pages: string[]): Uint8Array {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (const line of pages) {
    const content = `BT /F1 18 Tf 72 720 Td (${line}) Tj ET`;
    const page = objs.length + 1;
    kids.push(`${page} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page + 1} 0 R /Resources << /Font << /F1 FONT 0 R >> >> >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const font = objs.length;
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o.replace("FONT", String(font))}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
