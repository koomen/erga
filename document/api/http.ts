// The document's HTTP API while it is open, for its host (host.ts).
// Given the open room, its files and its participants, it serves the
// document's API (its operations, run as
// the participant that a request names: operations.ts), what storage holds
// (/api/stored) and the document's files (/doc/). It knows no agent: a
// caller is a user, in person or via something (document/room/participants.ts).
//
// What's the Durable Object's stays with it: where files live, who a request
// is from (the person the app vouched for), and the WebSockets, which
// it accepts its own way and hands to the participants (`join`).
//
// The document's tree, its files' list and its name are the server's operations' (server/operations/editor.ts), which
// reach them through the Durable Object's calls (tree, treeOp, files, rename), not over HTTP.

import { headOf } from "../../shared/page-head.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as FileSystem from "effect/FileSystem";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import {
  NoSuchOperation as UnknownOperation,
  runOperation,
  runTreeOp,
  type FilesAccess,
  type OpenResult,
  type Reach,
  type VersionsAccess,
} from "./operations";
import type { Sandbox } from "./page-api";
import { docFile, typeOf } from "./view";
import type { Participants } from "../room/participants";
import { unifiedDiff } from "../history/versions";
import type { Act } from "../../shared/attribution";
import {
  Api,
  BadRequest,
  ExplainBadRequests,
  NoSuchOperation,
  OperationFailed,
  Person,
  PersonFromRequest,
  type DocInfo,
  type Hello,
} from "./api";
import { type DocName } from "../model/names";
import type { Naming } from "../model/names";
import { digest, type Participant, type Room } from "../room/room";
import { StoreError, type FileStore } from "../store/storage";
import {
  TreeError,
  checkNewName,
  cleanRel,
  cleanTreePath,
  isPage,
  pageCount,
  pageAddress,
  parentsOf,
  resolvePage,
  titleOf,
  treeEntries,
  type TreeOp,
} from "../model/pages";
import { isTextPath as isTextFile } from "../model/content";
import type { ViewRequest, ViewResult } from "../../shared/view-page";
import { liveWait, type LiveAnswer, type LiveRequest } from "../../shared/live-page";
import { aimEdits, applySpans } from "../../shared/text-edits";
import type { RenderJob } from "../life/document";
import { encodeStart } from "../../shared/room-socket";
import { blobPointer, byteRange, type BlobStore } from "../store/blobs";
import { sha256Hex } from "../../shared/bytes";
import { pdfText } from "./pdf";
import * as Y from "yjs";

export interface HostOptions {
  readonly room: Room;
  readonly files: FileStore["Service"];
  readonly doc: {
    readonly name: string;
    /** The document's path inside its folder. */
    readonly path: string;
    /** Where the folder is, as the caller describes it (a directory, a URL). */
    readonly dir: string;
  };
  /** The document's id. */
  readonly docId: string;
  /** Takes back a file on its way at the path (uploads.ts, unwait): whether there was one. */
  readonly unwait?: (path: string) => Promise<boolean>;
  /** The largest file anyone can add, in MB (the setting max_file_mb). */
  readonly maxFileMb?: () => Promise<number | null>;
  /** Whoever is in the document, and the state of their work here (participants.ts). */
  readonly participants: Participants;
  /** Runs a page's own API (page-api.ts), for call_edit. (The page's own controls run it in the page.) */
  readonly sandbox: Sandbox;
  /** Who a request is from, as the app said: the user, how they act when not in person (`via`), and the call's turn. */
  readonly personOf: (request: HttpServerRequest.HttpServerRequest) => Asking;
  /** A person's picture, if the platform knows one (hosted: the one the app sent, shared/avatars.ts). */
  readonly avatarOf?: (person: { id: string; name: string; avatar?: string }) => string | undefined;
  /** Whether a request may put a file (PUT /api/stored): everyone, if not given. */
  readonly mayPut?: (request: HttpServerRequest.HttpServerRequest) => boolean;
  /** A single file opened from disk: the document holds only it, and no other file can be made. */
  readonly only?: string;
  /** Its number of pages changed (or is first counted, as it opens): told to the directory. */
  readonly pagesChanged?: (pages: number) => void;
  /** Renders a page in the server's browser (view_page, eval_in_page); none: those tools say so. */
  readonly render?: (job: RenderJob) => Promise<ViewResult>;
  /** The document's title and address in the directory, read and changed as a person. */
  readonly naming?: (person: { id: string; name: string }) => Naming;
  /** The document's versions, for the operations. */
  readonly versions: VersionsAccess;
  /** A new page's text; a plain one if not given. */
  readonly newPage?: string;
  /** Where files kept whole are (their bytes, and what's worked out from them once: a PDF's text). */
  readonly blobs?: BlobStore;
  /** Adds or replaces a file from its bytes, as `by`, within the limits an upload has (uploads.ts); throws why not. */
  readonly putFile: (path: string, bytes: Uint8Array, by: Participant) => Promise<{ kind: "text" | "file"; replaced: boolean }>;
}

/** Who a request is from. */
export interface Asking {
  id: string;
  name: string;
  avatar?: string;
  via?: string;
  turn?: string;
}


/** HttpApi's platform needs, none of which a document served from storage uses. */
const fromStorage = Layer.mergeAll(
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  Etag.layerWeak,
  FileSystem.layerNoop({}),
  Path.layer,
);

export function makeHttp(opts: HostOptions) {
  const { room, files, doc, participants } = opts;
  /** A user's own tabs hear it; every open tab, whoever's, hears it (participants.ts). */
  const sendTo = (user: string, msg: unknown) => participants.tell(user, msg);
  const sendAll = (msg: unknown) => participants.tellAll(msg);
  const own = (user: string) => participants.tabsOf(user);
  // Its pages, counted as it opens and at each change of the tree.
  let pages = pageCount(room.paths());
  opts.pagesChanged?.(pages);
  // The tree changed, by anyone (a person, an agent, a publish, disk): every open tab refetches it, and hears its pages.
  room.onTree(() => {
    const now = pageCount(room.paths());
    if (now != pages) opts.pagesChanged?.((pages = now));
    sendAll({ type: "tree", pages });
  });
  /** The latest moves, for a tab that missed one while it was loading (its hello, ls). */
  const moves: { from: string; to: string }[] = [];
  /** Does a tree operation, as a user or via their agent; open tabs hear what moved or went, to follow a page that did. */
  const tree = async (op: unknown, by: Act) => {
    const done = await Effect.runPromise(
      runTreeOp(room, op, {
        // (The server's operation checked that they may edit.)
        by: participants.of({ id: by.login, name: by.login }, by.via, true),
        index: doc.path,
        only: opts.only,
        newPage: opts.newPage,
        unwait: opts.unwait,
      })
    );
    if (done.op == "move") {
      moves.push({ from: done.from, to: done.to });
      if (moves.length > 50) moves.shift();
      sendAll({ type: "tree", moved: { from: done.from, to: done.to } });
    }
    else if (done.op == "delete") sendAll({ type: "tree", deleted: done.path });
    return done;
  };
  /** Every open tab, whoever's: the document's new title and address, so they show it and move to it. */
  const renamed = (name: DocName) => sendAll({ type: "name", name });
  /** The document's naming as a person; a rename (by them or their agent) reaches every tab. */
  const namingAs = (user: { id: string; name: string }): Naming | undefined => {
    const n = opts.naming?.(user);
    return n && { get: n.get, set: (patch) => Effect.tap(n.set(patch), (name) => Effect.sync(() => renamed(name))) };
  };
  /** Their view of the name, or undefined when there's none to read. */
  const nameFor = (user: { id: string; name: string }) => {
    const n = namingAs(user);
    return n ? Effect.orElseSucceed(n.get(), () => undefined) : Effect.succeed(undefined);
  };

  // view_page and eval_in_page: the server's browser renders the page (opts.render), from the room's text, as it is
  // at that moment. It opens the page on the app's own address: the origin an operation's request came to.
  let origin: string | null = null;
  const render =
    (user: string) =>
    async (req: ViewRequest): Promise<ViewResult> => {
      const fail = (error: string): ViewResult => ({ errors: [], error });
      if (!opts.render) return fail("This server has no browser to render the page with: it needs Cloudflare's browser binding (BROWSER).");
      if (!origin) return fail("The page couldn't be rendered: the server doesn't know its own address yet.");
      const all = new Set(room.paths());
      const asked = String(req.path ?? doc.path)
        .trim()
        .replace(/^\.?\/+/, "");
      const path = isPage(asked) && all.has(asked) ? asked : resolvePage((p) => all.has(p), asked, doc.path)?.file;
      const source = path == null ? null : room.text(path);
      if (path == null || source == null || !isPage(path))
        return fail(`Nothing was rendered: there's no page ${req.path} in this document (ls lists them).`);
      if (!req.preview) return { ...(await opts.render({ path, html: source, by: user, origin, req })), page: path };
      // A preview: the edits on a copy of the page's text, for this render only.
      const edits = Array.isArray(req.preview.edits) ? req.preview.edits : [];
      const aimed = aimEdits(source, edits, path);
      if ("reason" in aimed) return fail(`Nothing was rendered: ${aimed.message}`);
      const html = applySpans(source, aimed.spans);
      return { ...(await opts.render({ path, html, by: user, origin, req })), page: path, preview: { path, edits: edits.length } };
    };

  // The live page (page_log, page_input, eval_in_page with live): ask the person's tabs. With none open there's no live
  // page, and the tool says so. Every tab answers, and the focused one's answer wins at once; else, once all have
  // answered, a visible one's, then any. A tab that couldn't (agent control off there) loses to one that could.
  const lives = new Map<string, (r: LiveAnswer) => void>();
  const live =
    (user: string) =>
    (req: LiveRequest): Promise<LiveAnswer> => {
      const mine = own(user).length;
      if (!mine)
        return Promise.resolve({
          value: JSON.stringify({ error: "Your user has no editor tab open on this document, so there's no live page." }),
        });
      const id = crypto.randomUUID();
      const answers: LiveAnswer[] = [];
      const best = () => [...answers].sort((a, b) => Number(!!a.declined) - Number(!!b.declined) || (b.rank ?? 0) - (a.rank ?? 0))[0];
      const late: LiveAnswer = { value: JSON.stringify({ error: "The editor didn't send an answer back in time." }) };
      const waited = Effect.gen(function* () {
        const answered = yield* Deferred.make<LiveAnswer>();
        lives.set(id, (r) => {
          answers.push(r);
          if ((!r.declined && r.rank == 2) || answers.length >= mine) Deferred.doneUnsafe(answered, Effect.succeed(best()));
        });
        sendTo(user, { type: "live", id, req });
        return yield* Deferred.await(answered).pipe(
          Effect.timeoutOrElse({ duration: liveWait(req), orElse: () => Effect.succeed(answers.length ? best() : late) }),
          Effect.ensuring(Effect.sync(() => lives.delete(id)))
        );
      });
      return Effect.runPromise(waited);
    };

  // open_page: the person's open tabs on this document go to another of its
  // pages (main.ts, { type: "open" }). With none open, nothing can: the tool
  // says so, and gives the page's address to pass on.
  const openFor = (user: { id: string; name: string }) => async (raw: string): Promise<OpenResult> => {
    const all = new Set(room.paths());
    const asked = String(raw ?? "").trim().replace(/^\.?\/+/, "").replace(/(\?edit|#edit)$/, "");
    const file = isPage(asked) && all.has(asked) ? asked : resolvePage((p) => all.has(p), asked, doc.path)?.file;
    if (!file) throw new TreeError(`There's no page "${raw}" in this document. ls lists them.`, 404);
    const name = await Effect.runPromise(nameFor(user));
    const rest = pageAddress(file);
    const at = `${name?.address ?? "/<owner>/<slug>"}${rest ? `/${rest}` : ""}`;
    const n = own(user.id).length;
    if (!n) return { path: file, tabs: 0, message: `${user.name} has no editor open on this document, so nothing was opened. ${file} is at ${at} (its editor at ${at}?edit): give them that link if they should see it.` };
    sendTo(user.id, { type: "open", path: file });
    return { path: file, tabs: n, message: `Opened ${file} (${at}) in ${user.name}'s editor${n > 1 ? `, in all ${n} of their tabs` : ""}.` };
  };

  const fileStats = async () => {
    const stats = files.stats ? await Effect.runPromise(Effect.orElseSucceed(files.stats, () => new Map<string, { size?: number; at?: number; hash?: string }>())) : new Map<string, { size?: number; at?: number; hash?: string }>();
    const encoder = new TextEncoder();
    const out = new Map<string, { size: number | null; at: number | null; kind: "text" | "file"; type: string; hash?: string }>();
    for (const path of room.paths()) {
      const text = room.text(path), s = stats.get(path);
      out.set(path, { kind: text != null ? "text" : "file", size: text != null ? encoder.encode(text).length : s?.size ?? null, at: s?.at ?? null, type: typeOf(path).split(";")[0], ...(s?.hash ? { hash: s.hash } : {}) });
    }
    return out;
  };
  /** A PDF's text, kept by its hash: its blob's, or (a file in storage: no blob store) its bytes'. */
  const pdfTextOf = (path: string) =>
    Effect.gen(function* () {
      const ref = files.ref ? yield* Effect.orElseSucceed(files.ref(path), () => null) : null;
      const read = Effect.orElseSucceed(files.read(path), () => null);
      const bytes = ref ? null : yield* read;
      const hash = ref?.hash ?? (bytes ? yield* Effect.promise(() => sha256Hex(bytes)) : null);
      return hash ? yield* pdfText(hash, bytes ? Effect.succeed(bytes) : read, opts.blobs) : null;
    });
  /** What the file operations reach beyond the shared text, as a participant. */
  const filesAccess = (p: Participant): FilesAccess => ({
    stats: fileStats,
    pdfText: (path) => Effect.runPromise(pdfTextOf(path)),
    writeBytes: (path, bytes) => opts.putFile(path, bytes, p),
  });
  /** What an operation reaches of the document, as the participant that a request names (its user, and how they act). */
  const reach = (user: Asking): Reach => {
    const p = participants.of(user, user.via);
    return {
      user,
      ws: participants.workspace(p),
      canEdit: () => p.canEdit(),
      view: render(user.id),
      live: live(user.id),
      open: openFor(user),
      readAsset: (rel) => Effect.runPromise(Effect.orElseSucceed(files.read(rel), () => null)),
      edited: (path, at) => participants.edited(p, path, at),
      versions: opts.versions,
      lastTurn: () => participants.lastTurn(p),
      files: filesAccess(p),
      sandbox: opts.sandbox,
      someoneIn: (path) => participants.someoneIn(path),
      during: (call, run) => participants.during(p, { ...call, turn: user.turn ?? null }, run),
    };
  };

  // ---------------------------------------------------------- the API

  const personFromRequest = Layer.succeed(PersonFromRequest, (handler) =>
    HttpServerRequest.HttpServerRequest.use((req) => Effect.provideService(handler, Person, opts.personOf(req))));
  const explainBadRequests = HttpApiMiddleware.layerSchemaErrorTransform(ExplainBadRequests, (e) =>
    e.kind == "Params" || e.kind == "Headers" || e.kind == "Query" || e.kind == "Payload"
      ? Effect.fail(new BadRequest({ ok: false, error: e.cause.message }))
      : Effect.die(e));

  /** The document's details as a person sees them (GET /api/doc, and a tab's hello). */
  const infoFor = async (user: { id: string; name: string }): Promise<DocInfo> => {
    const docName = await Effect.runPromise(nameFor(user));
    return {
      name: doc.name,
      path: doc.path,
      dir: doc.dir,
      user: user.name,
      userId: user.id,
      avatar: opts.avatarOf?.(user),
      writeDelay: room.writeDelay,
      canEdit: participants.of(user).canEdit(),
      docName,
      maxFileMb: (await opts.maxFileMb?.()) ?? undefined,
    };
  };
  const docApi = HttpApiBuilder.group(Api, "doc", (h) =>
    h
      .handle("info", () => Person.use((user) => Effect.promise(() => infoFor(user))))
  );

  // The work of a user's participants here: the live page's answers, and Undo of what their agents changed.
  const workApi = HttpApiBuilder.group(Api, "work", (h) =>
    h
      .handle("live", ({ payload: { id, ...answer } }) =>
        Effect.sync(() => {
          lives.get(id)?.(answer);
          return { ok: true as const };
        })
      )
      .handle("undoable", () => Person.use((user) => Effect.sync(() => participants.undoable(user.id))))
      .handle("undo", () => Person.use((user) => Effect.sync(() => participants.replay(user.id, "undo"))))
      .handle("redo", () => Person.use((user) => Effect.sync(() => participants.replay(user.id, "redo"))))
      .handle("undoTurn", () => Person.use((user) => Effect.sync(() => ({ undone: participants.undoTurn(user.id) }))))
      .handle("turnDiff", () =>
        Person.use((user) =>
          Effect.promise(async () => {
            // What changed since the version before that turn; "" when nothing did, or there is no turn.
            const version = participants.undoable(user.id).turn?.version;
            const before = version ? await opts.versions.files(version) : null;
            return { diff: before ? unifiedDiff(before, await opts.versions.current()).diff : "" };
          }).pipe(Effect.orElseSucceed(() => ({ diff: "" })))
        )
      )
  );

  const operationsApi = HttpApiBuilder.group(Api, "operations", (h) =>
    h
      .handle("run", ({ params: { name }, payload }) =>
        Effect.gen(function* () {
          const user = yield* Person;
          // The app's own address, as the server sent the operation's request: where the render opens the page.
          const at = new URL((yield* HttpServerRequest.HttpServerRequest).originalUrl, "http://doc").origin;
          if (at != "http://doc" && !at.endsWith(".invalid")) origin = at;
          const content = yield* Effect.tryPromise({
            try: () => runOperation(reach(user), name, payload),
            catch: (e) =>
              e instanceof UnknownOperation
                ? new NoSuchOperation({ ok: false, error: e.message })
                : new OperationFailed({ ok: false, error: (e as Error).message }),
          });
          return { ok: true as const, content };
        })
      )
      .handle("done", () =>
        Person.use((user) =>
          Effect.sync(() => {
            participants.done(participants.of(user, user.via));
            return { ok: true as const };
          })
        )
      )
  );

  const api = HttpApiBuilder.layer(Api).pipe(Layer.provide([
    docApi.pipe(Layer.provide([personFromRequest, explainBadRequests])),
    workApi.pipe(Layer.provide([personFromRequest, explainBadRequests])),
    operationsApi.pipe(Layer.provide([personFromRequest, explainBadRequests])),
  ]));

  // ---------------------------------------------------------- storage and files

  const badPath = HttpServerResponse.text("Bad path", { status: 400 });
  /** The tree, each page with its title (its first heading, else its <title>) and its head's details when it has them. */
  const entries = () => treeEntries(room.paths(), room.folderPaths()).map((e) => {
    const text = e.type == "page" ? room.text(e.path) : null;
    if (text == null) return e;
    const title = titleOf(text),
      head = headOf(text);
    return { ...e, ...(title ? { title } : {}), ...(Object.keys(head).length ? { head } : {}) };
  });
  /** What a tab hears first: the document's details as its person sees them, its tree (`canEdit`: theirs to change), and the room's epoch. */
  const helloFor = async (user: { id: string; name: string }, canEdit: boolean): Promise<Hello> => ({
    type: "hello",
    info: await infoFor(user),
    tree: { entries: entries(), canEdit: canEdit && opts.only == null, moved: moves, pages },
    epoch: room.epoch,
  });
  /** What the operations call (server/operations/editor.ts, through the Durable Object): the person checked already. */
  const calls: EditorCalls = {
    tree: () => ({ entries: entries(), moved: [...moves], single: opts.only != null }),
    treeOp: async (op, by) => {
      const r = await tree(op, by).then(
        () => null,
        (e: unknown) => e
      );
      if (r) return { ok: false, status: r instanceof TreeError ? r.status : 500, error: r instanceof Error ? r.message : String(r) };
      return { ok: true, entries: entries() };
    },
    files: async () => ({
      files: [...(await fileStats())].map(([path, s]) => ({ path, kind: s.kind, size: s.size, at: s.at, type: s.type })),
      folders: room.folderPaths(),
      index: doc.path,
      single: opts.only != null,
    }),
    rename: async (user, patch) => {
      const n = namingAs(user);
      if (!n) return { ok: false, error: "This document can't be renamed." };
      const r = await Effect.runPromise(Effect.result(n.set(patch)));
      return r._tag == "Success"
        ? { ok: true, name: r.success }
        : { ok: false, error: r.failure instanceof Error ? r.failure.message : String(r.failure) };
    },
  };
  const routes: Array<HttpRouter.Route<unknown>> = [
    // An editor's start, in one answer: its hello and the room's whole state (shared/room-socket.ts).
    HttpRouter.route("GET", "/api/start", Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const hello = yield* Effect.promise(() => helloFor(opts.personOf(req), opts.mayPut?.(req) ?? true));
      return HttpServerResponse.uint8Array(encodeStart(hello, Y.encodeStateAsUpdate(room.doc)), { contentType: "application/octet-stream", headers: { "Cache-Control": "no-store" } });
    })),
    // What storage holds (not the room): lets a test see the room's writes
    // land, and send an edit that arrives as a file (an upload, a git pull)
    // without depending on a filesystem watcher.
    HttpRouter.route("GET", "/api/stored/*", Effect.gen(function* () {
      const rel = cleanRel((yield* HttpRouter.params)["*"]);
      if (!rel) return badPath;
      const bytes = yield* files.read(rel);
      return bytes ? HttpServerResponse.uint8Array(bytes, { contentType: "application/octet-stream", headers: { "Cache-Control": "no-store", ETag: `"${digest(bytes)}"` } }) : HttpServerResponse.text("Not found", { status: 404 });
    })),
    // With If-Match, refused (412) if storage has changed since that version.
    HttpRouter.route("PUT", "/api/stored/*", Effect.gen(function* () {
      const rel = cleanRel((yield* HttpRouter.params)["*"]);
      if (!rel) return badPath;
      if (opts.only != null && rel != opts.only) return HttpServerResponse.text(`This document is the single file ${opts.only}`, { status: 403 });
      const req = yield* HttpServerRequest.HttpServerRequest;
      if (opts.mayPut && !opts.mayPut(req)) return HttpServerResponse.text("You can only view this document.", { status: 403 });
      const text = yield* req.text;
      const ifMatch = req.headers["if-match"]?.replace(/^W\//, "").replace(/"/g, "") ?? null;
      const r = yield* room.push(rel, text, ifMatch, participants.of(opts.personOf(req), null, opts.mayPut?.(req) ?? true));
      return yield* HttpServerResponse.json(r, { status: r.ok ? 200 : r.reason == "stale" ? 412 : 415, headers: r.etag ? { ETag: `"${r.etag}"` } : {} });
    })),
    // The document's folder: text files from the room, so a page always
    // loads the latest shared version, and everything else from storage.
    HttpRouter.route("GET", "/doc/*", Effect.gen(function* () {
      // The path as asked for, a slash at the end included (the router's parameter drops it).
      const req = yield* HttpServerRequest.HttpServerRequest;
      const asked = new URL(req.url, "http://doc").pathname;
      const raw = asked.startsWith("/doc/") ? asked.slice("/doc/".length) : (yield* HttpRouter.params)["*"] ?? "";
      // A page by its address (blog for blog.html or blog/index.html): sent to its file, relatively, so the
      // frame's address is the file's and the page's own relative links resolve. doc/ itself is the document's
      // page, served as it is (the viewer's frame may ask for it so: server/documents/pages-origin.ts; its links resolve from the root either way).
      const page = () => {
        const found = resolvePage((p) => room.exists(p) == "file", raw, doc.path);
        if (!found || found.file == cleanRel(raw)) return null;
        let from = raw;
        try { from = decodeURIComponent(raw); } catch { /* resolvePage refused it already */ }
        return HttpServerResponse.empty({ status: 302, headers: { Location: relativeUrl(from, found.file), "Cache-Control": "no-store" } });
      };
      const rel = raw ? cleanRel(raw) : doc.path;
      if (!rel) return page() ?? HttpServerResponse.text("Not found", { status: 404 });
      if (raw && room.exists(rel) != "file") { const to = page(); if (to) return to; }
      const text = room.text(rel);
      // A blob: the Worker sends it, from the edge or the blob store (blobs.ts, serveBlob).
      const ref = text == null && files.ref ? yield* files.ref(rel) : null;
      if (ref) return HttpServerResponse.fromWeb(blobPointer(ref, typeOf(rel), { "Cache-Control": "no-cache" }));
      const bytes = text != null ? new TextEncoder().encode(text) : yield* files.read(rel);
      if (!bytes) return HttpServerResponse.text("Not found", { status: 404 });
      const r = docFile(rel, bytes, req.headers["if-none-match"], req.headers["range"], text != null ? "room" : "stored");
      return HttpServerResponse.uint8Array(r.body ?? new Uint8Array(), { status: r.status, contentType: r.type, headers: r.headers });
    })),
  ];

  const app = Layer.mergeAll(api, HttpRouter.addAll(routes.map((r) => HttpRouter.route(r.method, r.path, Effect.catch(r.handler, (e) => Effect.succeed(failed(e))))))) as Layer.Layer<
    never, never, HttpRouter.HttpRouter | HttpPlatform.HttpPlatform | Etag.Generator | FileSystem.FileSystem | Path.Path
  >;
  const web = HttpRouter.toWebHandler(app.pipe(Layer.provide(fromStorage)), { disableLogger: true });

  return {
    /**
     * The document's HTTP app, as a web handler: the API, /api/stored and
     * /doc/, for requests whose path is the one inside the document. The
     * caller adds the WebSockets and the editor's files.
     */
    handler: (request: Request) => web.handler(request),
    /** Releases the handler (when the document closes). */
    dispose: () => web.dispose(),
    /** What a tab hears first: the document's details as its person sees them, and its tree (`canEdit`: theirs to change). */
    hello: helloFor,
    /** The document was renamed some other way (its title following an edit): every tab hears of it. */
    renamed,
    calls,
  };
}

/** A document's file tree, as ls answers it. */
export interface TreeState {
  entries: { path: string; type: string; title?: string }[];
  moved: { from: string; to: string }[];
  single: boolean;
}
/** A tree operation's answer: the tree after it, or why it wasn't done (`status`: the HTTP status it means). */
export type TreeAnswer = { ok: true; entries: TreeState["entries"] } | { ok: false; status: number; error: string };
/** Every file of a document, as the page tree and ls list them. */
export interface FileList {
  files: { path: string; kind: "text" | "file"; size: number | null; at: number | null; type: string }[];
  folders: string[];
  index: string;
  single: boolean;
}
/** A rename's answer: the new name, or why not (the address is taken or reserved, or it isn't theirs to rename). */
export type NameAnswer = { ok: true; name: DocName } | { ok: false; error: string };

/** What the operations inside a document call on its host (server/operations/editor.ts, through the Durable Object). */
export interface EditorCalls {
  /** Its file tree: pages (with titles), other files and folders, the latest moves; `single`: one file from disk. */
  tree(): TreeState;
  /** A tree operation (a new page or folder, a move, a delete), as `by`: the tree after it, or what's wrong. */
  treeOp(op: TreeOp, by: Act): Promise<TreeAnswer>;
  /** Every file, its kind (text, or a file kept whole), type, size and time, and the folders (ls, the page tree). */
  files(): Promise<FileList>;
  /** Renames it as a person (their agent's rename too): every open tab hears of it. */
  rename(user: { id: string; name: string }, patch: { title?: string | null; slug?: string | null }): Promise<NameAnswer>;
}

/** A plain route's failure: a request that doesn't parse is the client's mistake (400); anything else is ours. */
export function failed(e: unknown) {
  const err = e as { _tag?: string; reason?: { _tag?: string }; message?: string };
  const bad = err._tag == "SchemaError" || err.reason?._tag == "RequestParseError";
  return HttpServerResponse.text(String(err.message ?? e), { status: bad ? 400 : 500 });
}

/**
 * The relative URL from a request's path to a file, both inside the
 * document's folder ("blog" to "blog/index.html" is "blog/index.html"; from
 * "blog/" it's "index.html"): a redirect that keeps whatever comes before
 * (the pages origin's /t/<token>/doc/).
 */
export function relativeUrl(from: string, to: string): string {
  const dir = from.split("/").filter(Boolean);
  if (!from.endsWith("/")) dir.pop();
  const target = to.split("/");
  let k = 0;
  while (k < dir.length && k < target.length - 1 && dir[k] == target[k]) k++;
  return "../".repeat(dir.length - k) + target.slice(k).map(encodeURIComponent).join("/");
}
