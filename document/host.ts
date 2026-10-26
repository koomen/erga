// The host for one document, run by its Durable Object.
// Given the open room, its files and the agent's settings, it keeps each
// person's agent session and their open tabs, and serves
// the document's API, what storage holds (/api/stored) and the
// document's files (/doc/).
//
// What's the Durable Object's stays with it: where files live, who a request
// is from (the person the front door vouched for), and the WebSockets, which
// it accepts its own way and hands to `room.connect`, `addTab` and `hello`.
//
//   GET  /api/files          anyone who may view: every file (its kind, size and time) and the folders: the files view
//   PUT  /api/files/<path>   editors: one file, its bytes the body (any kind, any size up to the limits: a text file is
//                            text, anything else a blob in R2), replacing one at that path (document.ts, upload)

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as FileSystem from "effect/FileSystem";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import type { AgentSession, DocumentAgents, FilesAccess, OpenResult, PageTree, VersionsAccess } from "./agent";
import {
  AgentOff,
  Api,
  BadAttachment,
  BadRequest,
  ExplainBadRequests,
  ModelFixed,
  NameRefused,
  NoSuchModel,
  NoSuchTool,
  Person,
  PersonFromRequest,
  SessionFailed,
  ExternalAgent,
  ToolFailed,
  Unauthorized,
  type AgentState,
  type DocInfo,
  type DocName,
  type Hello,
  type ModelState,
} from "./api";
import type { Naming } from "./names";
import { digest, StoreError, type FileStore, type Room } from "./room";
import { TreeError, checkNewName, cleanTreePath, isPage, pageRefusal, type DocKind, pageAddress, parentsOf, resolvePage, titleOf, treeEntries, type TreeOp } from "./pages";
import { ignored, isTextPath as isTextFile } from "./content";
import { viewWait, type ViewRequest, type ViewResult } from "../shared/agent-log";
import { checkAttachments } from "../shared/attach";
import { encodeStart } from "../shared/room-socket";
import { blobPointer, byteRange, INLINE_HEADER, type BlobStore } from "./blobs";
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
  /** Each person's agent here (DocumentDeps.agents): it reads the agent's settings at each turn and each time a panel opens, so a key an admin stores, replaces or clears reaches every open document's agent. */
  readonly agents: DocumentAgents;
  /** A test document: its agent is the scripted model. */
  readonly scripted?: boolean;
  /** Who a request is from. */
  readonly personOf: (request: HttpServerRequest.HttpServerRequest) => { id: string; name: string };
  /**
   * Whom an external agent's request acts for: the person its token stands
   * for, as the front door vouched (null if it came without one).
   */
  readonly agentOf: (request: HttpServerRequest.HttpServerRequest) => { id: string; name: string; via?: string } | null;
  /** The document's public address for a request, for the external agent's guide. */
  readonly baseUrl: (request: HttpServerRequest.HttpServerRequest) => string;
  /** A person's picture, if the platform knows one (hosted: the one the front door sent, shared/avatars.ts). */
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
  readonly setKind?: (kind: DocKind) => Promise<void>;
  /** The document's title and address in the directory, read and changed as a person. */
  readonly naming?: (person: { id: string; name: string }) => Naming;
  /** An agent's turn ended (the embedded agent's, or an external agent's run of calls): a version is cut; answers the version the document is at then. */
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

/** Why someone who may only view gets no embedded agent: its turns use the server's API key. */
const VIEWER_OFF = "You can only view this document, so you can't ask its agent.";

/** One of a person's open tabs: their agent's events and its view_page requests go only to them. */
interface Tab { user: string; send: (msg: unknown) => void; watch?: boolean }

/** A request's path inside the folder, or null if it would leave it (or is ignored). */
export function cleanRel(raw: string | undefined): string | null {
  const parts: string[] = [];
  let decoded: string;
  try { decoded = decodeURIComponent(raw ?? ""); } catch { return null; }
  for (const seg of decoded.split(/[\\/]/)) {
    if (!seg || seg == ".") continue;
    if (seg == "..") return null;
    parts.push(seg);
  }
  const rel = parts.join("/");
  return rel && !ignored(rel) ? rel : null;
}

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
 * page's Resource Timing reads, for page_network); the bytes sent and the type
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
  /** A person's own tabs (an editor's: not a files view, which only watches the tree). */
  const own = (user: string) => [...tabs].filter((t) => t.user == user && !t.watch);
  const sendTo = (user: string, msg: unknown) => { for (const t of own(user)) t.send(msg); };
  /** Every open tab, whoever's. */
  const sendAll = (msg: unknown) => { for (const t of tabs) t.send(msg); };
  /** A document (one page) or a project, as it is now. */
  const kindNow = (): DocKind => opts.kind?.() ?? "project";
  /** Why someone may not ask the embedded agent (someone who may only view: VIEWER_OFF); null if they may. */
  const viewerGate = (user: { id: string; name: string }) => ((opts.canEdit?.(user) ?? true) ? null : VIEWER_OFF);
  /** The agent's state for someone, off (saying why) if they may only view. */
  const offForViewer = (user: { id: string; name: string }, state: AgentState): AgentState => {
    const why = state.enabled && viewerGate(user);
    return why ? { enabled: false, reason: why, log: state.log } : state;
  };
  // The tree changed, by anyone (a person, an agent, a publish, disk): every open tab refetches it.
  room.onTree(() => sendAll({ type: "tree" }));
  /** The latest moves, for a tab that missed one while it was loading (GET /api/tree). */
  const moves: { from: string; to: string }[] = [];
  /** Does a tree operation, as a person or their agent; open tabs hear what moved or went, to follow a page that did. */
  const tree = async (op: unknown) => {
    const done = await runTreeOp(room, op, { index: doc.path, only: opts.only, newPage: opts.newPage, kind: kindNow(), setKind: opts.setKind });
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
    return n && { get: n.get, set: async (patch) => { const name = await n.set(patch); renamed(name); return name; } };
  };
  const nameError = (e: unknown) => new NameRefused({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // view_page: ask the owner's tabs; the first to answer wins. With none of
  // their tabs open there's nothing to look with (no server-side browser
  // yet; Cloudflare Browser Rendering could stand in), and the tool says so.
  // The live page (req.live, shared/live-page.ts) is one tab's in particular:
  // every tab answers, and the focused one's answer wins at once; else, once
  // all have answered, a visible one's, then any. A tab that couldn't (agent
  // control off there) loses to one that could.
  const views = new Map<string, (r: ViewResult) => void>();
  const view = (user: string) => (req: ViewRequest): Promise<ViewResult> => {
    const mine = own(user).length;
    if (!mine) return Promise.resolve({ width: 0, height: 0, errors: [], error: "Your user has no editor tab open, so there's no browser to look at the page with." });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const answers: ViewResult[] = [];
      const best = () => [...answers].sort((a, b) => Number(!!a.declined) - Number(!!b.declined) || (b.rank ?? 0) - (a.rank ?? 0))[0];
      const done = (r: ViewResult) => { clearTimeout(timer); views.delete(id); const { declined: _d, rank: _r, ...rest } = r; resolve(rest); };
      const timer = setTimeout(() => {
        views.delete(id);
        if (answers.length) return done(best());
        resolve({ width: 0, height: 0, errors: [], error: `The editor didn't send ${req.live ? "an answer" : req.evaluate != null ? "the result" : "a picture"} back in time.` });
      }, viewWait(req) + 2_000);
      views.set(id, (r) => {
        if (!req.live) return done(r);
        answers.push(r);
        if ((!r.declined && r.rank == 2) || answers.length >= mine) done(best());
      });
      sendTo(user, { type: "view", id, req });
    });
  };

  /** The document's pages with their titles, and its address as the person sees it (list_pages). */
  const pagesFor = (user: { id: string; name: string }) => async (): Promise<PageTree> => {
    const name = await namingAs(user)?.get().catch(() => undefined);
    return { address: name?.address ?? "/<owner>/<slug>", entries: entries() };
  };
  // open_page: the person's open tabs on this document go to another of its
  // pages (main.ts, { type: "open" }). With none open, nothing can: the tool
  // says so, and gives the page's address to pass on.
  const openFor = (user: { id: string; name: string }) => async (raw: string): Promise<OpenResult> => {
    const all = new Set(room.paths());
    const asked = String(raw ?? "").trim().replace(/^\.?\/+/, "").replace(/(\?edit|#edit)$/, "");
    const file = isPage(asked) && all.has(asked) ? asked : resolvePage((p) => all.has(p), asked, doc.path)?.file;
    if (!file) throw new TreeError(`There's no page "${raw}" in this document. list_pages lists them.`, 404);
    const name = await namingAs(user)?.get().catch(() => undefined);
    const rest = pageAddress(file);
    const at = `${name?.address ?? "/<owner>/<slug>"}${rest ? `/${rest}` : ""}`;
    const n = own(user.id).length;
    if (!n) return { path: file, tabs: 0, message: `${user.name} has no editor open on this document, so nothing was opened. ${file} is at ${at} (its editor at ${at}?edit): give them that link if they should see it.` };
    sendTo(user.id, { type: "open", path: file });
    return { path: file, tabs: n, message: `Opened ${file} (${at}) in ${user.name}'s editor${n > 1 ? `, in all ${n} of their tabs` : ""}.` };
  };

  /** Every file's kind, size and time: the files view's list and the agent's ls. */
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
  /** What the agent's file tools reach beyond the shared text. */
  const filesAccess: FilesAccess = {
    stats: fileStats,
    pdfText: async (path) => {
      const ref = files.ref ? await Effect.runPromise(Effect.orElseSucceed(files.ref(path), () => null)) : null;
      const read = () => Effect.runPromise(Effect.orElseSucceed(files.read(path), () => null));
      // Kept by the PDF's hash: its blob's, or (a file the object keeps, from before blobs) its bytes'.
      const bytes = ref ? null : await read();
      const hash = ref?.hash ?? (bytes ? await sha256Hex(bytes) : null);
      return hash ? pdfText(hash, async () => bytes ?? (await read()), opts.blobs) : null;
    },
    writeBytes: async (path, bytes, by) => {
      if (!opts.putFile) throw new Error("This document takes only text: write the file's text in content.");
      return opts.putFile(path, bytes, by);
    },
  };

  const sessions = new Map<string, Promise<AgentSession>>();
  /**
   * A person's agent session, started the first time they open the panel. With
   * the embedded agent off it still exists, for an external agent's tool calls.
   */
  const sessionFor = (user: { id: string; name: string }) => {
    let s = sessions.get(user.id);
    if (!s) {
      s = agents.start({
        docId: opts.docId,
        room,
        owner: user,
        docName: doc.name,
        scripted: opts.scripted,
        only: opts.only,
        kind: opts.kind,
        canEdit: () => opts.canEdit?.(user) ?? true,
        view: view(user.id),
        naming: namingAs(user),
        readAsset: (rel) => Effect.runPromise(Effect.orElseSucceed(files.read(rel), () => null)),
        turnEnded: opts.turnEnded,
        versions: opts.versions,
        tree: async (op) => { await tree(op); },
        pages: pagesFor(user),
        open: openFor(user),
        files: filesAccess,
        blobs: opts.blobs,
      });
      // Its events reach the person's tabs; then a run a restart cut off goes on (from its last checkpoint).
      s.then((session) => {
        session.subscribe((ev) => sendTo(user.id, { type: "agent", ev }));
        session.resume().catch((e: unknown) => console.log(`couldn't resume ${user.id}'s agent: ${e}`));
      }, () => sessions.delete(user.id));
      sessions.set(user.id, s);
    }
    return s;
  };
  /** The person's agent session, or why it didn't start. */
  const session = (user: { id: string; name: string }) => Effect.tryPromise(() => sessionFor(user));
  /** Gives the session the settings there are now; answers why the embedded agent is off ("" if it's on). */
  const configured = (s: AgentSession) => Effect.promise(() => s.refresh());
  /** For the panel's endpoints: their session, with the settings there are now, unless the embedded agent is off. */
  const agentSession = Person.use((user) => Effect.gen(function* () {
    const s = yield* Effect.mapError(session(user), () => new AgentOff({ ok: false, reason: "the agent did not start" }));
    const off = yield* configured(s);
    if (off) return yield* new AgentOff({ ok: false, reason: off });
    return s;
  }));
  /** For an external agent: the session's tools work even with the embedded agent off. */
  const extSession = Person.use((user) => Effect.mapError(session(user), () => new SessionFailed({ ok: false, error: "The agent's session didn't start." })));

  // An external agent (Claude Code, Codex...) holds one of the person's
  // agent tokens (server/identity/tokens.ts; the share button makes one), which the front
  // door checks; over /api/ext it calls that person's agent tools, as their agent.

  const modelState = (s: AgentSession): ModelState => ({
    model: s.model,
    choice: s.modelChoice,
    models: s.modelChoice == null ? [] : [...agents.models],
  });

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
    const docName = await (namingAs(user)?.get().catch(() => undefined) ?? Promise.resolve(undefined));
    return { name: doc.name, path: doc.path, dir: doc.dir, user: user.name, userId: user.id, avatar: opts.avatarOf?.(user), writeDelay: room.writeDelay, canEdit: opts.canEdit?.(user) ?? true, docName };
  };
  /** The person's agent: on or off, its model, its conversation (GET /api/agent, and a tab's socket once its session is up). */
  const agentStateFor = (user: { id: string; name: string }): Promise<AgentState> => Effect.runPromise(session(user).pipe(
    Effect.flatMap((s) => Effect.map(configured(s), (off): AgentState => off ? { enabled: false, reason: off, log: s.log() } : { enabled: true, ...modelState(s), log: s.log() })),
    Effect.catch((e) => Effect.succeed<AgentState>({ enabled: false, reason: `the agent did not start: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}` })),
  ));

  const docApi = HttpApiBuilder.group(Api, "doc", (h) => h
    .handle("info", () => Person.use((user) => Effect.promise(() => infoFor(user))))
    .handle("name", () => Person.use((user) => {
      const n = namingAs(user);
      return n ? Effect.tryPromise({ try: () => n.get(), catch: nameError }) : Effect.fail(nameError("This document has no name to read."));
    }))
    .handle("rename", ({ payload }) => Person.use((user) => {
      const n = namingAs(user);
      return n ? Effect.tryPromise({ try: () => n.set(payload), catch: nameError }) : Effect.fail(nameError("This document can't be renamed."));
    })));

  const agentApi = HttpApiBuilder.group(Api, "agent", (h) => h
    .handle("state", () => Person.use((user) => Effect.promise(() => agentStateFor(user).then((state) => offForViewer(user, state)))))
    .handle("prompt", ({ payload }) => Effect.gen(function* () {
      const s = yield* agentSession;
      // Someone who may only view never asks it.
      const why = yield* Person.use((user) => Effect.succeed(viewerGate(user)));
      if (why) return yield* new AgentOff({ ok: false, reason: why });
      // The sender's last keystrokes travel over its WebSocket; let them land first.
      const files = checkAttachments(payload.files);
      if (typeof files == "string") return yield* new BadAttachment({ ok: false, reason: files });
      if (payload.after) yield* room.waitFor(payload.after);
      s.prompt(payload.text, payload.context ?? null, files);
      return { ok: true as const };
    }))
    .handle("model", ({ payload }) => Effect.gen(function* () {
      const s = yield* agentSession;
      if (!agents.models.some((m) => m.id == payload.model))
        return yield* new NoSuchModel({ ok: false, reason: `there's no model "${payload.model}"` });
      if (!s.setModel(payload.model)) return yield* new ModelFixed({ ok: false, reason: "this agent's model can't be changed" });
      const state = modelState(s);
      sendTo((yield* Person).id, { type: "model", ...state });
      return { ok: true as const, ...state };
    }))
    .handle("view", ({ payload: { id, errors, fonts, pending, ...result } }) => Effect.sync(() => {
      views.get(id)?.({ ...result, errors: [...errors], ...(fonts ? { fonts: fonts.map((f) => ({ ...f, tags: [...f.tags] })) } : {}), ...(pending ? { pending: [...pending] } : {}) });
      return { ok: true as const };
    }))
    .handle("abort", () => Person.use((user) => session(user).pipe(
      Effect.map((s) => s.abort()), Effect.ignore, Effect.as({ ok: true as const }))))
    .handle("reset", () => Person.use((user) => session(user).pipe(
      Effect.flatMap((s) => Effect.promise(() => s.reset())), Effect.ignore, Effect.as({ ok: true as const }))))
    .handle("undo", () => Person.use((user) => session(user).pipe(
      Effect.map((s) => ({ ok: s.undo() })), Effect.orElseSucceed(() => ({ ok: false }))))));

  const extApi = HttpApiBuilder.group(Api, "ext", (h) => h
    .handle("guide", () => Effect.gen(function* () {
      const user = yield* Person;
      const s = yield* extSession;
      const base = opts.baseUrl(yield* HttpServerRequest.HttpServerRequest);
      const name = yield* Effect.promise(() => namingAs(user)?.get().catch(() => undefined) ?? Promise.resolve(undefined));
      return agents.guide({ docName: name?.title ?? doc.path, owner: user.name, base, tools: s.tools() });
    }))
    .handle("tools", () => Effect.map(extSession, (s) => ({ ok: true as const, tools: s.tools() })))
    .handle("run", ({ params: { name }, payload }) => Effect.gen(function* () {
      const user = yield* Person;
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
    })));

  const api = HttpApiBuilder.layer(Api).pipe(Layer.provide([
    docApi.pipe(Layer.provide([personFromRequest, explainBadRequests])),
    agentApi.pipe(Layer.provide([personFromRequest, explainBadRequests])),
    extApi.pipe(Layer.provide([externalAgent, explainBadRequests])),
  ]));

  // ---------------------------------------------------------- storage and files

  const badPath = HttpServerResponse.text("Bad path", { status: 400 });
  /** The tree, each page with its title (its first heading, else its <title>) when it has one. */
  const entries = () => treeEntries(room.paths(), room.folderPaths()).map((e) => {
    const text = e.type == "page" ? room.text(e.path) : null;
    const title = text != null ? titleOf(text) : null;
    return title ? { ...e, title } : e;
  });
  /** What a tab hears first: the document's details as its person sees them, its tree (`canEdit`: theirs to change), and the room's epoch. */
  const helloFor = async (user: { id: string; name: string }, canEdit: boolean): Promise<Hello> => ({
    type: "hello",
    info: await infoFor(user),
    tree: { entries: entries(), canEdit: canEdit && opts.only == null, moved: moves, kind: kindNow() },
    epoch: room.epoch,
  });
  const routes: Array<HttpRouter.Route<unknown>> = [
    // An editor's start, in one answer: its hello and the room's whole state (shared/room-socket.ts).
    HttpRouter.route("GET", "/api/start", Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const hello = yield* Effect.promise(() => helloFor(opts.personOf(req), opts.mayPublish?.(req) ?? true));
      return HttpServerResponse.uint8Array(encodeStart(hello, Y.encodeStateAsUpdate(room.doc)), { contentType: "application/octet-stream", headers: { "Cache-Control": "no-store" } });
    })),
    // Every file, with its kind (text, or a file kept whole: a blob), its size and its time, and the folders: the files
    // view's list (client/pages/files.ts).
    HttpRouter.route("GET", "/api/files", Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const list = [...(yield* Effect.promise(fileStats))].map(([path, s]) => ({ path, kind: s.kind, size: s.size, at: s.at, type: s.type }));
      const canEdit = (opts.mayPublish?.(req) ?? true) && opts.only == null;
      return yield* HttpServerResponse.json({ files: list, folders: room.folderPaths(), index: doc.path, canEdit, kind: kindNow() }, { headers: { "Cache-Control": "no-store" } });
    })),
    // The document's file tree: its pages, other files and folders.
    HttpRouter.route("GET", "/api/tree", Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const canEdit = (opts.mayPublish?.(req) ?? true) && opts.only == null;
      return yield* HttpServerResponse.json({ entries: entries(), canEdit, moved: moves, kind: kindNow() }, { headers: { "Cache-Control": "no-store" } });
    })),
    // A tree operation: a new page or folder, a move (or rename), a delete. Editors only.
    HttpRouter.route("POST", "/api/tree", Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      if (opts.mayPublish && !opts.mayPublish(req)) return yield* HttpServerResponse.json({ error: "You can only view this document." }, { status: 403 });
      const body = yield* Effect.orElseSucceed(req.json, () => null);
      const r = yield* Effect.promise(() => tree(body).then(() => null, (e: unknown) => e));
      if (r) {
        const status = r instanceof TreeError ? r.status : 500;
        return yield* HttpServerResponse.json({ error: r instanceof Error ? r.message : String(r) }, { status });
      }
      return yield* HttpServerResponse.json({ entries: entries(), kind: kindNow() }, { headers: { "Cache-Control": "no-store" } });
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
      // A blob: the Worker sends it, from the edge or the blob store (blobs.ts, serveBlob); the bytes here only when it asks.
      const ref = text == null && files.ref && !req.headers[INLINE_HEADER] ? yield* files.ref(rel) : null;
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
    /** A tab joins its person's event channel (`watch`: a files view, which hears only what every tab does); returns the leave function. */
    addTab: (user: string, send: (msg: unknown) => void, watch = false) => {
      const tab: Tab = { user, send, watch };
      tabs.add(tab);
      return () => { tabs.delete(tab); };
    },
    /** What a tab hears first: the document's details as its person sees them, and its tree (`canEdit`: theirs to change). */
    hello: helloFor,
    agentState: (user: { id: string; name: string }) => agentStateFor(user).then((state) => offForViewer(user, state)),
    /** Tells every open tab, whoever's (a new version, a restore: { type: "versions" }). */
    broadcast: (msg: unknown) => { for (const t of tabs) t.send(msg); },
    /** The document was renamed some other way (its title following an edit): every tab hears of it. */
    renamed,
    /** A message for every open tab, whoever's (the homepage's deploy status, { type: "home" }: server/home/deploys.ts). */
    notify: (msg: unknown) => { for (const t of tabs) t.send(msg); },
    /** A person's agent session, started if it isn't: a run a restart cut off goes on (the person's object asks, cloudflare/objects/person-agent.ts). */
    resumeAgent: async (user: { id: string; name: string }) => { await sessionFor(user); },
  };
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
export async function runTreeOp(room: Room, raw: unknown, o: { index: string; only?: string; newPage?: string; kind?: DocKind; setKind?: (kind: DocKind) => Promise<void> }): Promise<TreeDone> {
  if (!raw || typeof raw != "object" || Array.isArray(raw)) throw new TreeError('Send the operation as JSON: {"op": "new_page" | "new_folder" | "move" | "delete" | "make_project" | "make_document", ...}.');
  const op = raw as Record<string, unknown>;
  if (o.only != null) throw new TreeError(`This document is the single file ${o.only}, opened from disk on its own: it can't hold other files or folders.`, 403);
  const kind = o.kind ?? "project";
  /** A new page (or a file that becomes one) only in a project. */
  const mayBePage = (path: string) => { const why = pageRefusal(kind, path, o.index); if (why) throw new TreeError(why, 409); };
  const exists = (p: string) => room.exists(p);
  const free = (p: string) => {
    if (exists(p)) throw new TreeError(`There's already ${exists(p) == "folder" ? "a folder" : "a file"} at ${p}.`, 409);
    const file = parentsOf(p).find((d) => exists(d) == "file");
    if (file) throw new TreeError(`${file} is a file, so nothing can go inside it.`, 409);
  };
  const run = (e: Effect.Effect<void, StoreError>) => Effect.runPromise(Effect.mapError(e, (err) => new TreeError(`Couldn't do it: ${err.message}`, 500)));
  switch (op.op) {
    case "new_page": {
      let path = cleanTreePath(op.path);
      if (!isPage(path)) {
        if (/\.[^./]+$/.test(path)) throw new TreeError(`A page is an .html file, not ${path}.`);
        path += ".html";
      }
      checkNewName(path, "page");
      mayBePage(path);
      free(path);
      await run(room.create(path, o.newPage ?? PLAIN_PAGE));
      return { op: "new_page", path };
    }
    case "new_folder": {
      const path = cleanTreePath(op.path);
      checkNewName(path, "folder");
      free(path);
      await run(room.mkdir(path));
      return { op: "new_folder", path };
    }
    case "move": {
      const from = cleanTreePath(op.from, "from");
      let to = cleanTreePath(op.to, "to");
      const type = exists(from);
      if (!type) throw new TreeError(`There's nothing at ${from}.`, 404);
      if (from == o.index) throw new TreeError(`${from} is the document's own page: it can't be moved or renamed.`);
      // A page renamed without an extension keeps its own.
      if (type == "file" && isPage(from) && !/\.[^./]+$/.test(to)) to += from.slice(from.lastIndexOf("."));
      if (to == from) return { op: "move", from, to };
      if (type == "folder" && to.startsWith(`${from}/`)) throw new TreeError(`A folder can't go inside itself.`);
      checkNewName(to, type == "folder" ? "folder" : isPage(to) ? "page" : "file");
      // In a document, a file may not become a page by its new name (a page stays one: there's only index.html).
      if (type == "file" && !isPage(from)) mayBePage(to);
      free(to);
      await run(room.move(from, to));
      return { op: "move", from, to };
    }
    case "delete": {
      const path = cleanTreePath(op.path);
      if (path == o.index) throw new TreeError(`${path} is the document's own page: it can't be deleted.`);
      if (!exists(path)) throw new TreeError(`There's nothing at ${path}.`, 404);
      await run(room.remove(path));
      return { op: "delete", path };
    }
    case "make_project": {
      if (kind == "project") return { op: "make_project" };
      if (!o.setKind) throw new TreeError("This document can't become a project here.", 403);
      await o.setKind("project");
      return { op: "make_project" };
    }
    case "make_document": {
      if (kind == "document") return { op: "make_document" };
      if (!o.setKind) throw new TreeError("This project can't become a document here.", 403);
      // A document has one page, its own: every other page goes first, by the person's hand (nothing is deleted for them).
      const pages = room.paths().filter(isPage);
      const others = pages.filter((p) => p != o.index);
      if (others.length) throw new TreeError(`It has ${pages.length} pages, and a document has one. Delete the others first: ${others.slice(0, 5).join(", ")}${others.length > 5 ? ` and ${others.length - 5} more` : ""}.`, 409);
      await o.setKind("document");
      return { op: "make_document" };
    }
    default:
      throw new TreeError(`There's no operation "${String(op.op)}": it's one of new_page, new_folder, move, delete, make_project and make_document.`);
  }
}

/** A new page when there's no template: a heading to start from. */
const PLAIN_PAGE = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Untitled</title>\n</head>\n<body>\n<h1>Untitled</h1>\n<p>Start writing here.</p>\n</body>\n</html>\n";
