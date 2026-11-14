// Files that arrive whole: a publish (from the server's API), a PUT of one
// file (the editor's drop of a file, an HTTP client) and an agent's write of
// bytes. Each file's kind is decided as it arrives (D5): text goes into the
// room, anything else is a blob. The Document owns one Uploads.
//
// An agent's file on its own disk comes in two steps (waits.ts): its write names the bytes' sha-256 and size, and
// waits; a PUT /api/blobs/<sha-256> brings the bytes, with no session.
//
// Trap: that PUT is open to anyone. It must answer before it reads a byte unless a write waits for exactly that hash
// and Content-Length, read no more than the wait's size, and keep nothing but bytes of that hash.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerResponse } from "effect/http";
import { accessOf, personOf, viaOf, type Asker, type Role } from "./access.ts";
import { byLine } from "../shared/attribution.ts";
import { sha256Hex } from "../shared/bytes.ts";
import { isBlobRef, storeBlob, TEXT_MAX, type BlobRef } from "./blobs.ts";
import { files as texts, isTextPath } from "./content.ts";
import type { DocumentDeps, DocumentInfo, FileData } from "./document.ts";
import type { Opened } from "./open.ts";
import { cleanRel, pageRefusal, parentsOf } from "./pages.ts";
import { io, NoSuchDocument, type StoreError } from "./room.ts";
import { KEYS } from "./storage.ts";
import { NO_WAIT, step, waitingFor, type Wait, type WaitEvent, type Waits, type Writer } from "./waits.ts";

const { file: FILE, ref: REF, wait: WAIT } = KEYS;

/** What a publish did with each file. */
export interface Published {
  written: string[];
  removed: string[];
  refused: { path: string; why: string }[];
  /** Files whose write waits for its bytes (waits.ts), when there are some. */
  waiting?: string[];
}

/** A file that PUT /api/files refused: the status, and what to do about it. */
class UploadRefused extends Schema.TaggedError<UploadRefused>()("UploadRefused", { status: Schema.Number, error: Schema.String }) {}

/** A JSON answer that no cache keeps. */
const answer = (body: unknown, status: number) =>
  HttpServerResponse.toWeb(HttpServerResponse.jsonUnsafe(body, { status, headers: { "Cache-Control": "no-store" } }));

/** A file over this many bytes, uploaded without its hash, is refused (its bytes would be held in memory to hash them). */
const BUFFER_MAX = 25 * 1_000_000;
const MB = 1_000_000,
  GB = 1_000_000_000;
const megabytes = (n: number) => (n >= GB ? `${(n / GB).toFixed(2)} GB` : `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`);
/** Bytes as UTF-8 text; throws if they aren't. */
const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
/** Whether bytes that arrive whole are a text file (D5): a text file's name, at most TEXT_MAX bytes, and UTF-8. */
export const isText = (path: string, bytes: Uint8Array) => {
  if (!isTextPath(path) || bytes.length > TEXT_MAX) return false;
  try {
    utf8(bytes);
    return true;
  } catch {
    return false;
  }
};

/** A body's bytes, if it has exactly `size` of them: it reads no more than that. */
async function exactly(body: ReadableStream<Uint8Array> | null, size: number): Promise<Uint8Array | null> {
  const out = new Uint8Array(size);
  let n = 0;
  const reader = body?.getReader();
  for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
    if (n + part.value.length > size) {
      void reader!.cancel().catch(() => {});
      return null;
    }
    out.set(part.value, n);
    n += part.value.length;
  }
  return n == size ? out : null;
}

/** PUT /api/files/<path>: one file, from a person or an HTTP client (Uploads.upload). */
export const isUpload = (request: Request) => request.method == "PUT" && new URL(request.url).pathname.startsWith("/api/files/");

/**
 * PUT /api/blobs/<sha-256>: the bytes of a file that a write waits for (Uploads.arrive), from anyone: the wait
 * decides what they do, so the document takes them before it asks who sends them.
 */
export const isArrival = (request: Request) =>
  request.method == "PUT" && /^\/api\/blobs\/[0-9a-f]{64}$/.test(new URL(request.url).pathname);

/** What the uploads need of their document. */
export interface UploadsHost {
  deps: DocumentDeps;
  /** The document, opened if it isn't (null if there's no such document). */
  room(): Promise<Opened | null>;
  info(): Promise<DocumentInfo | null>;
  /** Runs `work` with the document held open. */
  hold<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  /** A file changed: the document has been edited. */
  touch(): Promise<void>;
  /** What `who` may do with the document now, as a role. */
  roleOf(who: Asker): Promise<Role | null>;
}

export class Uploads {
  constructor(private host: UploadsHost) {}

  /**
   * Files arriving whole (a publish, from the server's API): each written and
   * taken into the room as an edit "on disk", so open tabs see it at once.
   * What the room holds is written first, so a file replaces the text as it
   * is now (only edits made while it arrives merge with it). Text files go through the room's
   * push; others (images) are stored and the room told. `remove` deletes
   * files. Says what it did with each. `by`: who the edits are by, as a
   * version records it ("ada", "ada, via a shared agent (CI)": byLine). `writer`: who wrote, when their write may wait
   * for a file's bytes (a blob's ref with a size, whose bytes Erga doesn't keep: waits.ts).
   */
  publish(
    files: Record<string, FileData>,
    remove: string[],
    by?: string,
    writer?: Writer
  ): Effect.Effect<Published, StoreError | NoSuchDocument> {
    const self = this;
    return this.host.hold(
      Effect.gen(function* () {
        const opened = yield* io(() => self.host.room());
        if (!opened) return yield* new NoSuchDocument({ message: "There's no such document." });
        return yield* io(() => self.publishNow(opened, files, remove, by ?? null, writer));
      })
    );
  }

  private async publishNow(
    opened: Opened,
    files: Record<string, FileData>,
    remove: string[],
    by: string | null,
    writer?: Writer
  ): Promise<Published> {
    const info = (await this.host.info())!;
    const out: Published = { written: [], removed: [], refused: [] };
    const waiting: Record<string, { hash: string; size: number }> = {};
    // Edits not yet written land first, so a published file replaces what's there now rather than merging with it.
    await Effect.runPromise(opened.room.flush);
    const blobs = info.disk ? null : (this.host.deps.blobs ?? null);
    for (const [path, data] of Object.entries(files)) {
      if (info.disk?.only && path != info.index) {
        out.refused.push({ path, why: `this document is the single file ${info.index}` });
        continue;
      }
      const notPage = opened.room.exists(path) ? null : pageRefusal(info.kind ?? "project", path, info.index);
      if (notPage) {
        out.refused.push({ path, why: notPage });
        continue;
      }
      // Its kind, decided as it arrives (D5): text if it's a text file's name, UTF-8 and at most TEXT_MAX bytes; else a blob.
      let text: string | null = null;
      if (typeof data == "string") text = data;
      else if (isTextPath(path) && data instanceof Uint8Array && (!blobs || data.length <= TEXT_MAX)) {
        try {
          text = utf8(data);
        } catch {
          if (!blobs) {
            out.refused.push({ path, why: "not UTF-8 text" });
            continue;
          }
        }
      }
      // A file by its ref: one whose bytes Erga keeps (a text, if they are one: D5); or an agent's file on its own disk,
      // whose write waits for the bytes (waits.ts).
      let kept: { size: number } | null = null;
      if (blobs && isBlobRef(data)) {
        kept = await blobs.head(data.hash);
        if (!kept) {
          const none = `Erga keeps no file with the sha-256 ${data.hash}`;
          const size = Number.isInteger(data.size) && data.size > 0;
          const check = writer && size ? await this.mayAdd(opened, path, data.size) : null;
          if (check?.ok) waiting[path] = { hash: data.hash, size: data.size };
          else
            out.refused.push({
              path,
              why: check
                ? check.error
                : writer
                  ? `${none}: give its size in bytes too ({"blob": "…", "size": …}), to send its bytes after`
                  : none,
            });
          continue;
        }
        if (isTextPath(path) && kept.size <= TEXT_MAX) {
          const bytes = await blobs.bytes(data.hash);
          try {
            if (bytes) text = utf8(bytes);
          } catch {
            /* not UTF-8: a blob */
          }
        }
      }
      if (text != null && isTextPath(path) && (!blobs || text.length <= TEXT_MAX)) {
        const r = await Effect.runPromise(opened.room.push(path, text, null, by));
        if (r.ok) out.written.push(path);
        else out.refused.push({ path, why: r.reason ?? "refused" });
        continue;
      }
      if (info.disk) {
        out.refused.push({ path, why: "a document on disk takes only text files this way" });
        continue;
      }
      if (path == info.index) {
        out.refused.push({ path, why: "it's the document's page, which is text" });
        continue;
      }
      if (blobs) {
        // A ref's size is the store's.
        const ref: BlobRef =
          isBlobRef(data) && kept
            ? { hash: data.hash, size: kept.size, at: data.at }
            : await Effect.runPromise(storeBlob(blobs, typeof data == "string" ? new TextEncoder().encode(data) : (data as Uint8Array)));
        await Effect.runPromise(opened.room.putBlob(path, ref, by));
        out.written.push(path);
        continue;
      }
      if (isBlobRef(data)) {
        out.refused.push({ path, why: "this server keeps no blobs" });
        continue;
      }
      await this.host.deps.storage.put(FILE + path, typeof data == "string" ? new TextEncoder().encode(data) : data);
      await Effect.runPromise(opened.room.fileChanged(path, by));
      out.written.push(path);
    }
    for (const path of remove) {
      if (path == info.index) {
        out.refused.push({ path, why: "it's the document's page" });
        continue;
      }
      if (info.disk) {
        out.refused.push({ path, why: "files on disk aren't deleted this way" });
        continue;
      }
      if (await Effect.runPromise(opened.room.removeOne(path, by))) out.removed.push(path);
    }
    // In the history now, with the files (an image's bytes went straight to storage).
    if (out.written.length || out.removed.length) await Promise.all([Effect.runPromise(opened.room.flush), this.host.touch()]);
    if (writer && Object.keys(waiting).length) {
      await this.stepWaits({ on: "write", files: waiting, by: writer, now: Date.now() });
      out.waiting = Object.keys(waiting);
    }
    return out;
  }

  /** The writes that wait for their bytes, by path (waits.ts). */
  private async waits(): Promise<Waits> {
    const kept = await this.host.deps.storage.list<Wait>({ prefix: WAIT });
    return Object.fromEntries([...kept].map(([k, w]) => [k.slice(WAIT.length), w]));
  }

  /** The waits' owner: takes an event, keeps the waits after it, and answers the files to put. */
  private async stepWaits(event: WaitEvent): Promise<[string, Wait][]> {
    const storage = this.host.deps.storage;
    const had = await this.waits();
    const { waits, put } = step(had, event);
    const gone = Object.keys(had).filter((p) => !(p in waits));
    if (gone.length) await storage.delete(gone.map((p) => WAIT + p));
    const changed = Object.entries(waits).filter(([p, w]) => had[p] !== w);
    if (changed.length) await storage.put(Object.fromEntries(changed.map(([p, w]) => [WAIT + p, w])));
    return put;
  }

  /**
   * PUT /api/blobs/<sha-256>: the bytes of a file that a write waits for (waits.ts), from anyone: an agent's shell has
   * no session. It answers 404 before it reads a byte unless a write on this server waits for that hash; the body must
   * have the wait's size, no more is read, and only bytes of that hash are kept. Then each such file is put as the
   * person who wrote it, if they may still edit, within the limits an upload has.
   */
  arrive(request: Request): Promise<Response> {
    return Effect.runPromise(
      this.arrived(request).pipe(
        Effect.map((done) => answer(done, 200)),
        Effect.catchTag("UploadRefused", (e) => {
          void request.body?.cancel().catch(() => {});
          return Effect.succeed(answer({ ok: false, error: e.error }, e.status));
        })
      )
    );
  }

  private arrived(request: Request): Effect.Effect<Record<string, unknown>, UploadRefused | StoreError> {
    const self = this;
    const fail = (status: number, error: string) => Effect.fail(new UploadRefused({ status, error }));
    return io(async () => {
      const url = new URL(request.url);
      const hash = url.pathname.slice("/api/blobs/".length);
      const waiting = waitingFor(await self.waits(), hash, url.origin, Date.now());
      const opened = waiting.length ? await self.host.room() : null;
      if (!opened) return fail(404, NO_WAIT);
      const size = Number(request.headers.get("content-length") ?? NaN);
      const sized = waiting.filter(([, w]) => w.size == size);
      if (!sized.length)
        return fail(400, `The write named a file of ${waiting[0][1].size} bytes: send that file, with its size as Content-Length.`);
      const info = (await self.host.info())!;
      const blobs = info.disk ? null : (self.host.deps.blobs ?? null);
      // Who may still edit, and the limits: before a byte is read.
      const refused: { path: string; why: string }[] = [];
      const takers = new Set<string>();
      let status = 409;
      for (const [path, w] of sized) {
        const check =
          accessOf(await self.host.roleOf(w.who)) == "edit"
            ? await self.mayAdd(opened, path, size)
            : { ok: false as const, status: 403, error: `${w.who.login} can't edit this document now.` };
        if (check.ok) takers.add(path);
        else {
          refused.push({ path, why: check.error });
          status = check.status;
        }
      }
      if (!takers.size) return fail(status, refused[0].why);
      // The bytes: the wait's size of them, and only those of its hash. Small ones whole (a text may be one).
      const wrong = (why = "") => fail(400, `These aren't the bytes the write named: their sha-256 or their size differs.${why}`);
      let bytes: Uint8Array | null = null;
      if (!blobs || size <= TEXT_MAX) {
        bytes = await exactly(request.body, size);
        if (!bytes || (await sha256Hex(bytes)) != hash) return wrong();
      } else {
        // A big one streams to the store, which checks the bytes against the hash and the size: wrong ones store nothing.
        const there = await blobs.head(hash);
        if (there && there.size != size) return wrong();
        const stored = there
          ? null
          : await blobs.put(hash, request.body ?? new Uint8Array(), size).then(
              () => null,
              (e) => String(e).split("\n")[0]
            );
        if (stored != null) return wrong(` (${stored})`);
        if (there) void request.body?.cancel().catch(() => {});
      }
      const written: string[] = [];
      for (const [path, w] of await self.stepWaits({ on: "bytes", hash, origin: url.origin, now: Date.now() })) {
        if (!takers.has(path)) continue;
        const by = byLine(w.who.login, w.who.via);
        if (bytes) {
          const r = await self.addBytes(opened, path, bytes, by);
          if (!r.ok) refused.push({ path, why: r.error });
          else written.push(path);
        } else if (path == info.index) refused.push({ path, why: `${path} is the document's page, which is text` });
        else {
          await Effect.runPromise(opened.room.putBlob(path, { hash, size, at: Date.now() }, by));
          written.push(path);
        }
      }
      if (!written.length) return fail(409, refused[0]?.why ?? "The write waits no more.");
      return Effect.succeed({ ok: true, written, size, ...(refused.length ? { refused } : {}) });
    }).pipe(Effect.flatten);
  }

  /**
   * PUT /api/files/<path>: one file from a person or an HTTP client (the
   * editor's drop of a file), its bytes the body, its size Content-Length. Its
   * kind is decided now (D5): a text file's name, UTF-8 and at most TEXT_MAX
   * bytes is text, merged into the room as a publish is; anything else is a
   * blob, which streams to the blob store (`x-erga-sha256`, the bytes'
   * sha-256 in hex, lets one of any size stream: without it, one over
   * BUFFER_MAX is refused). A file at the path is replaced (it stays in the
   * versions): the answer says so. Refused when the file, or the project
   * with it, would pass the limits an admin sets (max_file_mb, max_project_gb).
   */
  upload(request: Request): Promise<Response> {
    const refused = (e: UploadRefused) => {
      void request.body?.cancel().catch(() => {});
      return Effect.succeed(answer({ ok: false, error: e.error }, e.status));
    };
    return Effect.runPromise(
      this.uploaded(request).pipe(
        Effect.map((done) => answer(done, 200)),
        Effect.catchTag("UploadRefused", refused)
      )
    );
  }

  private uploaded(request: Request): Effect.Effect<Record<string, unknown>, UploadRefused | StoreError> {
    const self = this;
    const fail = (status: number, error: string) => Effect.fail(new UploadRefused({ status, error }));
    return Effect.gen(function* () {
      if (request.headers.get("x-erga-access") != "edit") return yield* fail(403, "You can only view this document.");
      const path = cleanRel(new URL(request.url).pathname.slice("/api/files/".length));
      if (!path)
        return yield* fail(
          400,
          'Name the file in the address, PUT /api/files/<path>: a path inside the document, with no ".." and no part that starts with a dot.'
        );
      const opened = yield* Effect.promise(() => self.host.room());
      if (!opened) return yield* fail(404, "There's no such document.");
      const length = request.headers.get("content-length");
      const size = Number(length);
      if (length == null || !Number.isInteger(size) || size < 0)
        return yield* fail(411, "Send the file's size in bytes as Content-Length.");
      const check = yield* Effect.promise(() => self.mayAdd(opened, path, size));
      if (!check.ok) return yield* fail(check.status, check.error);
      const info = (yield* Effect.promise(() => self.host.info()))!;
      const blobs = info.disk ? null : (self.host.deps.blobs ?? null);
      const person = personOf(request.headers);
      const by = byLine(person.id, request.headers.get("x-erga-agent") ? viaOf(request.headers.get("x-erga-via") ?? undefined) : null);
      // Small files (and every file, without a blob store) come whole: a text may be one.
      const given = request.headers.get("x-erga-sha256")?.trim().toLowerCase() ?? "";
      if (!blobs || size <= TEXT_MAX || !/^[0-9a-f]{64}$/.test(given)) {
        if (blobs && size > BUFFER_MAX)
          return yield* fail(
            400,
            `${path} is ${megabytes(size)}: send its sha-256 (hex) as x-erga-sha256, so a file over ${BUFFER_MAX / MB} MB can stream.`
          );
        const bytes = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()));
        if (bytes.length != size) return yield* fail(400, `The body had ${bytes.length} bytes, not the ${size} of its Content-Length.`);
        const r = yield* Effect.promise(() => self.addBytes(opened, path, bytes, by));
        if (!r.ok) return yield* fail(r.status, r.error);
        return { ok: true, path, kind: r.kind, size, ...(r.hash ? { hash: r.hash } : {}), replaced: check.replaced };
      }
      if (path == info.index)
        return yield* fail(409, `${path} is the document's page, which is text: it can't be replaced by a file that isn't.`);
      // A big blob streams to the store, which checks the bytes against the hash: a wrong one stores nothing.
      if (yield* Effect.promise(() => blobs.head(given))) void request.body?.cancel().catch(() => {});
      else {
        const why = (e: unknown) =>
          new UploadRefused({
            status: 400,
            error: `${path} wasn't stored: ${e instanceof Error ? e.message : String(e)}. Check its x-erga-sha256 and Content-Length.`,
          });
        yield* Effect.tryPromise({ try: () => blobs.put(given, request.body ?? new Uint8Array(), size), catch: why });
      }
      const ref: BlobRef = { hash: given, size, at: Date.now() };
      yield* opened.room.putBlob(path, ref, by);
      return { ok: true, path, kind: "file", size, hash: ref.hash, replaced: check.replaced };
    });
  }

  /**
   * Whether a file of `size` bytes may be added at `path`: not over a
   * folder, not inside a file, and within the limits an admin sets (one
   * file, and the project with it); whether it replaces a file there.
   */
  private async mayAdd(
    opened: Opened,
    path: string,
    size: number
  ): Promise<{ ok: true; replaced: boolean } | { ok: false; status: number; error: string }> {
    const config = this.host.deps.directory.config;
    const maxMb = (await config.get("max_file_mb")) as number;
    if (size > maxMb * MB)
      return {
        ok: false,
        status: 413,
        error: `${path} is ${megabytes(size)}: a file can have at most ${maxMb} MB here (an admin sets it: max_file_mb).`,
      };
    const room = opened.room;
    const at = room.exists(path);
    if (at == "folder") return { ok: false, status: 409, error: `There's a folder at ${path}: a file can't take its place.` };
    const inFile = parentsOf(path).find((d) => room.exists(d) == "file");
    if (inFile) return { ok: false, status: 409, error: `${inFile} is a file, so nothing can go inside it.` };
    const notPage = at
      ? null
      : pageRefusal((await this.host.info())?.kind ?? "project", path, (await this.host.info())?.index ?? "index.html");
    if (notPage) return { ok: false, status: 409, error: notPage };
    const maxGb = (await config.get("max_project_gb")) as number;
    const used = (await this.bytesUsed(opened)) - (at == "file" ? await this.sizeOf(opened, path) : 0);
    if (used + size > maxGb * GB)
      return {
        ok: false,
        status: 413,
        error: `The files here have ${megabytes(used)} together: with ${path} (${megabytes(size)}) they'd pass the ${maxGb} GB a project can have (an admin sets it: max_project_gb).`,
      };
    return { ok: true, replaced: at == "file" };
  }

  /**
   * A file's bytes, arriving whole (an upload, an agent's write of bytes), as
   * `by`: its kind decided now (D5), text merged into the room as a publish
   * is, anything else a blob.
   */
  private async addBytes(
    opened: Opened,
    path: string,
    bytes: Uint8Array,
    by: string
  ): Promise<{ ok: true; kind: "text" | "file"; hash?: string } | { ok: false; status: number; error: string }> {
    const info = (await this.host.info())!;
    const blobs = info.disk ? null : (this.host.deps.blobs ?? null);
    let text: string | null = null;
    if (isTextPath(path) && bytes.length <= TEXT_MAX) {
      try {
        text = utf8(bytes);
      } catch {
        /* not UTF-8: a blob */
      }
    }
    if (text != null || !blobs) {
      const r = await Effect.runPromise(this.publish({ [path]: text ?? bytes }, [], by));
      if (r.refused.length) return { ok: false, status: 409, error: `Couldn't add ${path}: ${r.refused[0].why}.` };
      return { ok: true, kind: text != null ? "text" : "file" };
    }
    if (path == info.index)
      return { ok: false, status: 409, error: `${path} is the document's page, which is text: it can't be replaced by a file that isn't.` };
    const ref = await Effect.runPromise(storeBlob(blobs, bytes));
    await Effect.runPromise(opened.room.putBlob(path, ref, by));
    return { ok: true, kind: "file", hash: ref.hash };
  }

  /** An agent's write of bytes (document/host.ts, putFile): as an upload, within its limits; throws why not. */
  putFile(path: string, bytes: Uint8Array, by: string): Promise<{ kind: "text" | "file"; replaced: boolean }> {
    return Effect.runPromise(
      this.host.hold(
        io(async () => {
          const opened = await this.host.room();
          if (!opened) throw new Error("There's no such document.");
          const clean = cleanRel(path);
          if (!clean) throw new Error(`${path} isn't a path a file can have here (no "..", and no part that starts with a dot).`);
          const check = await this.mayAdd(opened, clean, bytes.length);
          if (!check.ok) throw new Error(check.error);
          const r = await this.addBytes(opened, clean, bytes, by);
          if (!r.ok) throw new Error(r.error);
          return { kind: r.kind, replaced: check.replaced };
        })
      )
    );
  }

  /** How many bytes the project's files have together: each text as it is, each blob as its ref says (one of storage's lists). */
  private async bytesUsed(opened: Opened): Promise<number> {
    const encoder = new TextEncoder();
    let n = 0;
    for (const t of texts(opened.room.doc).values()) n += encoder.encode(t.toString()).length;
    for (const ref of (await this.host.deps.storage.list<BlobRef>({ prefix: REF })).values()) if (isBlobRef(ref)) n += ref.size;
    return n;
  }

  /** One file's size now (0 if it has none). */
  private async sizeOf(opened: Opened, path: string): Promise<number> {
    const text = opened.room.text(path);
    if (text != null) return new TextEncoder().encode(text).length;
    const ref = opened.files.ref ? await Effect.runPromise(Effect.orElseSucceed(opened.files.ref(path), () => null)) : null;
    return ref?.size ?? (await this.host.deps.storage.get<Uint8Array>(FILE + path))?.length ?? 0;
  }
}
