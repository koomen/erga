// The one document that a Durable Object runs (cloudflare/objects/document.ts), with no Cloudflare in it: the
// document's life (document/life/document.ts) with everything that serves it to callers. It puts the layers together:
// its permissions (permissions.ts), its history (document/history/history.ts), the files that arrive whole
// (uploads.ts), what viewers see (view.ts), whoever is in it, with their tabs' sockets
// (document/room/participants.ts), and, while it is open, its room (document/room/open.ts) and its HTTP API
// (http.ts). The tests run one on MemoryStorage.
//
// The app says who's asking, and the document decides what they may do: it forwards each request with the path
// inside the document (/api/doc, not /koomen/abc123/api/doc), the document's public address in x-erga-base, the
// signed-in person in x-erga-person and who they are in x-erga-who. The document keeps a copy of its permissions
// (the directory pushes every change; D1 stays the truth) and decides with the directory's own rule
// (permissions.ts), so a request here asks the database nothing. What they may do goes on as x-erga-access ("edit",
// or "view": their room connection is then read-only, and so is every participant of theirs, and the files they
// send whole). A read of a file with a key the app checked (the viewer's files, the editor's pages origin) says so
// in x-erga-checked. A request that came through an agent of theirs also says how they act through it
// (x-erga-via): the user and it name the participant that an operation runs as (/api/operations/<name>, which
// only the server calls).

import * as Effect from "effect/Effect";
import type { Act } from "../../shared/attribution.ts";
import { History } from "../history/history.ts";
import type { RestoreResult, Version, VersionsState } from "../history/versions.ts";
import { versionNumber } from "../history/versions.ts";
import { Document, type DocumentDeps, type DocumentInfo, type FileData, type Open, type RenderJob } from "../life/document.ts";
import { personOf, viaOf, type Asker, type Person, type Role } from "../model/access.ts";
import { assets, files as texts } from "../model/content.ts";
import { namingFor, type DocName, type Naming } from "../model/names.ts";
import { cleanRel, pageCandidates, resolvePage, titleOf } from "../model/pages.ts";
import { openRoom, type Opened } from "../room/open.ts";
import { Participants, type Sockets, type TabSocket } from "../room/participants.ts";
import { blobPointer, isBlobRef, type BlobRef } from "../store/blobs.ts";
import { io, KEYS, NoSuchDocument, StoreError } from "../store/storage.ts";
import type { Hello } from "./api.ts";
import { makeHttp, relativeUrl, type EditorCalls } from "./http.ts";
import { Permissions } from "./permissions.ts";
import { isArrival, isUpload, unwait, Uploads, uploadsNow, type Written } from "./uploads.ts";
import { docFile, DocumentView, typeOf, type ViewAnswer, type ViewGreet } from "./view.ts";

const { file: FILE, ref: REF } = KEYS;

/** The document while it is open: its room and participants, and what serves it. */
export interface Served extends Opened, Open {
  /** Tells every open tab, whoever's. */
  broadcast: (msg: unknown) => void;
  handler: (request: Request) => Promise<Response>;
  /** What the server's operations call (http.ts). */
  calls: EditorCalls;
  /** What a tab hears first ({ type: "hello" }): the document's details as the person sees them, and its tree. */
  hello: (person: Person, canEdit: boolean) => Promise<Hello>;
  /** Sets the document's title from a shell tab and broadcasts the new name. */
  setTitle: (title: string) => Promise<boolean>;
}

export class DocumentHost<S extends TabSocket = TabSocket> extends Document<Served> {
  /** Whoever is in the document, with their tabs' sockets, which outlive the open document. */
  readonly participants: Participants<S>;
  /** Its versions: the edits no version holds yet, the cuts, and the reads and restores (document/history/history.ts). */
  private history: History;
  /** Files arriving whole (uploads.ts). */
  private uploads: Uploads;
  /** Who made the last edit, as its author's line ("ada", "ada, via their agent"); null before the first since it opened. */
  private lastAuthor: string | null = null;
  /** Who may do what: its copy of its permissions, and the directory's rule (permissions.ts). */
  private access: Permissions;
  /** What viewers see (view.ts). */
  private views: DocumentView;

  /** `sockets`: the tabs' sockets, as the adapter holds them (none: a document that no tab joins, in a test). */
  constructor(deps: DocumentDeps, sockets: Sockets<S> = { all: () => [], tabOf: () => null, keep: () => {} }) {
    super(deps);
    this.participants = new Participants(sockets, {
      isOpen: () => this.isOpen(),
      reopen: () => Effect.map(this.reopen(), (opened) => !!opened),
      activity: () => this.activity(),
      viewed: () => this.viewed(),
      greet: (tell) => this.views.greet(tell),
      avatarOf: (person) => deps.avatarOf?.(person),
      hello: (person, canEdit) =>
        this.opened!.hello(person, canEdit).catch((e: unknown) => {
          deps.log(`couldn't greet ${person.id}'s tab: ${e}`);
          throw e;
        }),
      // (A tab that joins hears the files on their way first: waits.ts.)
      joined: (send) => void uploadsNow(deps.storage).then((m) => Object.keys(m.files).length && send(m)),
      left: () => void this.history.cutSoon("left"),
      // A participant's run of calls is one version, and where its next diff_versions starts from ("last_turn").
      cutVersion: () =>
        this.history.cutSoon("turn").then(async (v) => (v ?? (await Effect.runPromise(this.history.versions.latest)))?.id ?? null),
      setTitle: (title) => (this.opened ? this.opened.setTitle(title) : Promise.resolve(false)),
    });
    this.history = new History({
      deps,
      opened: () => this.opened,
      room: () => this.room(),
      info: () => this.readInfo(),
      updateInfo: (change) => this.updateInfo(change),
      activity: () => this.activity(),
      write: (files, remove, by) => this.uploads.write(files, remove, by),
      working: () => this.participants.working(),
      tell: (msg) => this.participants.tellAll(msg),
    });
    this.uploads = new Uploads({
      deps,
      room: () => this.room(),
      info: () => this.readInfo(),
      hold: (work) => this.hold(work),
      touch: () => this.touch(),
      roleOf: (who) => this.access.roleOf(who),
      tell: (msg) => this.participants.tellAll(msg),
    });
    this.access = new Permissions({
      storage: this.storage,
      directory: deps.directory,
      info: () => this.readInfo(),
      background: deps.background,
      log: deps.log,
    });
    this.views = new DocumentView({
      storage: this.storage,
      log: deps.log,
      isOpen: () => !!this.opened,
      closing: () => this.settled(),
      doc: () =>
        Effect.map(
          io(() => this.room()),
          (opened) => opened?.room.doc ?? null
        ),
      changedAfterQuiet: () => void this.readInfo().then((info) => info && deps.viewChanged?.(info.id)),
      info: () => this.readInfo(),
      // (`by`: who changed it last, for the pill that tells a reader who writes: client/viewer/live.ts.)
      tell: (ver, paths, digests) =>
        this.opened &&
        this.participants.tellAll({ type: "view", ver, paths, ...(digests ? { digests } : {}), by: this.lastAuthor ?? undefined }),
    });
  }

  // ---------------------------------------------------------------- the document's life (document/life/document.ts)

  /** Opens the room on the document's storage (document/room/open.ts), and its HTTP API around it (http.ts). */
  protected async open(info: DocumentInfo): Promise<Served> {
    const { deps, history } = this;
    const opened = await openRoom({
      deps,
      info,
      participants: this.participants,
      touch: () => this.touch(),
      edited: (author, paths) => {
        this.lastAuthor = author;
        this.views.changed(paths);
        history.noteEdit(author);
      },
    });
    const { room } = opened;
    // Its name from its record once the directory has said it; a rename goes to the directory, and what it answers is kept.
    const named = namingFor(deps.directory, info.id, () => titleOf(room.text(info.index) ?? ""));
    const remember = (name: DocName) => Effect.promise(() => this.rememberName(name));
    const naming: Naming = {
      get: () =>
        Effect.flatMap(
          Effect.promise(() => this.readInfo()),
          (i) => (i?.name ? Effect.succeed(i.name) : Effect.flatMap(named.get(), remember))
        ),
      // (A title goes in the room too: each tab's replica has the title that is set.)
      set: (patch) =>
        Effect.tap(Effect.flatMap(named.set(patch), remember), (name) =>
          Effect.sync(() => {
            if (patch.title !== undefined) room.setTitle(name.titleSet ? name.title : "");
          })
        ),
    };
    const http = makeHttp({
      room,
      files: opened.files,
      participants: opened.participants,
      docId: info.id,
      // A file on its way that is taken back (the tree's delete): every tab hears it.
      unwait: async (path) => {
        const was = await unwait(deps.storage, path);
        if (was) this.participants.tellAll(await uploadsNow(deps.storage));
        return was;
      },
      maxFileMb: () => deps.directory.config.get("max_file_mb"),
      sandbox: deps.sandbox,
      // The render's token and pages origin name the owner the directory has: the record's owner can be an old one.
      ...(deps.render
        ? { render: async (job: RenderJob) => deps.render!({ ...job, owner: (await this.access.owner()) ?? info.owner, id: info.id }) }
        : {}),
      doc: { name: info.index, path: info.index, dir: info.disk?.path ?? info.owner },
      only: info.disk?.only ? info.index : undefined,
      // The app sets x-erga-via only on a request that came through an agent of the user's (their own, or one whose
      // token it checked): how the user acts through it, "their agent" or "a shared agent (label)"; and x-erga-turn,
      // the turn of the agent that the call is part of.
      personOf: (req) => ({
        ...personOf(new Headers(req.headers as Record<string, string>)),
        ...(viaOf(req.headers["x-erga-via"]) ? { via: viaOf(req.headers["x-erga-via"])! } : {}),
        ...(req.headers["x-erga-turn"] ? { turn: req.headers["x-erga-turn"] } : {}),
      }),
      mayPut: (req) => req.headers["x-erga-access"] == "edit",
      avatarOf: deps.avatarOf,
      // Its title and address (the app decided who may rename it: rename_document).
      naming: () => naming,
      versions: {
        state: (opts) => Effect.runPromise(history.versionsState(opts)).then((s) => s!),
        version: (ref) => Effect.runPromise(history.version(ref)),
        files: async (ref) => {
          const n = versionNumber(ref);
          const v = n != null && (await history.ready()) ? await Effect.runPromise(history.versions.get(n)) : null;
          return v ? Effect.runPromise(history.versions.files(v)) : null;
        },
        current: async () => (await history.ready())?.opened.current() ?? new Map(),
      },
      // A new page in its file tree starts as a new document does.
      newPage: deps.pageTemplate,
      // An operation's write of bytes: as an upload is.
      putFile: (path, bytes, by) => this.uploads.putFile(path, bytes, by),
      // Its number of pages, as it opens and at each change: the documents list and the viewer read it.
      pagesChanged: (pages) => deps.background(deps.directory.setPages(info.id, pages)),
    });
    // A title that a tab set in the room (the title's card: client/shell/naming.ts) goes to the directory, and every tab
    // hears the new name. One at a time. As the room opens too: for a title that the directory did not take.
    let titling: Promise<boolean> = Promise.resolve(true);
    const takeTitle = (): Promise<boolean> =>
      (titling = titling.then(async () => {
        const want = room.title;
        if (want === undefined) return true;
        const r = await Effect.runPromise(
          Effect.result(
            Effect.gen(function* () {
              const now = yield* naming.get();
              if (want ? now.titleSet && now.title == want : !now.titleSet) return;
              http.renamed(yield* naming.set({ title: want }));
            })
          )
        );
        if (r._tag == "Failure") {
          deps.log(`couldn't rename ${info.id}: ${r.failure.message}`);
          return false;
        }
        return true;
      }));
    room.onTitle(() => void takeTitle());
    void takeTitle();
    return {
      ...opened,
      broadcast: (msg) => this.participants.tellAll(msg),
      handler: http.handler,
      calls: http.calls,
      hello: http.hello,
      setTitle: (title) => {
        room.setTitle(title);
        return takeTitle();
      },
      renamed: http.renamed,
      flush: () => Effect.runPromise(room.flush).then(() => room.saved),
      text: (path) => room.text(path),
      fileChanged: (path) => room.fileChanged(path),
      close: () => opened.close().then(http.dispose),
    };
  }

  protected onOpen(_opened: Served, info: DocumentInfo): void {
    // A version of what it holds, if it stopped with edits no version has (or there's none yet).
    void Effect.runPromise(this.history.versions.head).then((head) => {
      if (info.uncut || head == 0) void this.history.cutSoon("open");
    });
    // Tabs connected while it was closed join it now.
    this.participants.attach();
  }

  protected onClose(): void {
    this.participants.detach();
  }

  protected quiet(): boolean {
    return !this.history.dirty && !this.history.working();
  }

  protected cut(): Promise<unknown> {
    return this.history.cutting;
  }

  protected made(info: DocumentInfo, files: Map<string, Uint8Array | BlobRef>): Effect.Effect<void, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      // Its first version: the files it starts from.
      yield* self.history.versions.cut(files, info.index, [info.owner], "First version");
      // Who may open it, from the start: its first viewer needn't wait for the directory.
      yield* Effect.promise(() =>
        self.access.readPermissions(info.id).catch((e) => self.deps.log(`couldn't read ${info.id}'s permissions: ${e}`))
      );
    });
  }

  protected forget(): void {
    this.access.forget();
    this.views.forget();
    this.history.forget();
  }

  protected reset(): void {
    this.history.reset();
    // (Its sockets are closed: none of them leaves the room that closes now.)
    this.participants.detach();
  }

  // ---------------------------------------------------------------- what it holds

  /** A page's text in the room (opened if it isn't), or null: a comment's quote finds its place there. */
  async roomText(path: string) {
    const opened = await this.room();
    return (opened && texts(opened.room.doc).get(path)) ?? null;
  }

  /** Every file the document holds (the room's view: text files and others). */
  paths(): Effect.Effect<string[], StoreError> {
    return Effect.map(
      io(() => this.room()),
      (opened) => (opened ? [...new Set([...texts(opened.room.doc).keys(), ...assets(opened.room.doc).keys()])].sort() : [])
    );
  }

  /**
   * Every file the document holds as it is now (text from the room, so the
   * latest edits are in it), and its page: what a copy of it starts from.
   * Null if there's no such document.
   */
  snapshot(): Effect.Effect<{ index: string; files: Record<string, FileData> } | null, StoreError> {
    return io(async () => {
      const info = await this.readInfo();
      const opened = info && (await this.room());
      if (!info || !opened) return null;
      // Text as text, a blob as its ref.
      const files: Record<string, FileData> = {};
      for (const [path, data] of await opened.entries())
        files[path] = data instanceof Uint8Array && opened.room.text(path) != null ? opened.room.text(path)! : data;
      return { index: info.index, files };
    });
  }

  /**
   * A request inside the document (not a WebSocket: the adapter takes those
   * after `admit`). Viewers see the files as they are now, at /doc/.
   */
  handle(request: Request): Effect.Effect<Response, StoreError> {
    if (isArrival(request)) return this.hold(io(() => this.uploads.arrive(request)));
    return Effect.flatMap(this.authorize(request), (allowed) =>
      allowed instanceof Response ? Effect.succeed(allowed) : io(() => this.serve(allowed))
    );
  }

  private async serve(request: Request): Promise<Response> {
    if (isUpload(request)) return Effect.runPromise(this.hold(io(() => this.uploads.upload(request))));
    // Someone viewing it: its files straight from storage while the room isn't open, without opening it
    // (once a room closing a moment ago has written them).
    await this.settled();
    const stored = this.loading ? null : await this.storedFile(request);
    if (stored) return this.views.stamp(request, stored);
    const self = this;
    return this.views.stamp(
      request,
      await Effect.runPromise(
        this.hold(
          Effect.gen(function* () {
            const opened = yield* self.admit(request);
            // Not made yet: asked again next time, since it may be by then (made, or linked from disk).
            if (!opened) return new Response("No such document", { status: 404 });
            return yield* io(() => opened.handler(request));
          })
        )
      )
    );
  }

  /**
   * Opens the document for a request and notes what the app said the
   * person may do; null if there's no such document. The adapter calls it
   * before it accepts a WebSocket.
   */
  admit(request: Request): Effect.Effect<Served | null, StoreError> {
    return Effect.map(
      io(() => this.room()),
      (opened) => {
        if (!opened) return null;
        // What the app said that the user may do: every participant of theirs may then too.
        if (request.headers.has("x-erga-person"))
          opened.participants.of(personOf(request.headers), null, request.headers.get("x-erga-access") == "edit");
        return opened;
      }
    );
  }

  /**
   * A GET of one of its files (/doc/...) while the room isn't open: from
   * storage, which holds the latest text then (the room writes every edit
   * there before it closes), so viewing a document never waits for its room
   * to open. Null for anything else (and for a document on disk, whose files
   * are the dev server's), which opens the room as before.
   */
  private async storedFile(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if ((request.method != "GET" && request.method != "HEAD") || !url.pathname.startsWith("/doc/") || request.headers.get("upgrade"))
      return null;
    const info = await this.readInfo();
    if (!info || info.disk) return null;
    const raw = url.pathname.slice("/doc/".length);
    // doc/ itself is its page (the viewer's frame asks for it so, at the token's own address: server/documents/pages-origin.ts).
    const rel = raw ? cleanRel(raw) : info.index;
    const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    // A clean page address (blog → blog.html or blog/index.html): redirected to its file, relatively, as makeHttp does.
    const redirectPage = async (unwritten?: string[]): Promise<Response | null> => {
      const candidates = pageCandidates(raw, info.index);
      if (!candidates.length) return notFound();
      const keys = candidates.map((c) => FILE + c);
      if (unwritten === undefined) keys.push(KEYS.unwritten);
      const got = await this.storage.get<unknown>(keys);
      const pending = unwritten ?? (got.get(KEYS.unwritten) as string[] | undefined);
      if (candidates.some((c) => pending?.includes(c))) return null;
      const found = resolvePage((p) => got.has(FILE + p), raw, info.index);
      if (!found || found.file == rel) return notFound();
      let from = raw;
      try {
        from = decodeURIComponent(raw);
      } catch {
        /* resolvePage refused it already */
      }
      return new Response(null, {
        status: 302,
        headers: { Location: relativeUrl(from, found.file) + url.search, "Cache-Control": "no-store" },
      });
    };
    if (!rel) return redirectPage();
    // The file (its bytes, or its ref if it's a blob), and the files whose latest text storage doesn't have yet (the room
    // stopped before writing them): one read.
    const got = await this.storage.get<unknown>([FILE + rel, REF + rel, KEYS.unwritten]);
    const unwritten = got.get(KEYS.unwritten) as string[] | undefined;
    if (unwritten?.includes(rel)) return null;
    const ref = got.get(REF + rel);
    if (isBlobRef(ref)) return this.deps.blobs ? blobPointer(ref, typeOf(rel), { "Cache-Control": "no-cache" }) : null;
    const bytes = got.get(FILE + rel) as Uint8Array | undefined;
    if (!bytes) return raw ? redirectPage(unwritten ?? []) : notFound();
    const r = docFile(rel, bytes, request.headers.get("if-none-match"), request.headers.get("range"), "stored");
    return new Response(request.method == "HEAD" ? null : (r.body as Uint8Array<ArrayBuffer>), {
      status: r.status,
      headers: { "Content-Type": r.type, ...r.headers },
    });
  }

  // ---------------------------------------------------------------- who may, and what viewers see

  /** A request from the app, decided here (access.ts): it goes on with x-erga-access; a Response refuses it. */
  authorize(request: Request): Effect.Effect<Request | Response, StoreError> {
    return io(() => this.access.authorize(request));
  }

  /** What `who` may do with the document, as a role (null: nothing), from its copy of its permissions. */
  roleOf(who: Asker): Effect.Effect<Role | null, StoreError> {
    return io(() => this.access.roleOf(who));
  }

  /** The directory says who may do what with this document now (every change is pushed here). */
  setPermissions(list: readonly { login: string; role: Role }[], at?: number): Effect.Effect<void, StoreError> {
    return io(() => this.access.setPermissions(list, at));
  }

  /**
   * A document's page for a viewer (the app's viewer, server/documents/view.ts), in one call: what `who` may do
   * (`anyone`: one everyone may view), which file the address `page` is (its path under the
   * document's; "" its own page) in what viewers see (view.ts), that version, and the document's name (the page itself comes
   * from the document's pages origin: server/documents/pages-origin.ts). Null if there's no such document.
   */
  view(who: Asker | null, opts: { page: string; anyone?: boolean }): Effect.Effect<ViewAnswer | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const info = yield* io(() => self.readInfo());
      if (!info) return null;
      const role = who ? yield* self.roleOf(who) : null;
      const name = info.name ?? null;
      if (!role && !opts.anyone) return { role: null, name, test: !!info.test };
      const shares = yield* io(() => self.access.shares());
      return yield* self.hold(self.views.answer(info, role, name, opts.page)).pipe(
        Effect.map((answer) => ({ ...answer, shares })),
        Effect.catchTag("NoSuchDocument", () => Effect.succeed(null))
      );
    });
  }

  /** The version and file digests viewers see now, from what is kept with the files where the document is closed (it stays closed); null: no document. */
  viewed(): Effect.Effect<ViewGreet | null, StoreError> {
    return this.hold(io(() => this.views.currentGreet()));
  }

  /** An operation's call (host.ts) on the document, opened; null if there's none. */
  call<A>(f: (calls: EditorCalls) => A | Promise<A>): Effect.Effect<A | null, StoreError> {
    return io(async () => {
      const o = await this.room();
      return o ? f(o.calls) : null;
    });
  }

  // ---------------------------------------------------------------- versions (history.ts), and files arriving whole (uploads.ts)

  /** Files arriving whole, from the server's API (Uploads.write): says what it did with each. */
  write(...args: Parameters<Uploads["write"]>): Effect.Effect<Written, StoreError | NoSuchDocument> {
    return this.uploads.write(...args);
  }

  /** Its versions, newest first, and the current one (History.versionsState). Null if there's no such document. */
  versionsState(opts: { before?: string | number | null; limit?: number } = {}): Effect.Effect<VersionsState | null, StoreError> {
    return this.history.versionsState(opts);
  }

  /** One version (by id or number), with its files' paths; null if there's none. */
  version(ref: string | number): Effect.Effect<(Version & { files: string[]; index: string }) | null, StoreError> {
    return this.history.version(ref);
  }

  /** One file of a version; null if there's no such version or file. */
  versionFile(ref: string | number, path: string): Effect.Effect<Uint8Array | null, StoreError> {
    return this.history.versionFile(ref, path);
  }

  /** Brings a version, or one file of it, back over the document as it is now (History.restore). */
  restore(ref: string | number, by: Act, path?: string | null): Effect.Effect<RestoreResult, StoreError> {
    return this.history.restore(ref, by, path);
  }

  /** The document as it is now (up to the keystroke), with its current version: what a publish puts on its domain. */
  currentFiles(): Effect.Effect<{ version: Version; index: string; files: Map<string, Uint8Array> } | null, StoreError> {
    return this.history.currentFiles();
  }
}
