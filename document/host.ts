// The host for one document, run by its Durable Object.
// Given the open room, its files and the agent's settings, it keeps each
// person's agent session and their open tabs, and serves
// the document's API, what storage holds (/api/stored) and the
// document's files (/doc/).
//
// What's the Durable Object's stays with it: where files live, who a request
// is from (the person the app vouched for), and the WebSockets, which
// it accepts its own way and hands to `room.connect`, `addTab` and `hello`.
//
//   PUT  /api/files/<path>   editors: one file, its bytes the body (any kind, any size up to the limits: a text file is
//                            text, anything else a blob in R2), replacing one at that path (uploads.ts, upload)
//
// The document's tree, its files' list and its name are the operations' (server/operations/editor.ts), which reach
// them through the Durable Object's calls (tree, treeOp, files, rename), not over HTTP.

import { headOf } from "../shared/page-head.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as FileSystem from "effect/FileSystem";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import type { AgentSession, DocumentAgents, FilesAccess, OpenResult, VersionsAccess } from "./agent";
import {
  Api,
  BadRequest,
  ExplainBadRequests,
  NoSuchTool,
  Person,
  PersonFromRequest,
  SessionFailed,
  ExternalAgent,
  ToolFailed,
  Unauthorized,
  type DocInfo,
  type DocName,
  type Hello,
} from "./api";
import type { Naming } from "./names";
import { digest, StoreError, type FileStore, type Room } from "./room";
import {
  TreeError,
  checkNewName,
  cleanRel,
  cleanTreePath,
  isPage,
  pageRefusal,
  type DocKind,
  pageAddress,
  parentsOf,
  resolvePage,
  titleOf,
  treeEntries,
  type TreeOp,
} from "./pages";
import { isTextPath as isTextFile } from "./content";
import type { ViewRequest, ViewResult } from "../shared/agent-log";
import { liveWait, type LiveAnswer, type LiveRequest } from "../shared/live-page";
import { aimEdits, applySpans } from "../shared/text-edits";
import type { RenderJob } from "./agent";
import { encodeStart } from "../shared/room-socket";
import { blobPointer, byteRange, type BlobStore } from "./blobs";
import { sha256Hex } from "../shared/bytes";
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
  /** Each person's agent's session here (DocumentDeps.agents), where every agent's document tools run for them. */
  readonly agents: DocumentAgents;
  /** Who a request is from. */
  readonly personOf: (request: HttpServerRequest.HttpServerRequest) => { id: string; name: string };
  /**
   * Whom an external agent's request acts for: the person its token stands
   * for, as the app vouched (null if it came without one).
   */
  readonly agentOf: (request: HttpServerRequest.HttpServerRequest) => { id: string; name: string; via?: string } | null;
  /** A person's picture, if the platform knows one (hosted: the one the app sent, shared/avatars.ts). */
  readonly avatarOf?: (person: { id: string; name: string; avatar?: string }) => string | undefined;
  /** Whether a person may edit, so their agent may (everyone, if not given; the directory's roles decide, cloudflare/objects/document.ts). */
  readonly canEdit?: (person: { id: string; name: string }) => boolean;
  /** Whether a request may publish a file (PUT /api/stored): everyone, if not given. */
  readonly mayPublish?: (request: HttpServerRequest.HttpServerRequest) => boolean;
  /** A single file opened from disk: the document holds only it, and no other file can be made. */
  readonly only?: string;
  /** A document (one page) or a project (pages): now. A project if not given. */
  readonly kind?: () => DocKind;
  /** Changes the document's kind (make_project, make_document): kept and told to the directory. */
  readonly setKind?: (kind: DocKind) => Effect.Effect<void, StoreError>;
  /** Renders a page in the server's browser (view_page, eval_in_page); none: those tools say so. */
  readonly render?: (job: RenderJob) => Promise<ViewResult>;
  /** The document's title and address in the directory, read and changed as a person. */
  readonly naming?: (person: { id: string; name: string }) => Naming;
  /** An agent's run of calls ended: a version is cut; answers the version the document is at then. */
  readonly turnEnded?: () => Promise<string | null> | void;
  /** The document's versions, for the agents' tools. */
  readonly versions?: VersionsAccess;
  /** A new page's text; a plain one if not given. */
  readonly newPage?: string;
  /** Where files kept whole are (their bytes, and what's worked out from them once: a PDF's text). */
  readonly blobs?: BlobStore;
  /** Adds or replaces a file from its bytes, as `by`, within the limits an upload has (document.ts); throws why not. */
  readonly putFile?: (path: string, bytes: Uint8Array, by: string) => Promise<{ kind: "text" | "file"; replaced: boolean }>;
}

/** One of a person's open tabs: their agent's events and its live page requests go only to them. */
interface Tab { user: string; send: (msg: unknown) => void; watch?: boolean }

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

export { byteRange };

/** HttpApi's platform needs, none of which a document served from storage uses. */
const fromStorage = Layer.mergeAll(
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  Etag.layerWeak,
  FileSystem.layerNoop({}),
  Path.layer,
);

export function makeHost(opts: HostOptions) {
  const { room, files, doc, agents } = opts;
  const tabs = new Set<Tab>();
  /** A person's own tabs (an editor's: not a watcher, a viewer's page, which hears only what every tab does). */
  const own = (user: string) => [...tabs].filter((t) => t.user == user && !t.watch);
  const sendTo = (user: string, msg: unknown) => { for (const t of own(user)) t.send(msg); };
  /** Every open tab, whoever's. */
  const sendAll = (msg: unknown) => { for (const t of tabs) t.send(msg); };
  /** A document (one page) or a project, as it is now. */
  const kindNow = (): DocKind => opts.kind?.() ?? "project";
  // The tree changed, by anyone (a person, an agent, a publish, disk): every open tab refetches it.
  room.onTree(() => sendAll({ type: "tree" }));
  /** The latest moves, for a tab that missed one while it was loading (its hello, ls). */
  const moves: { from: string; to: string }[] = [];
  /** Does a tree operation, as a person or their agent; open tabs hear what moved or went, to follow a page that did. */
  const tree = async (op: unknown) => {
    const done = await Effect.runPromise(
      runTreeOp(room, op, { index: doc.path, only: opts.only, newPage: opts.newPage, kind: kindNow(), setKind: opts.setKind })
    );
    if (done.op == "move") {
      moves.push({ from: done.from, to: done.to });
      if (moves.length > 50) moves.shift();
      sendAll({ type: "tree", moved: { from: done.from, to: done.to } });
    }
    else if (done.op == "delete") sendAll({ type: "tree", deleted: done.path });
    // A project or a document now: every tab hears the kind (the breadcrumb shows its pages, or not) and reads the tree again.
    else if (done.op == "make_project" || done.op == "make_document") sendAll({ type: "tree", kind: kindNow() });
    return done;
  };
  /** Every open tab, whoever's: the document's new title and address, so they show it and move to it. */
  const renamed = (name: DocName) => { for (const t of tabs) t.send({ type: "name", name }); };
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
  // with the agent's latest edits. It opens the page on the app's own address: the origin a tool's request came to.
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
  /** What the agent's file tools reach beyond the shared text. */
  const filesAccess: FilesAccess = {
    stats: fileStats,
    pdfText: (path) => Effect.runPromise(pdfTextOf(path)),
    writeBytes: async (path, bytes, by) => {
      if (!opts.putFile) throw new Error("This document takes only text: write the file's text in content.");
      return opts.putFile(path, bytes, by);
    },
  };

  const sessions = new Map<string, Promise<AgentSession>>();
  /** A person's agent session, started the first time one of their agents' tools runs here (or they ask Undo's count). */
  const sessionFor = (user: { id: string; name: string }) => {
    let s = sessions.get(user.id);
    if (!s) {
      s = agents.start({
        room,
        owner: user,
        docName: doc.name,
        only: opts.only,
        kind: opts.kind,
        canEdit: () => opts.canEdit?.(user) ?? true,
        view: render(user.id),
        live: live(user.id),
        readAsset: (rel) => Effect.runPromise(Effect.orElseSucceed(files.read(rel), () => null)),
        turnEnded: opts.turnEnded,
        versions: opts.versions,
        open: openFor(user),
        files: filesAccess,
      });
      // Its events (Undo's count) reach the person's tabs.
      s.then(
        (session) => session.subscribe((ev) => sendTo(user.id, { type: "agent", ev })),
        () => sessions.delete(user.id)
      );
      sessions.set(user.id, s);
    }
    return s;
  };
  /** The person's agent session, or why it didn't start. */
  const session = (user: { id: string; name: string }) => Effect.tryPromise(() => sessionFor(user));
  /** For an agent's tools: the person's session. */
  const extSession = Person.use((user) => Effect.mapError(session(user), () => new SessionFailed({ ok: false, error: "The agent's session didn't start." })));

  // An external agent (Claude Code, Codex...) holds one of the person's
  // agent tokens (server/identity/tokens.ts; the share button makes one), which the app
  // checks; the server runs that person's agent tools here for it (/api/tools/<name>), as their agent.

  // ---------------------------------------------------------- the API

  const personFromRequest = Layer.succeed(PersonFromRequest, (handler) =>
    HttpServerRequest.HttpServerRequest.use((req) => Effect.provideService(handler, Person, opts.personOf(req))));
  const externalAgent = Layer.succeed(ExternalAgent, (handler) => Effect.gen(function* () {
    const user = opts.agentOf(yield* HttpServerRequest.HttpServerRequest);
    if (!user) return yield* new Unauthorized({ ok: false, error: "Missing or unknown token: send the one you were given as \"Authorization: Bearer <token>\". If it stopped working it was revoked: ask for a new one." });
    return yield* Effect.provideService(handler, Person, user);
  }));
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
      canEdit: opts.canEdit?.(user) ?? true,
      docName,
    };
  };
  const docApi = HttpApiBuilder.group(Api, "doc", (h) =>
    h
      .handle("info", () => Person.use((user) => Effect.promise(() => infoFor(user))))
  );

  const agentApi = HttpApiBuilder.group(Api, "agent", (h) => h
      .handle("live", ({ payload: { id, ...answer } }) =>
      Effect.sync(() => {
        lives.get(id)?.(answer);
        return { ok: true as const };
      })
    )
    .handle("undoable", () =>
      Person.use((user) =>
        session(user).pipe(
          Effect.map((s) => s.undoable()),
          Effect.orElseSucceed(() => ({ count: 0, redo: 0 }))
        )
      )
    )
    .handle("undo", () =>
      Person.use((user) =>
        session(user).pipe(
          Effect.map((s) => ({ ok: s.undo() })),
          Effect.orElseSucceed(() => ({ ok: false }))
        )
      )
    )
    .handle("redo", () =>
      Person.use((user) =>
        session(user).pipe(
          Effect.map((s) => ({ ok: s.redo() })),
          Effect.orElseSucceed(() => ({ ok: false }))
        )
      )
    )
);

  const toolsApi = HttpApiBuilder.group(Api, "tools", (h) =>
    h.handle("run", ({ params: { name }, payload }) =>
      Effect.gen(function* () {
      const user = yield* Person;
      // The app's own address, as the server sent the tool's request: where the render opens the page.
      const at = new URL((yield* HttpServerRequest.HttpServerRequest).originalUrl, "http://doc").origin;
      if (at != "http://doc" && !at.endsWith(".invalid")) origin = at;
      const s = yield* extSession;
      if (!s.tools().some((t) => t.name == name)) {
        // One that changes the document, for someone who may only view it: it's there, but not theirs.
        if (agents.changes.has(name))
          return yield* new ToolFailed({
            ok: false,
            error: `${user.name} can only view this document, so ${name} isn't one of the tools: they are ${s
              .tools()
              .map((t) => t.name)
              .join(", ")}.`,
          });
        return yield* new NoSuchTool({
          ok: false,
          error: `There's no tool named "${name}". The tools are: ${s
            .tools()
            .map((t) => t.name)
            .join(", ")}.`,
        });
      }
      const content = yield* Effect.tryPromise({ try: () => s.runTool(name, payload, user.via), catch: (e) => new ToolFailed({ ok: false, error: (e as Error).message }) });
      return { ok: true as const, content };
        })
      )
      .handle("done", () =>
        Effect.map(extSession, (s) => {
          s.done();
          return { ok: true as const };
        })
      )
  );

  const api = HttpApiBuilder.layer(Api).pipe(Layer.provide([
    docApi.pipe(Layer.provide([personFromRequest, explainBadRequests])),
    agentApi.pipe(Layer.provide([personFromRequest, explainBadRequests])),
    toolsApi.pipe(Layer.provide([externalAgent, explainBadRequests])),
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
    tree: { entries: entries(), canEdit: canEdit && opts.only == null, moved: moves, kind: kindNow() },
    epoch: room.epoch,
  });
  /** What the operations call (server/operations/editor.ts, through the Durable Object): the person checked already. */
  const calls: EditorCalls = {
    tree: () => ({ entries: entries(), moved: [...moves], kind: kindNow(), single: opts.only != null }),
    treeOp: async (op) => {
      const r = await tree(op).then(
        () => null,
        (e: unknown) => e
      );
      if (r) return { ok: false, status: r instanceof TreeError ? r.status : 500, error: r instanceof Error ? r.message : String(r) };
      return { ok: true, entries: entries(), kind: kindNow() };
    },
    files: async () => ({
      files: [...(await fileStats())].map(([path, s]) => ({ path, kind: s.kind, size: s.size, at: s.at, type: s.type })),
      folders: room.folderPaths(),
      index: doc.path,
      kind: kindNow(),
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
      const hello = yield* Effect.promise(() => helloFor(opts.personOf(req), opts.mayPublish?.(req) ?? true));
      return HttpServerResponse.uint8Array(encodeStart(hello, Y.encodeStateAsUpdate(room.doc)), { contentType: "application/octet-stream", headers: { "Cache-Control": "no-store" } });
    })),
    // What storage holds (not the room): lets a test see the room's writes
    // land, and send an edit that arrives as a file (a publish, a git pull)
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
      const notPage = room.exists(rel) ? null : pageRefusal(kindNow(), rel, doc.path);
      if (notPage) return HttpServerResponse.text(notPage, { status: 409 });
      const req = yield* HttpServerRequest.HttpServerRequest;
      if (opts.mayPublish && !opts.mayPublish(req)) return HttpServerResponse.text("You can only view this document.", { status: 403 });
      const text = yield* req.text;
      const ifMatch = req.headers["if-match"]?.replace(/^W\//, "").replace(/"/g, "") ?? null;
      const r = yield* room.push(rel, text, ifMatch);
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
    /** Releases the handler and the agents' sessions (when the document closes). */
    dispose: async () => {
      for (const s of sessions.values()) s.then((session) => session.close(), () => {});
      sessions.clear();
      tabs.clear();
      await web.dispose();
    },
    /** A tab joins its person's event channel (`watch`: a watcher, which hears only what every tab does); returns the leave function. */
    addTab: (user: string, send: (msg: unknown) => void, watch = false) => {
      const tab: Tab = { user, send, watch };
      tabs.add(tab);
      return () => { tabs.delete(tab); };
    },
    /** What a tab hears first: the document's details as its person sees them, and its tree (`canEdit`: theirs to change). */
    hello: helloFor,
    /** Tells every open tab, whoever's (a new version, a restore, the homepage's deploy status). */
    broadcast: sendAll,
    /** The document was renamed some other way (its title following an edit): every tab hears of it. */
    renamed,
    calls,
  };
}

/** A document's file tree, as ls answers it. */
export interface TreeState {
  entries: { path: string; type: string; title?: string }[];
  moved: { from: string; to: string }[];
  kind: DocKind;
  single: boolean;
}
/** A tree operation's answer: the tree after it, or why it wasn't done (`status`: the HTTP status it means). */
export type TreeAnswer = { ok: true; entries: TreeState["entries"]; kind: DocKind } | { ok: false; status: number; error: string };
/** Every file of a document, as the page tree and ls list them. */
export interface FileList {
  files: { path: string; kind: "text" | "file"; size: number | null; at: number | null; type: string }[];
  folders: string[];
  index: string;
  kind: DocKind;
  single: boolean;
}
/** A rename's answer: the new name, or why not (the address is taken or reserved, or it isn't theirs to rename). */
export type NameAnswer = { ok: true; name: DocName } | { ok: false; error: string };

/** What the operations inside a document call on its host (server/operations/editor.ts, through the Durable Object). */
export interface EditorCalls {
  /** Its file tree: pages (with titles), other files and folders, the latest moves, its kind; `single`: one file from disk. */
  tree(): TreeState;
  /** A tree operation (a new page or folder, a move, a delete, a change of kind): the tree after it, or what's wrong. */
  treeOp(op: TreeOp): Promise<TreeAnswer>;
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

/** What a tree operation did, its paths cleaned (a new page's with its extension). */
export type TreeDone = TreeOp;

/**
 * Checks a tree operation against the document as it is,
 * then does it in the room: a new page from the template, a new folder, a
 * move (or rename) of a file or folder, or a delete (a folder with all it
 * holds). The document's own page can't be moved or deleted. Throws a
 * TreeError saying what's wrong.
 */
export function runTreeOp(
  room: Room,
  raw: unknown,
  o: { index: string; only?: string; newPage?: string; kind?: DocKind; setKind?: (kind: DocKind) => Effect.Effect<void, StoreError> }
): Effect.Effect<TreeDone, TreeError> {
  const fail = (message: string, status?: number) => Effect.fail(new TreeError(message, status));
  /** One of pages.ts's checks, which throw a TreeError. */
  const check = <A>(f: () => A) => Effect.try({ try: f, catch: (e) => (e instanceof TreeError ? e : new TreeError(String(e), 500)) });
  const done = (e: Effect.Effect<void, StoreError>) => Effect.mapError(e, (err) => new TreeError(`Couldn't do it: ${err.message}`, 500));
  return Effect.gen(function* () {
    if (!raw || typeof raw != "object" || Array.isArray(raw))
      return yield* fail(
        'Send the operation as JSON: {"op": "new_page" | "new_folder" | "move" | "delete" | "make_project" | "make_document", ...}.'
      );
    const op = raw as Record<string, unknown>;
    if (o.only != null)
      return yield* fail(
        `This document is the single file ${o.only}, opened from disk on its own: it can't hold other files or folders.`,
        403
      );
    const kind = o.kind ?? "project";
    const exists = (p: string) => room.exists(p);
    /** A new page (or a file that becomes one) only in a project. */
    const mayBePage = (path: string) => {
      const why = pageRefusal(kind, path, o.index);
      return why ? fail(why, 409) : Effect.void;
    };
    const free = (p: string) => {
      if (exists(p)) return fail(`There's already ${exists(p) == "folder" ? "a folder" : "a file"} at ${p}.`, 409);
      const file = parentsOf(p).find((d) => exists(d) == "file");
      return file ? fail(`${file} is a file, so nothing can go inside it.`, 409) : Effect.void;
    };
    switch (op.op) {
      case "new_page": {
        let path = yield* check(() => cleanTreePath(op.path));
        if (!isPage(path)) {
          if (/\.[^./]+$/.test(path)) return yield* fail(`A page is an .html file, not ${path}.`);
          path += ".html";
        }
        yield* check(() => checkNewName(path, "page"));
        yield* mayBePage(path);
        yield* free(path);
        yield* done(room.create(path, o.newPage ?? PLAIN_PAGE));
        return { op: "new_page", path } as const;
      }
      case "new_folder": {
        const path = yield* check(() => cleanTreePath(op.path));
        yield* check(() => checkNewName(path, "folder"));
        yield* free(path);
        yield* done(room.mkdir(path));
        return { op: "new_folder", path } as const;
      }
      case "move": {
        const from = yield* check(() => cleanTreePath(op.from, "from"));
        let to = yield* check(() => cleanTreePath(op.to, "to"));
        const type = exists(from);
        if (!type) return yield* fail(`There's nothing at ${from}.`, 404);
        if (from == o.index) return yield* fail(`${from} is the document's own page: it can't be moved or renamed.`);
        // A page renamed without an extension keeps its own.
        if (type == "file" && isPage(from) && !/\.[^./]+$/.test(to)) to += from.slice(from.lastIndexOf("."));
        if (to == from) return { op: "move", from, to } as const;
        if (type == "folder" && to.startsWith(`${from}/`)) return yield* fail(`A folder can't go inside itself.`);
        const target = to;
        yield* check(() => checkNewName(target, type == "folder" ? "folder" : isPage(target) ? "page" : "file"));
        // In a document, a file may not become a page by its new name (a page stays one: there's only index.html).
        if (type == "file" && !isPage(from)) yield* mayBePage(to);
        yield* free(to);
        yield* done(room.move(from, to));
        return { op: "move", from, to } as const;
      }
      case "delete": {
        const path = yield* check(() => cleanTreePath(op.path));
        if (path == o.index) return yield* fail(`${path} is the document's own page: it can't be deleted.`);
        if (!exists(path)) return yield* fail(`There's nothing at ${path}.`, 404);
        yield* done(room.remove(path));
        return { op: "delete", path } as const;
      }
      case "make_project": {
        if (kind == "project") return { op: "make_project" } as const;
        if (!o.setKind) return yield* fail("This document can't become a project here.", 403);
        yield* done(o.setKind("project"));
        return { op: "make_project" } as const;
      }
      case "make_document": {
        if (kind == "document") return { op: "make_document" } as const;
        if (!o.setKind) return yield* fail("This project can't become a document here.", 403);
        // A document has one page, its own: every other page goes first, by the person's hand (nothing is deleted for them).
        const pages = room.paths().filter(isPage);
        const others = pages.filter((p) => p != o.index);
        if (others.length) {
          const listed = `${others.slice(0, 5).join(", ")}${others.length > 5 ? ` and ${others.length - 5} more` : ""}`;
          return yield* fail(`It has ${pages.length} pages, and a document has one. Delete the others first: ${listed}.`, 409);
        }
        yield* done(o.setKind("document"));
        return { op: "make_document" } as const;
      }
      default:
        return yield* fail(
          `There's no operation "${String(op.op)}": it's one of new_page, new_folder, move, delete, make_project and make_document.`
        );
    }
  });
}

/** A new page when there's no template: a heading to start from. */
const PLAIN_PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Untitled</title>\n</head>\n<body>\n<h1>Untitled</h1>\n<p>Start writing here.</p>\n</body>\n</html>\n";
