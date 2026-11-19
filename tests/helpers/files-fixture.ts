// A document on MemoryStorage with MemoryBlobs, as the blob and file tool tests use it: the real directory on
// bun:sqlite, and the Worker's way to serve what the document answers (a blob pointer becomes the blob's bytes).

import * as Effect from "effect/Effect";
import { type DocumentDeps } from "../../document/life/document";
import { DocumentHost } from "../../document/api/host";
import { MemoryBlobs, serveBlob } from "../../document/store/blobs";
import { MemoryStorage } from "../../document/store/storage";
import { Directory } from "../../server/directory/index.ts";
import { testSandbox } from "./sandbox";
import { promised } from "./promised";
import { memory } from "./memory-sql";

/** A document on memory with a blob store, and the Worker's way to serve what it answers. */
export async function setup(o: { blobs?: boolean; test?: boolean } = {}) {
  const dir = new Directory(memory(), { admins: ["ada"] });
  const blobs = new MemoryBlobs();
  const storage = new MemoryStorage();
  const log: string[] = [];
  const deps: DocumentDeps = {
    storage, directory: dir,
    tabs: { count: () => 0, closeAll: () => {} },
    sandbox: testSandbox,
    descriptionKey: async () => "",
    sites: { forget: async () => {} },
    timing: { idleMs: 40, maxMs: 400, writeDelay: 10 },
    background: (w) => { void w.catch(() => {}); },
    log: (line) => log.push(line),
    ...(o.blobs === false ? {} : { blobs }),
  };
  await dir.add({ id: "doc12345", owner: "ada", title: "Files", created: Date.now(), expires: null });
  const doc = promised(new DocumentHost(deps));
  // A test document's agent is the scripted one (no key needed).
  await doc.create("ada", "doc12345", { "index.html": "<h1>Files</h1>" }, "index.html", { expires: null, modified: Date.now(), ...(o.test ? { test: true } : {}) });
  const as = (headers: Record<string, string> = {}) => ({ "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }), "x-erga-who": JSON.stringify({ login: "ada" }), ...headers });
  /** A GET as the Worker makes it: a blob pointer becomes the blob's bytes. */
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const request = new Request(`http://doc${path}`, { headers: as(headers) });
    const answer = await doc.handle(request);
    return (await Effect.runPromise(serveBlob(answer, request, deps.blobs ?? null))) ?? answer;
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

