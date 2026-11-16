// What a document's viewers see: its files as they are now, under a version
// that's a digest of them (so the same files are always the same version),
// and which file a page's address is. The app's viewer
// (server/documents/view.ts) asks for it in one call (Document.view); the
// answer is kept in the document's storage while no file changes, so a
// viewer's request needn't open the room.

import * as Effect from "effect/Effect";
import type * as Y from "yjs";
import type { DocName } from "../model/names.ts";
import { assets, files as texts, isTextPath as isTextFile } from "../model/content.ts";
import { resolvePage } from "../model/pages.ts";
import { headOf, type PageHead } from "../../shared/page-head.ts";
import { digest } from "../room/room.ts";
import { io, NoSuchDocument, type StoreError } from "../store/storage.ts";
import { throttle } from "../../shared/time.ts";
import type { Storage } from "../store/storage.ts";
import { byteRange } from "../store/blobs.ts";
import type { Role } from "../model/access.ts";

/** What viewers see: its version (a digest), its page and its files' paths. */
export interface ViewState {
  ver: string;
  index: string;
  paths: string[];
  /** Each page's head's details (shared/page-head.ts), for the pages that have any. */
  heads: Record<string, PageHead>;
}

/** Document.view's answer: what the person may do, the document's name as last told, and (if they may view) the version and file, with its text. */
export interface ViewAnswer {
  role: Role | null;
  name: DocName | null;
  test: boolean;
  ver?: string;
  /** The page's file, or null: no such page. */
  file?: string | null;
  /** The page's own address under the document's (resolvePage's canonical). */
  canonical?: string | null;
  /** The page's head's details: its title, description, icon and link picture, as its <head> says. */
  head?: PageHead;
  /** The document's share counter (access.ts), for the pass to its files. */
  shares?: number;
  /** No file changed in QUIET_MS: the answer may be kept a moment (server/documents/view.ts). */
  quiet?: boolean;
}

/** How long with no file changed before a viewer's answer may be kept (ViewAnswer.quiet). */
const QUIET_MS = 60_000;

/** How often, at most, the open viewers' pages hear that what they show changed (each then shows the change: client/inline/viewer-live.ts). */
const TELL_EVERY_MS = 2000;

/** Where what viewers see is kept in the document's storage, while no file changes. */
const VIEW = "view";

const hashText = (text: string) => digest(new TextEncoder().encode(text));

/** What the document's view needs: its storage, and its room's shared doc (opened if it isn't; null: no document). */
export interface ViewOptions {
  storage: Storage;
  /** Whether the room is open now (else a kept view saves opening it). */
  isOpen: () => boolean;
  /** The room closing: its last writes land first. */
  closing: () => Promise<void>;
  /** The room's shared doc, opened if it isn't (null: there's no such document). */
  doc: () => Effect.Effect<Y.Doc | null, StoreError>;
  /** The first change after a quiet while: a viewer's answer kept meanwhile is out of date. */
  changedAfterQuiet?: () => void;
  /** The document's page and where it is, now (null: no document): the version viewers see is worked out from it. */
  info: () => Promise<{ index: string; disk?: unknown } | null>;
  /** Tells the open viewers' pages the version they should show, and the files that changed since the last time (client/inline/viewer-live.ts). */
  tell: (ver: string, paths?: string[]) => void;
  log: (line: string) => void;
}

/** A document's view: what viewers see, worked out once for each change. */
export class DocumentView {
  /** What viewers see, while no file changes (null: work it out again). */
  private latest: ViewState | null = null;
  /** Whether storage may hold VIEW (so a change deletes it, once). */
  private kept = true;
  /** When a file last changed while this object ran (0: not since it started). */
  private lastChange = 0;
  /** The files that changed since the viewers' pages were last told. */
  private touched = new Set<string>();

  constructor(private o: ViewOptions) {}

  /** Storage was emptied or replaced: what was read of it is forgotten. */
  forget(): void {
    this.latest = null;
    this.kept = true;
  }

  /** Files changed (`paths`): what viewers see is worked out again. */
  changed(paths: string[]): void {
    for (const p of paths) this.touched.add(p);
    // The first change after a quiet while: a viewer's answer kept meanwhile (view's `quiet`) is out of date.
    if (Date.now() - this.lastChange > QUIET_MS) this.o.changedAfterQuiet?.();
    this.lastChange = Date.now();
    this.latest = null;
    this.news();
    if (!this.kept) return;
    this.kept = false;
    // Not forgotten: the next change tries again.
    void this.o.storage.delete(VIEW).catch((e) => {
      this.kept = true;
      this.o.log(`couldn't forget the view: ${e}`);
    });
  }

  /**
   * What viewers see now, and its version: a digest of the files (their paths
   * and digests) and the page, so the same files are always the same version,
   * whatever happened between: the files as they are now (from the room, or
   * kept in storage while no file has changed: a request needn't open the room).
   */
  private now(info: { index: string; disk?: unknown }): Effect.Effect<ViewState, StoreError | NoSuchDocument> {
    const self = this;
    return Effect.gen(function* () {
      if (self.latest && self.latest.index == info.index) return self.latest;
      if (!self.o.isOpen() && !info.disk) {
        yield* Effect.promise(() => self.o.closing());
        const kept = yield* io(() => self.o.storage.get<ViewState>(VIEW));
        // (A view kept before the heads were part of it is worked out again.)
        if (kept && kept.index == info.index && kept.heads) {
          self.kept = true;
          return (self.latest = kept);
        }
      }
      const doc = yield* self.o.doc();
      if (!doc) return yield* new NoSuchDocument({ message: "There's no such document." });
      const encoder = new TextEncoder();
      const entries: [string, string][] = [];
      const heads: Record<string, PageHead> = {};
      for (const [path, text] of texts(doc).entries()) {
        const s = text.toString();
        entries.push([path, digest(encoder.encode(s))]);
        if (/\.html?$/i.test(path)) {
          const head = headOf(s);
          if (Object.keys(head).length) heads[path] = head;
        }
      }
      for (const [path, d] of assets(doc).entries()) if (!texts(doc).has(path)) entries.push([path, d]);
      entries.sort(([a], [b]) => (a < b ? -1 : 1));
      const state: ViewState = {
        ver: "l" + hashText(JSON.stringify([info.index, entries])),
        index: info.index,
        paths: entries.map(([p]) => p),
        heads,
      };
      self.latest = state;
      self.kept = true;
      if (!info.disk) yield* io(() => self.o.storage.put(VIEW, state));
      return state;
    });
  }

  /** The version viewers see now; null if there's no document. */
  async current(): Promise<string | null> {
    const info = await this.o.info();
    return info ? Effect.runPromise(Effect.map(this.now(info), (s) => s.ver).pipe(Effect.orElseSucceed(() => null))) : null;
  }

  /**
   * A file asked for at a version (x-erga-ver: a reader's address names it, server/documents/pages-origin.ts): the
   * answer says the version viewers see now, worked out after the file was read. So an answer whose version is the
   * one asked for holds that version's bytes, and the browser may keep it.
   */
  async stamp(request: Request, answer: Response): Promise<Response> {
    if (request.method != "GET" || !request.headers.has("x-erga-ver") || (answer.status != 200 && answer.status != 304)) return answer;
    const ver = await this.current().catch(() => null);
    if (!ver) return answer;
    const headers = new Headers(answer.headers);
    headers.set("x-erga-ver", ver);
    return new Response(answer.body, { status: answer.status, headers });
  }

  /** A viewer's page that just opened (or came back) hears the version it should show, so it catches up. */
  greet(send: (ver: string) => void): void {
    void this.current().then(
      (ver) => ver && send(ver),
      () => {}
    );
  }

  /** The open viewers' pages hear the version now, at most every TELL_EVERY_MS however fast the files change; the last always lands. */
  private news = throttle(async () => {
    const ver = await this.current();
    if (!ver) return;
    // (A change to very many files, a folder uploaded again, say: no list, and each page loads again.)
    this.o.tell(ver, this.touched.size > 100 ? undefined : [...this.touched]);
    this.touched.clear();
  }, TELL_EVERY_MS);

  /** The answer for someone who may view (`role`, or anyone): which file the address `page` is, in what viewers see now, and that version. */
  answer(
    info: { index: string; test?: boolean; disk?: unknown },
    role: Role | null,
    name: DocName | null,
    page: string
  ): Effect.Effect<ViewAnswer, StoreError | NoSuchDocument> {
    return Effect.map(this.now(info), (state) => this.answerFrom(state, info, role, name, page));
  }

  private answerFrom(state: ViewState, info: { test?: boolean }, role: Role | null, name: DocName | null, page: string): ViewAnswer {
    const paths = new Set(state.paths);
    const found = page
      ? resolvePage((p) => paths.has(p), page, state.index)
      : paths.has(state.index)
        ? { file: state.index, canonical: "" }
        : null;
    // Quiet: no file changed in a while, so the app may keep this answer a moment. A document being edited is
    // asked each time.
    const quiet = Date.now() - this.lastChange > QUIET_MS;
    const head = found ? state.heads[found.file] : undefined;
    return {
      role,
      name,
      test: !!info.test,
      ver: state.ver,
      file: found?.file ?? null,
      canonical: found?.canonical ?? null,
      quiet,
      ...(head ? { head } : {}),
    };
  }
}

// ---------------------------------------------------------------- a file as it is served

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg; codecs=opus", ".wav": "audio/wav",
  ".flac": "audio/flac", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".pdf": "application/pdf", ".zip": "application/zip", ".csv": "text/csv; charset=utf-8", ".avif": "image/avif",
  ".heic": "image/heic", ".tif": "image/tiff", ".tiff": "image/tiff", ".otf": "font/otf",
};
export const mimeOf = (path: string) => MIME[/\.[^./]+$/.exec(path.toLowerCase())?.[0] ?? ""];

/**
 * A document's file as served under /doc/: always checked with the server
 * before it's used (no-cache), so a page always loads the latest version, but
 * by its digest (ETag), so a file that hasn't changed since the browser last
 * had it comes back as a 304 with no body. Shared by the host's route and the
 * Durable Object's own (cloudflare/objects/document.ts, which serves stored files before
 * the room is open).
 *
 * A Range request (`range`, one range of bytes, as audio and video ask: Safari
 * plays none without) gets those bytes (206), or 416 if they're past the end.
 * `serverTiming` says which store it came from (Server-Timing's file, which the
 * page's Resource Timing reads, for page_log network); the bytes sent and the type
 * are added to it.
 */
/** A file's type as it's served, from its name. */
export const typeOf = (rel: string) => mimeOf(rel) ?? (isTextFile(rel) ? "text/plain; charset=utf-8" : "application/octet-stream");

export function docFile(rel: string, bytes: Uint8Array, ifNoneMatch?: string | null, range?: string | null, store = "room"): { status: number; type: string; headers: Record<string, string>; body: Uint8Array | null } {
  const etag = `"${digest(bytes)}"`;
  const type = typeOf(rel);
  const timing = (more: string) => `file;desc="${store}${more} type ${type.split(";")[0]}"`;
  const headers: Record<string, string> = { "Cache-Control": "no-cache", ETag: etag, "Accept-Ranges": "bytes" };
  const fresh = !!ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") == etag);
  if (fresh) return { status: 304, type, headers: { ...headers, "Server-Timing": timing(" not modified") }, body: null };
  const r = range ? byteRange(range, bytes.length) : null;
  if (r == "unsatisfiable") return { status: 416, type, headers: { ...headers, "Content-Range": `bytes */${bytes.length}`, "Server-Timing": timing(` bytes */${bytes.length}`) }, body: new Uint8Array() };
  if (r) {
    const cr = `bytes ${r.start}-${r.end}/${bytes.length}`;
    return { status: 206, type, headers: { ...headers, "Content-Range": cr, "Server-Timing": timing(` ${cr}`) }, body: bytes.subarray(r.start, r.end + 1) };
  }
  return { status: 200, type, headers: { ...headers, "Server-Timing": timing(` bytes 0-${Math.max(0, bytes.length - 1)}/${bytes.length}`) }, body: bytes };
}
