// What a document's viewers see: its files as they are now, under a version
// that's a digest of them (so the same files are always the same version),
// and which file a page's address is. The app's viewer
// (server/documents/view.ts) asks for it in one call (Document.view); the
// answer is kept in the document's storage while no file changes, so a
// viewer's request needn't open the room.

import * as Effect from "effect/Effect";
import type * as Y from "yjs";
import type { DocName } from "./api.ts";
import { assets, files as texts } from "./content.ts";
import { resolvePage } from "./pages.ts";
import { headOf, type PageHead } from "../shared/page-head.ts";
import { digest, NoSuchDocument, StoreError } from "./room.ts";
import { throttle } from "../shared/time.ts";
import type { Storage } from "./storage.ts";
import type { Role } from "./access.ts";

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

/** How often, at most, the open viewers' pages hear that what they show changed (each then loads the page again). */
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
  /** Tells the open viewers' pages the version they should show (client/inline/viewer-live.ts loads it). */
  tell: (ver: string) => void;
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

  constructor(private o: ViewOptions) {}

  /** Storage was emptied or replaced: what was read of it is forgotten. */
  forget(): void {
    this.latest = null;
    this.kept = true;
  }

  /** A file changed: what viewers see is worked out again. */
  changed(): void {
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
    const io = <A>(f: () => Promise<A>) =>
      Effect.tryPromise({ try: f, catch: (e) => new StoreError({ message: e instanceof Error ? e.message : String(e) }) });
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
    if (ver) this.o.tell(ver);
  }, TELL_EVERY_MS);

  /** The answer for someone who may view (`role`, or anyone: the homepage): which file the address `page` is, in what viewers see now, and that version. */
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
