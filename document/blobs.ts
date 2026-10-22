// A document's files that aren't held as text: their bytes, by the sha256
// of the bytes (a "blob"). On Cloudflare they're in R2 (cloudflare/blobs.ts,
// the FILES bucket); the tests keep them in memory. A blob never changes:
// a new upload or write of a file makes a new blob, and the file points at
// it (`refs/<path>` in the document's storage: document/storage.ts). So the
// same bytes are stored once, for every file, document and version that
// has them, and the edge keeps a blob by its hash with no time limit.
//
// No blob is ever deleted yet. A sweep that deletes the blobs nothing
// refers to (no file, no version, no copy of a document) comes later.

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
/** The sha-256 of bytes, hex: a blob's hash, and a version's name for a file. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** A file's bytes as a blob: its hash (the sha256 of the bytes, hex), how many bytes, and when it was written (ms). */
export interface BlobRef { hash: string; size: number; at: number }

export const isBlobRef = (v: unknown): v is BlobRef =>
  !!v && typeof v == "object" && typeof (v as BlobRef).hash == "string" && /^[0-9a-f]{64}$/.test((v as BlobRef).hash) && typeof (v as BlobRef).size == "number";

/** Bytes of a blob, or a range of them. */
export interface BlobBody { body: ReadableStream<Uint8Array> | Uint8Array; size: number; range?: { start: number; end: number }; cached?: boolean }

/** Where blobs are. Every write names the hash, and the store checks the bytes against it. */
export interface BlobStore {
  /** Whether the store has the blob (its size), or null. */
  head(hash: string): Promise<{ size: number } | null>;
  /** The blob, or the bytes from `start` to `end` (inclusive); null if there's no such blob. */
  get(hash: string, range?: { start: number; end: number }): Promise<BlobBody | null>;
  /** The whole blob in memory, or null. */
  bytes(hash: string): Promise<Uint8Array | null>;
  /** Stores bytes under their hash: a stream must be `size` bytes long. Throws if the bytes aren't the hash's. */
  put(hash: string, data: Uint8Array | ReadableStream<Uint8Array>, size: number): Promise<void>;
  /** What was worked out from a blob once, kept by a key that names the blob's hash (a PDF's text: "pdf-text/<hash>"). */
  kept?: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
}

/**
 * The most bytes the Durable Object keeps in one value of its storage: a
 * text file's stored copy over this goes to the blob store instead, and a
 * blob up to this size is kept in the object too (`files/<path>`), so that
 * a Worker from before blobs still serves it after a rollback.
 */
export const OBJECT_MAX = 2_000_000;

/** The most bytes a file can have and still be text: a file that arrives whole bigger than this is a blob (D5: two kinds). */
export const TEXT_MAX = 2_000_000;

/** A blob's ref, for bytes in memory: their hash and size, written now. */
export async function refOf(bytes: Uint8Array, at = Date.now()): Promise<BlobRef> {
  return { hash: await sha256(bytes), size: bytes.length, at };
}

/** Stores bytes in `blobs` (once: a blob that's there isn't written again) and gives their ref. */
export async function storeBlob(blobs: BlobStore, bytes: Uint8Array, at = Date.now()): Promise<BlobRef> {
  const ref = await refOf(bytes, at);
  if (!(await blobs.head(ref.hash))) await blobs.put(ref.hash, bytes, bytes.length);
  return ref;
}

/** Blobs in memory, for the tests and local tools. */
export class MemoryBlobs implements BlobStore {
  readonly data = new Map<string, Uint8Array>();
  readonly keptValues = new Map<string, string>();
  readonly kept = {
    get: async (key: string) => this.keptValues.get(key) ?? null,
    put: async (key: string, value: string) => { this.keptValues.set(key, value); },
  };
  async head(hash: string) {
    const b = this.data.get(hash);
    return b ? { size: b.length } : null;
  }
  async get(hash: string, range?: { start: number; end: number }): Promise<BlobBody | null> {
    const b = this.data.get(hash);
    if (!b) return null;
    return range ? { body: b.subarray(range.start, range.end + 1), size: b.length, range } : { body: b, size: b.length };
  }
  async bytes(hash: string) {
    return this.data.get(hash) ?? null;
  }
  async put(hash: string, data: Uint8Array | ReadableStream<Uint8Array>, size: number) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer());
    if (bytes.length != size) throw new Error(`the blob is ${bytes.length} bytes, not ${size}`);
    if ((await sha256(bytes)) != hash) throw new Error("the bytes aren't the blob's: their sha256 differs");
    this.data.set(hash, bytes.slice());
  }
}

// ---------------------------------------------------------------- serving

/**
 * The headers a document's answer carries for a file that is a blob, in
 * place of its bytes: the Worker in front of it (cloudflare/platform.ts)
 * sends the blob itself, from the edge's cache or the blob store, so the
 * bytes never pass through the document's object.
 */
export const BLOB_HEADER = "x-erga-blob", BLOB_SIZE_HEADER = "x-erga-blob-size";
/** Asked of a document by the Worker when the blob store didn't have a blob: the bytes themselves, if the object keeps them. */
export const INLINE_HEADER = "x-erga-inline";

/** A document's answer for a blob: which blob, its size and type; no bytes. */
export function blobPointer(ref: BlobRef, type: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 200, headers: { [BLOB_HEADER]: ref.hash, [BLOB_SIZE_HEADER]: String(ref.size), "Content-Type": type, ...extra } });
}

/**
 * One range of a Range header ("bytes=0-", "bytes=100-199", "bytes=-500"),
 * clamped to the file's `size`; null to send the whole file (no range, a
 * header it doesn't understand, several ranges); "unsatisfiable" when it
 * starts past the end.
 */
export function byteRange(header: string, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] == "" && m[2] == "")) return null;
  if (m[1] == "") {
    const n = Number(m[2]);
    if (n == 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] == "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * The answer for `request` when the document answered with a blob pointer:
 * the blob's bytes (a Range of them: 206), or 304 for a browser that has
 * them (ETag: the hash; a blob never changes). The document's other
 * headers stay. `inline`: asks the document again for the bytes themselves,
 * when the blob store doesn't have the blob (a copy of the data that came
 * without it); null if the answer isn't a pointer.
 */
export async function serveBlob(answer: Response, request: Request, blobs: BlobStore | null, inline: () => Promise<Response>): Promise<Response | null> {
  const hash = answer.headers.get(BLOB_HEADER);
  if (!hash) return null;
  const size = Number(answer.headers.get(BLOB_SIZE_HEADER)) || 0;
  const headers = new Headers(answer.headers);
  headers.delete(BLOB_HEADER);
  headers.delete(BLOB_SIZE_HEADER);
  const etag = `"${hash}"`;
  headers.set("ETag", etag);
  headers.set("Accept-Ranges", "bytes");
  const type = (headers.get("content-type") ?? "application/octet-stream").split(";")[0];
  const timing = (more: string) => headers.set("Server-Timing", `file;desc="blob${more} type ${type}"`);
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") == etag)) {
    timing(" not modified");
    return new Response(null, { status: 304, headers });
  }
  const asked = request.headers.get("range");
  const r = asked ? byteRange(asked, size) : null;
  if (r == "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    timing(` bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const got = blobs ? await blobs.get(hash, r ?? undefined) : null;
  if (!got) return inline();
  // Where it came from, for page_network and for a person checking: the edge's cache, or the store.
  const from = got.cached ? "blob from the edge's cache" : "blob";
  const timed = (more: string) => headers.set("Server-Timing", `file;desc="${from}${more} type ${type}"`);
  const head = request.method == "HEAD";
  if (r) {
    const cr = `bytes ${r.start}-${r.end}/${got.size}`;
    headers.set("Content-Range", cr);
    headers.set("Content-Length", String(r.end - r.start + 1));
    timed(` ${cr}`);
    return new Response(head ? null : got.body as BodyInit, { status: 206, headers });
  }
  headers.set("Content-Length", String(got.size));
  timed(` bytes 0-${Math.max(0, got.size - 1)}/${got.size}`);
  return new Response(head ? null : got.body as BodyInit, { status: 200, headers });
}
