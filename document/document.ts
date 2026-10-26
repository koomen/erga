// One running document, with no Cloudflare in it: given a Storage and what
// the server around it offers (DocumentDeps), it keeps the document's files
// and its room's state, opens the room when the first request arrives,
// serves the document's API (host.ts), cuts versions as it is edited,
// restores them, deletes itself when nobody edits it, and keeps its
// row in the directory up to date. cloudflare/objects/document.ts runs one in
// a Durable Object; the tests run one on MemoryStorage.
//
// The front door says who's asking, and the document decides what they may
// do: it forwards each request with the path inside the document (/api/doc,
// not /koomen/abc123/api/doc), the document's public address in x-erga-base,
// the signed-in person in x-erga-person and who they are in x-erga-who.
// The document keeps a copy of its permissions (the directory pushes every
// change; D1 stays the truth) and decides with the directory's own rule
// (`authorize`, Directory.decide), so a request here asks the database
// nothing. What they may do goes on as x-erga-access ("edit", or "view":
// their room connection is then read-only, and so are their agent and
// the files they send whole). A read of a file with a key the front door checked (the
// viewer's files, the editor's pages origin) says so in x-erga-checked. A request that came with an agent token also has x-erga-agent:
// only those may call the external agent's tools (/api/ext), as the person
// the token stands for, who may do what they last could.
//
// Storage keys: `info` (what the document is, read once and kept in
// memory), `perms` (its permissions, as the directory last said), `view`
// (the version viewers see, while no file changes), `files/<path>` (a file's bytes), `folders/<path>` (a folder made
// as one, empty ones too), `room/...` (the room's journal: storage.ts), and
// the versions' (versions.ts).
//
// Opening it is reading its journal (one read): its files are a view the
// room writes, never read back as it opens. With no edit, request or agent
// at work for `closeIdleMs`, it closes again (its room writes everything
// first), so its object can sleep while tabs stay connected (tabs.ts).
//
// In local development a document can be a file or folder on disk
// (`link`). Its files then stay there: the room's storage is the folder
// itself, reached through the adapter's disk link, and only the room's
// journal is kept here. A single file on its own (`only`) is the only file
// such a document has.

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Y from "yjs";
import { nameOf, namingFor, UNTITLED, type NamedRow, type Naming, type NamesDirectory } from "./names.ts";
import { accessOf, type Asker, type Role } from "./access.ts";
import type { DocumentAgents } from "./agent.ts";
import { cleanRel, docFile, makeHost, typeOf } from "./host.ts";
import { blobPointer, INLINE_HEADER, isBlobRef, OBJECT_MAX, storeBlob, TEXT_MAX, type BlobRef, type BlobStore } from "./blobs.ts";
import type { AgentState, DocName, Hello } from "./api.ts";
import { resolvePage, titleOf } from "./pages.ts";
import { digest, FileStore, Room, StateStore, type Connection } from "./room.ts";
import { fileStoreOf, KEYS, kvOf, RefIndex, stateStoreOf, TimeIndex, type Storage } from "./storage.ts";
import { byLine, VIA } from "../shared/attribution.ts";
import { assets, authorOf, editorOf, files as texts, folders, isTextPath, type Author } from "./content.ts";
import { describeChange, fallbackDescription, publicVersion, versionNumber, Versions, type RestoreResult, type StoredVersion, type Version, type VersionsState } from "./versions.ts";
import { decodeValue, exportPage, type DocSnapshot, type Page } from "./snapshot.ts";
import { kindOf, pageRefusal, parentsOf, type DocKind } from "./pages.ts";
import { json } from "../shared/http.ts";
import { sleep, throttle } from "../shared/time.ts";

/**
 * What a document is: its id, who made it, which file is its page, whether
 * it's a test document, when a file last changed (never, if unset), and where
 * it is on disk (local development). (A document from before 2026-10-20 may
 * also hold `published`, from when viewers could see one chosen version: it is
 * no longer read.)
 */
export interface DocumentInfo {
  id: string; owner: string; index: string; created: number; modified?: number; test?: boolean; disk?: OnDisk;
  /** Its title and address as the directory last said (D1 is the truth; every rename passes here). */
  name?: DocName;
  /** It has edits no version holds yet: it cuts one as it opens. */
  uncut?: boolean;
  /** A document (one page) or a project (pages). Missing on one from before kinds: decided from its pages as it opens. */
  kind?: DocKind;
}

/** A document that's a file or folder on disk (local development): where it is, its address there, and whether it's a single file. */
export interface OnDisk { path: string; slug: string; only?: boolean }

export interface Person {
  id: string;
  name: string /** Their picture, as the front door said (shared/avatars.ts); absent: none. */;
  avatar?: string;
}

/**
 * What a document asks the directory (server/directory/, the Directory
 * itself): its row (made, edited, its kind and expiry, gone), its name, its
 * permissions and the rule that decides them, which document is the homepage,
 * and the settings it reads.
 */
export interface DocumentDirectory extends NamesDirectory<Asker> {
  add(row: {
    id: string;
    owner: string;
    title: string;
    slug?: string;
    slugSet?: boolean;
    created: number;
    modified?: number | null;
    expires?: number | null;
    test?: boolean;
    kind?: DocKind;
    everyone?: "editor";
  }): Promise<{ doc: NamedRow }>;
  edited(id: string, at: { modified: number | null; pageTitle: string | null }): Promise<{ doc: NamedRow; renamed: boolean } | null>;
  setKind(id: string, kind: DocKind): Promise<void>;
  setExpires(id: string, expires: number | null): Promise<void>;
  remove(id: string): Promise<void>;
  decide(
    who: Asker | null,
    doc: { id: string; owner: string; test: boolean },
    permissions: readonly { login: string; role: Role }[]
  ): Promise<Role | null>;
  permissions(id: string): Promise<{ login: string; role: Role }[]>;
  homeId(): Promise<string | null>;
  /** The settings it reads: delete_docs_after_hours (null: never), and the limits max_file_mb and max_project_gb (numbers). */
  config: { get(key: "delete_docs_after_hours" | "max_file_mb" | "max_project_gb"): Promise<number | null> };
}

/** How often edits may update a document's row (its time, and the title that follows its heading). */
const DIRECTORY_EVERY_MS = 2000;


/** What the server around a document gives it. */
export interface DocumentDeps {
  storage: Storage;
  directory: DocumentDirectory;
  /**
   * Who has the document open (the adapter's sockets): how many, and closing
   * them all. `attach`: the document opened (again) while sockets wait, so
   * they join it (after a sleep, sockets outlive the open document);
   * `detach`: it closed, and they wait for the next open.
   */
  tabs: { count(): number; closeAll(code: number, reason: string): void; attach?(opened: Opened): void; detach?(): void };
  /** Each person's agent here (agents/document/session.ts `documentAgents`): its settings, their conversation's store, and the server tools they may use. */
  agents: DocumentAgents;
  /** The homepage forgets a deleted document; and its next deploy is scheduled when the homepage has a new version. */
  home: { forget: (docId: string) => Promise<void>; changed: (docId: string) => Promise<void> };
  /** Local development: this document's storage with its files on disk (dev/disk-storage.ts), for a document that is one. */
  disk?: { storage: (only: string | null) => Storage };
  /**
   * When versions are cut: how long edits pause first, and the longest burst
   * one version holds; the room's write delay and file delay (room.ts);
   * `closeIdleMs`: how long the document stays open with nothing done (no
   * edit, no request, nothing to cut) before it closes, so its object can
   * sleep while tabs stay connected (never, if unset).
   */
  timing: { idleMs: number; maxMs: number; writeDelay?: number; fileDelay?: number; closeIdleMs?: number };
  /** Work that outlives the request (a version's description, telling the homepage). */
  background: (work: Promise<unknown>) => void;
  log: (line: string) => void;
  /** What a new page starts from (the new-document template's page); a plain one if not given. */
  pageTemplate?: string;
  /** A person's picture, if known (hosted: the one the front door sent, shared/avatars.ts). */
  avatarOf?: (person: Person) => string | undefined;
  /** The files viewers see changed after a quiet while: whatever the server kept of them goes (where it can reach). */
  viewChanged?: (docId: string) => void;
  /** Where its files that aren't text are kept (R2 on Cloudflare: document/blobs.ts); without it, every file is in its storage, as before blobs. */
  blobs?: BlobStore;
}

/** A file as it arrives whole or is copied: text, bytes, or a blob already in the blob store (its ref). */
export type FileData = string | Uint8Array | BlobRef;

const { file: FILE, ref: REF, meta: INFO } = KEYS;
const PERMS = "perms", VIEW = "view";
/** Set once every file and version blob kept in the object before blobs has been copied to the blob store (copyToBlobs). */
const COPIED = "blobs-copied";


/** How long a document trusts its copy of its permissions before it reads them again (in the background): changes are pushed, so this only covers one that didn't arrive. */
const PERMISSIONS_FRESH_MS = 5 * 60_000;

/** What viewers see: its version (a digest), its page and its files' paths. */
export interface ViewState { ver: string; index: string; paths: string[] }

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
  /** No file changed in QUIET_MS: the answer may be kept a moment (server/documents/view.ts). */
  quiet?: boolean;
}

/** How long without a file changing before a viewer's answer may be kept (a document being edited is asked each time). */
const QUIET_MS = 60_000;

/** A file over this many bytes, uploaded without its hash, is refused (its bytes would be held in memory to hash them). */
const BUFFER_MAX = 25 * 1_000_000;
const MB = 1_000_000, GB = 1_000_000_000;
const megabytes = (n: number) => (n >= GB ? `${(n / GB).toFixed(2)} GB` : `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`);
/** Where the versions keep a blob in the object (document/versions.ts). */
const VERSION_BLOB = "blobs/";

/** A short digest of a text, for versions. */
const hashText = (text: string) => digest(new TextEncoder().encode(text));

/** What a role lets someone do inside a document (x-erga-access). */


const HOUR = 60 * 60 * 1000;

/**
 * When a document's unedited time is up: one that's been edited (or is a
 * test document) stays, one open somewhere waits an hour more, so it isn't
 * pulled from under someone about to type, and any other goes.
 */
function afterUnedited(doc: { modified?: number; test?: boolean }, open: boolean, now: number): "keep" | "delete" | number {
  if (doc.modified || doc.test) return "keep";
  return open ? now + HOUR : "delete";
}

export class Document {
  private open: Promise<Opened | null> | null = null;
  /** The document once it's open (`open` resolved). */
  private opened: Opened | null = null;
  private sync: (() => void) | null = null;
  private readonly storage: Storage;
  /** Its versions, in its own storage. */
  private versions: Versions;
  /**
   * Edits not yet in a version: since when, by whom, and the timers that cut
   * one (see `noteEdit` for the rule).
   */
  private pending = { dirty: false, since: 0, authors: new Set<string>(), idle: null as ReturnType<typeof setTimeout> | null, max: null as ReturnType<typeof setTimeout> | null };
  /** Cuts, one at a time. */
  private cutting: Promise<unknown> = Promise.resolve();
  /** Room connections that may edit: when the last one goes, a version is cut. */
  private editing = 0;
  /** Who the files arriving whole now are by (publish), for the version. */
  private publisher: string | null = null;
  /**
   * Who may edit, by person id, as the front door last said (x-erga-access):
   * their agent, and an external agent acting for them, may do what they could
   * at their latest request.
   */
  private editors = new Map<string, boolean>();
  /** Its permissions as the directory last said, and when (undefined: not read yet; null: none kept). */
  private perms: { list: { login: string; role: Role }[]; at: number } | null | undefined = undefined;
  /** What viewers see, while no file changes (null: work it out again). */
  private latestView: ViewState | null = null;
  /** Whether storage may hold `view` (so a change deletes it, once). */
  private viewKept = true;
  /** When a file last changed while this object ran (0: not since it started). */
  private lastChange = 0;
  /** What the document is, as storage has it (read once; undefined: not read yet, null: no document). */
  private info: DocumentInfo | null | undefined = undefined;
  /** Whether the unedited document's alarm is known to be gone (an edited one never goes). */
  private kept = false;
  /** The room closing (idle): opening it again waits for its last writes. */
  private closing: Promise<void> = Promise.resolve();
  /** Requests and calls under way: the document doesn't close under them. */
  private busy = 0;
  private lastActive = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: DocumentDeps) {
    this.storage = deps.storage;
    this.versions = new Versions(kvOf(this.storage), Date.now, deps.blobs);
  }

  private get idleMs() { return this.deps.timing.idleMs; }
  private get maxMs() { return this.deps.timing.maxMs; }
  private get directory() { return this.deps.directory; }

  /** What the document is: from memory once read. */
  private async readInfo(): Promise<DocumentInfo | null> {
    if (this.info === undefined) this.info = (await this.storage.get<DocumentInfo>(INFO)) ?? null;
    return this.info;
  }

  private saveInfo(info: DocumentInfo): Promise<void> {
    this.info = info;
    return this.storage.put(INFO, info);
  }

  /** Storage was emptied or replaced: what was read of it is forgotten. */
  private forgetStorage(): void {
    this.info = undefined;
    this.kept = false;
    this.perms = undefined;
    this.latestView = null;
    this.viewKept = true;
    this.versions = new Versions(kvOf(this.storage), Date.now, this.deps.blobs);
  }

  /** The document, opened if it isn't (null if there's no such document). */
  private async room(): Promise<Opened | null> {
    const open = (this.open ??= this.load());
    // One that failed to open (storage failed) is tried again with the next request.
    const opened = await open.catch((e) => { if (this.open === open) this.open = null; throw e; });
    if (!opened) { if (this.open === open) this.open = null; }
    else this.activity();
    return opened;
  }

  /** Runs `work` with the document held open: it doesn't close for being idle meanwhile. */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    this.busy++;
    try { return await work(); } finally { this.busy--; this.activity(); }
  }

  /**
   * Something happened (an edit, a request, a tab's message): the document
   * stays open at least `closeIdleMs` from now. Presence alone (carets
   * moving) doesn't count, so tabs left open let it close.
   */
  activity(): void {
    const ms = this.deps.timing.closeIdleMs;
    if (!ms) return;
    this.lastActive = Date.now();
    if (!this.idleTimer) this.idleTimer = setTimeout(() => { this.idleTimer = null; void this.closeIfIdle(); }, ms);
  }

  /**
   * Closes the document once nothing has happened for `closeIdleMs`, every
   * edit is written and in a version, and no agent is at work: its room
   * writes what it holds and its timers stop, so the object can sleep. Tabs
   * stay connected; the next edit or request opens it again, from storage.
   */
  private async closeIfIdle(): Promise<void> {
    const ms = this.deps.timing.closeIdleMs!;
    await this.cutting;
    const opened = this.opened;
    if (!opened || this.info?.disk || this.idleTimer) return;
    const wait = this.lastActive + ms - Date.now();
    if (wait > 0 || this.busy > 0 || this.pending.dirty || this.agentWorking()) {
      this.idleTimer = setTimeout(() => { this.idleTimer = null; void this.closeIfIdle(); }, wait > 0 ? wait : Math.min(ms, 1000));
      return;
    }
    this.open = null;
    this.opened = null;
    this.editing = 0;
    this.deps.tabs.detach?.();
    this.closing = opened.close().catch((e) => this.deps.log(`couldn't close the room: ${e}`));
    await this.closing;
  }

  /** Whether the document is open now (its room loaded). */
  isOpen(): boolean {
    return this.opened != null;
  }

  /** Opens the document if it isn't (a tab's message after a sleep): null if there's no such document. */
  reopen(): Promise<Opened | null> {
    return this.room();
  }

  /**
   * Creates the document, whose row the front door has just added to the
   * directory, from a template's files; false if it already exists. Unless
   * someone edits it, it's deleted at `expires` (the delete_docs_after_hours setting
   * after it's made, or sooner when local development asks, to test it).
   */
  async create(owner: string, id: string, files: Record<string, FileData>, index: string, opts: { test?: boolean; expires: number | null; modified?: number; kind?: DocKind }): Promise<boolean> {
    if (await this.readInfo()) return false;
    const encoder = new TextEncoder();
    // A blob (a copy's file that is one) goes by its ref.
    const entries = Object.entries(files).map(([path, data]) => isBlobRef(data) ? [REF + path, data] as const : [FILE + path, typeof data == "string" ? encoder.encode(data) : data] as const);
    for (let i = 0; i < entries.length; i += 128) await this.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    // A project if asked, or if its files have more than one page; else a document.
    const kind = opts.kind ?? kindOf(Object.keys(files));
    const info: DocumentInfo = { id, owner: owner.toLowerCase(), index, created: Date.now(), kind, ...(opts.modified ? { modified: opts.modified } : {}), ...(opts.test ? { test: true } : {}) };
    await this.saveInfo(info);
    if (!info.test && opts.expires != null) await this.storage.setAlarm(opts.expires);
    // Its first version: the files it starts from.
    const first = new Map(Object.entries(files).map(([path, data]) => [path, typeof data == "string" ? encoder.encode(data) : data]));
    // Copied as it is: the blobs it has were checked already, and its first open copies what's in the object to the blob store.
    if (this.deps.blobs && !Object.values(files).some((d) => d instanceof Uint8Array)) await this.storage.put(COPIED, { at: Date.now() });
    await this.versions.cut(first, index, [info.owner], "First version");
    // Who may open it, from the start: its first viewer needn't wait for the directory.
    await this.readPermissions(id).catch((e) => this.deps.log(`couldn't read ${id}'s permissions: ${e}`));
    return true;
  }

  /**
   * Local development: the document for a file or folder on disk, made if
   * it doesn't exist yet, and its row in the directory (its address the
   * folder's or file's name, `disk.slug`). Its files stay on disk (the dev
   * server connects to /api/mirror to reach them); it never expires, and
   * deleting it leaves them as they are.
   */
  async link(owner: string, id: string, index: string, disk: OnDisk): Promise<NamedRow> {
    const info = await this.readInfo();
    await this.saveInfo(info ? { ...info, index, disk } : { id, owner: owner.toLowerCase(), index, created: Date.now(), disk });
    await this.storage.deleteAlarm();
    return (await this.addRow())!;
  }

  /**
   * Files arriving whole (a publish, from the server's API): each written and
   * taken into the room as an edit "on disk", so open tabs see it at once.
   * What the room holds is written first, so a file replaces the text as it
   * is now (only edits made while it arrives merge with it). Text files go through the room's
   * push; others (images) are stored and the room told. `remove` deletes
   * files. Says what it did with each. `by`: who the edits are by, as a
   * version records it ("ada", "ada, via a shared agent (CI)": byLine).
   */
  async publish(files: Record<string, FileData>, remove: string[], by?: string): Promise<{ written: string[]; removed: string[]; refused: { path: string; why: string }[] }> {
    return this.hold(async () => {
      const opened = await this.room();
      if (!opened) throw new Error("There's no such document.");
      this.publisher = by ?? null;
      try { return await this.publishNow(opened, files, remove); } finally { this.publisher = null; }
    });
  }

  private async publishNow(opened: Opened, files: Record<string, FileData>, remove: string[]): Promise<{ written: string[]; removed: string[]; refused: { path: string; why: string }[] }> {
    const info = (await this.readInfo())!;
    const out = { written: [] as string[], removed: [] as string[], refused: [] as { path: string; why: string }[] };
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    // Edits not yet written land first, so a published file replaces what's there now rather than merging with it.
    await Effect.runPromise(opened.room.flush);
    const blobs = info.disk ? null : this.deps.blobs ?? null;
    for (const [path, data] of Object.entries(files)) {
      if (info.disk?.only && path != info.index) { out.refused.push({ path, why: `this document is the single file ${info.index}` }); continue; }
      const notPage = opened.room.exists(path) ? null : pageRefusal(info.kind ?? "project", path, info.index);
      if (notPage) { out.refused.push({ path, why: notPage }); continue; }
      // Its kind, decided as it arrives (D5): text if it's a text file's name, UTF-8 and at most TEXT_MAX bytes; else a blob.
      let text: string | null = null;
      if (typeof data == "string") text = data;
      else if (isTextPath(path) && data instanceof Uint8Array && (!blobs || data.length <= TEXT_MAX)) {
        try { text = decoder.decode(data); } catch { if (!blobs) { out.refused.push({ path, why: "not UTF-8 text" }); continue; } }
      }
      if (text != null && isTextPath(path) && (!blobs || text.length <= TEXT_MAX)) {
        const r = await Effect.runPromise(opened.room.push(path, text));
        if (r.ok) out.written.push(path); else out.refused.push({ path, why: r.reason ?? "refused" });
        continue;
      }
      if (info.disk) { out.refused.push({ path, why: "a document on disk takes only text files this way" }); continue; }
      if (path == info.index) { out.refused.push({ path, why: "it's the document's page, which is text" }); continue; }
      if (blobs) {
        const bytes = isBlobRef(data) ? undefined : typeof data == "string" ? new TextEncoder().encode(data) : data;
        const ref = isBlobRef(data) ? data : await storeBlob(blobs, bytes!);
        await Effect.runPromise(opened.room.putBlob(path, ref, bytes));
        out.written.push(path);
        continue;
      }
      if (isBlobRef(data)) { out.refused.push({ path, why: "this server keeps no blobs" }); continue; }
      await this.storage.put(FILE + path, typeof data == "string" ? new TextEncoder().encode(data) : data);
      await Effect.runPromise(opened.room.fileChanged(path));
      out.written.push(path);
    }
    for (const path of remove) {
      if (path == info.index) { out.refused.push({ path, why: "it's the document's page" }); continue; }
      if (info.disk) { out.refused.push({ path, why: "files on disk aren't deleted this way" }); continue; }
      if (await Effect.runPromise(opened.room.removeOne(path))) out.removed.push(path);
    }
    // In the history now, with the files (an image's bytes went straight to storage).
    if (out.written.length || out.removed.length) await Promise.all([Effect.runPromise(opened.room.flush), this.touch()]);
    return out;
  }

  /**
   * Changes the document's kind (the switch in the document's settings, or an agent: make_project, make_document):
   * a project may have more pages, a document one. The tree's operation checks a project has one page before it
   * becomes a document. Kept here, where the rule is checked, and in its row, which the documents list reads.
   */
  async setKind(kind: DocKind): Promise<void> {
    const info = await this.readInfo();
    if (!info || info.kind == kind) return;
    await this.saveInfo({ ...info, kind });
    await this.directory.setKind(info.id, kind);
  }

  /** Every file the document holds (the room's view: text files and others). */
  async paths(): Promise<string[]> {
    const opened = await this.room();
    if (!opened) { this.open = null; return []; }
    return [...new Set([...texts(opened.room.doc).keys(), ...assets(opened.room.doc).keys()])].sort();
  }

  /** The document's page, or null if there's no such document. */
  async index(): Promise<string | null> {
    return (await this.readInfo())?.index ?? null;
  }

  /**
   * Every file the document holds as it is now (text from the room, so the
   * latest edits are in it), and its page: what a copy of it starts from.
   * Null if there's no such document.
   */
  async snapshot(): Promise<{ index: string; files: Record<string, FileData> } | null> {
    const info = await this.readInfo();
    const opened = info && await this.room();
    if (!info || !opened) { if (!opened) this.open = null; return null; }
    // Text as text, a blob as its ref.
    const files: Record<string, FileData> = {};
    for (const [path, data] of await opened.entries()) files[path] = data instanceof Uint8Array && opened.room.text(path) != null ? opened.room.text(path)! : data;
    return { index: info.index, files };
  }

  /** Deletes the document (the front door has asked the directory who may): everyone on it is disconnected. */
  async delete(): Promise<boolean> {
    const info = await this.readInfo();
    if (!info) return false;
    await this.destroy(info);
    return true;
  }

  /**
   * Puts a document on disk in the directory if it isn't there yet, as it is
   * now: its row. Anyone signed in may edit it (on this machine, that's
   * whoever local development lets in). Null if there's no such document.
   */
  private async addRow(): Promise<NamedRow | null> {
    const info = await this.readInfo();
    if (!info) return null;
    const text = await this.pageText(info);
    const { doc } = await this.directory.add({
      id: info.id, owner: info.owner,
      title: (text && titleOf(text)) || UNTITLED,
      // A test document's address stays its id (the suite addresses it so); one on disk is its folder's or file's name.
      ...(info.test ? { slug: info.id, slugSet: true } : info.disk ? { slug: info.disk.slug, slugSet: true } : {}),
      created: info.created, modified: info.modified ?? null,
      expires: info.modified || info.test || info.disk ? null : (await this.storage.getAlarm()),
      test: info.test, kind: info.kind,
      ...(info.disk ? { everyone: "editor" as const } : {}),
    });
    return doc;
  }

  /**
   * The alarm: its unedited time is up, so a document nobody has edited goes.
   * One open somewhere waits an hour more, so it isn't pulled from under
   * someone about to type. If delete_docs_after_hours is now never, it stays.
   */
  async wake(): Promise<void> {
    const info = await this.readInfo();
    if (!info) return;
    const next = afterUnedited(info, this.deps.tabs.count() > 0, Date.now());
    if (next == "keep") return;
    if ((await this.directory.config.get("delete_docs_after_hours")) == null) {
      await this.directory.setExpires(info.id, null).catch((e) => this.deps.log(`couldn't update ${info.id}'s row: ${e}`));
      return;
    }
    if (next != "delete") {
      await this.storage.setAlarm(next);
      await this.directory.setExpires(info.id, next).catch((e) => this.deps.log(`couldn't update ${info.id}'s row: ${e}`));
      return;
    }
    this.deps.log(`deleting ${info.owner}/${info.id}: never edited`);
    await this.destroy(info);
  }

  private async destroy(info: DocumentInfo): Promise<void> {
    // One on disk writes what it holds there first, while the dev server is still connected.
    if (info.disk && this.opened) await Effect.runPromise(this.opened.room.flush);
    this.deps.tabs.closeAll(4404, "document deleted");
    this.clearPending();
    // The room writes what it holds as it closes, so it closes before storage is cleared.
    const opened = await this.open;
    this.open = null;
    this.opened = null;
    await opened?.close();
    await this.closing;
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
    this.forgetStorage();
    await this.directory.remove(info.id);
    // If it was the homepage, its snapshot goes too (the next / makes another).
    await this.deps.home.forget(info.id).catch((e) => this.deps.log(`couldn't tell the homepage: ${e}`));
  }

  /**
   * Brings its row up to date after edits: when it was last edited, and the
   * title, which follows its first heading until someone sets it (and the
   * slug the title). Every open tab hears of a new title or address.
   */
  private async syncDirectory(): Promise<void> {
    const info = await this.readInfo();
    if (!info) return;
    const text = await this.pageText(info);
    const r = await this.directory.edited(info.id, {
      modified: info.modified ?? null,
      pageTitle: text != null ? titleOf(text) : null,
    });
    if (r) await this.rememberName(nameOf(r.doc));
    if (r?.renamed) (await this.open)?.renamed(nameOf(r.doc));
  }

  /**
   * The document's title and address as the directory last said (D1 stays
   * the truth: every rename goes through this document, which keeps what
   * the directory answers), so opening it asks the directory nothing.
   */
  private async rememberName(name: DocName): Promise<DocName> {
    const info = await this.readInfo();
    if (info && JSON.stringify(info.name) != JSON.stringify(name)) await this.saveInfo({ ...info, name });
    return name;
  }

  /** A message for everyone who has the document open (the homepage's deploy status). Opens nothing. */
  notify(msg: unknown): void {
    this.opened?.notify(msg);
  }

  /**
   * The page's text: from the room while it's open (storage has it a little
   * later), else from storage; for a document on disk only from its room
   * (once it's open; never waited for, since opening waits for the dev
   * server, which may be linking it just then).
   */
  private async pageText(info: DocumentInfo): Promise<string | null> {
    const open = this.opened?.room.text(info.index);
    if (open != null || info.disk) return open ?? null;
    await this.closing;
    const bytes = await this.storage.get<Uint8Array>(FILE + info.index);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  /**
   * A file changed: the document has been edited, so it stays (and its row
   * says when). Only its record is written (in the same transaction as the
   * files, when the room writes them), and its alarm deleted once.
   */
  private async touch(): Promise<void> {
    const info = await this.readInfo();
    if (!info) return;
    info.modified = Date.now();
    const writes = [this.saveInfo(info)];
    if (!info.test && !this.kept) { this.kept = true; writes.push(this.storage.deleteAlarm()); }
    await Promise.all(writes);
    // At most every DIRECTORY_EVERY_MS, however fast the edits come; the last always lands.
    this.sync ??= throttle(() => this.syncDirectory().catch((e) => this.deps.log(`couldn't update ${info.id}'s row: ${e}`)), DIRECTORY_EVERY_MS);
    this.sync();
  }

  /** Where its files are, for a document on disk (local development); null for any other. */
  async diskPath(): Promise<string | null> {
    return (await this.readInfo())?.disk?.path ?? null;
  }

  /** Whether it is a document on disk. */
  async onDisk(): Promise<boolean> {
    return !!(await this.readInfo())?.disk;
  }

  /** Whether the document exists. */
  async exists(): Promise<boolean> {
    return (await this.readInfo()) != null;
  }

  /** A file on disk changed (the dev server says which): the room takes it. */
  async diskChanged(path: string): Promise<void> {
    const o = await this.open;
    if (o) await Effect.runPromise(o.room.fileChanged(path));
  }

  /** The dev server is back: every file there, and every one the room holds, is looked at again. */
  async diskConnected(): Promise<void> {
    await (await this.open)?.catchUp();
  }

  /** Writes what the room holds (before the dev server goes). */
  async flush(): Promise<void> {
    const o = await this.open;
    if (o) await Effect.runPromise(o.room.flush);
  }

  /**
   * A part of its storage, and its alarm: the snapshot staging copies,
   * a part at a time, since the whole can be more than
   * one RPC carries. Only reads: the room isn't opened, nothing is written,
   * the directory isn't touched. Null if there's no document.
   */
  async exportStorage(id: string, page: Page): Promise<DocSnapshot | null> {
    if (page.after == null && (await this.storage.get(INFO)) == null) return null;
    // An open room writes its files first, so the copy has them as they are (else it writes them as it opens there).
    if (page.after == null) await this.flush().catch(() => {});
    const storage = this.storage;
    return exportPage(id, page, await storage.getAlarm(), (after, limit) => storage.list(after == null ? { limit } : { startAfter: after, limit }));
  }

  /**
   * Becomes `snap` (staging only: the front door allows it only with
   * SNAPSHOT_IMPORT, never on production): whoever has it open is
   * disconnected and the room closed first (it writes what it holds as it
   * closes), then its storage is emptied and the snapshot written in. A
   * later part (`append`) is only written in.
   */
  async importStorage(snap: DocSnapshot): Promise<void> {
    await this.closeForSnapshot();
    if (!snap.append) {
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
    }
    const entries = Object.fromEntries(snap.entries.map(([k, e]) => [k, decodeValue(e)]));
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += 100) await this.storage.put(Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, entries[k]])));
    if (snap.alarm != null) await this.storage.setAlarm(snap.alarm);
    this.forgetStorage();
  }

  /** Empties it (staging only: a document production no longer has). The directory row is already gone with the old database. */
  async wipeStorage(): Promise<void> {
    await this.closeForSnapshot();
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
    this.forgetStorage();
  }

  private async closeForSnapshot(): Promise<void> {
    this.deps.tabs.closeAll(1012, "document replaced by a snapshot");
    const opened = await this.open?.catch(() => null);
    this.open = null;
    this.opened = null;
    await opened?.close().catch(() => {});
    await this.closing;
  }

  /**
   * A request inside the document (not a WebSocket: the adapter takes those
   * after `admit`). Viewers see the files as they are now, at /doc/.
   */
  async handle(request: Request): Promise<Response> {
    const allowed = await this.authorize(request);
    if (allowed instanceof Response) return allowed;
    request = allowed;
    return this.serve(request);
  }

  private async serve(request: Request): Promise<Response> {
    if (request.method == "PUT" && new URL(request.url).pathname.startsWith("/api/files/")) return this.hold(() => this.upload(request));
    // Someone viewing it: its files straight from storage while the room isn't open, without opening it
    // (once a room closing a moment ago has written them).
    await this.closing;
    const stored = this.opened || this.open ? null : await this.storedFile(request);
    if (stored) return stored;
    return this.hold(async () => {
      const opened = await this.admit(request);
      // Not made yet: asked again next time, since it may be by then (made, or linked from disk).
      if (!opened) return new Response("No such document", { status: 404 });
      return opened.handler(request);
    });
  }

  /**
   * Opens the document for a request and notes what the front door said the
   * person may do; null if there's no such document. The adapter calls it
   * before it accepts a WebSocket.
   */
  async admit(request: Request): Promise<Opened | null> {
    const opened = await this.room();
    if (!opened) { this.open = null; return null; }
    if (request.headers.has("x-erga-person")) this.editors.set(personOf(request.headers).id, request.headers.get("x-erga-access") == "edit");
    return opened;
  }

  /**
   * A person's agent run that a restart cut off goes on (their object's alarm
   * asks: cloudflare/objects/person-agent.ts). Until the person comes back,
   * what they may do is what the directory says now.
   */
  async resumeAgent(person: Person): Promise<void> {
    const info = await this.readInfo();
    const opened = info && await this.room();
    if (!info || !opened) { if (!opened) this.open = null; return; }
    if (!this.editors.has(person.id)) {
      const test = person.id.startsWith("test-");
      const role = await this.roleOf(test ? { login: person.id, test, by: info.owner } : { login: person.id });
      this.editors.set(person.id, role == "owner" || role == "editor");
    }
    await opened.resumeAgent(person);
  }

  /**
   * A tab joins the room over a socket the adapter holds: `send` carries the
   * room's messages to it. Returns what to do with the tab's messages and
   * its going, or null when the tab holds another epoch's history (it is
   * refused, never merged). Someone who may only view joins read-only: they
   * see every edit, and theirs go nowhere.
   */
  joinRoom(opened: Opened, o: { epoch: string | null; readOnly: boolean; send: (m: Uint8Array | string) => void; events?: Person | null; watch?: boolean }): { receive: (data: Uint8Array) => boolean; left: () => void } | null {
    // A files view: it hears what every tab hears (the tree changing), as text, and never joins the room.
    if (o.watch && o.events) {
      const leave = opened.addTab(o.events.id, (msg) => o.send(JSON.stringify(msg)), true);
      return { receive: () => true, left: leave };
    }
    if (o.epoch && o.epoch != opened.room.epoch) return null;
    // A tab that hears events (an editor's) first hears what it needs to start: the document's details as its person
    // sees them, and its tree (host.ts, hello); then, once their agent's session is up, its state. Its person's
    // events (their agent's, a rename, the tree changing) come over the same socket, as text.
    const person = o.events;
    const json = (msg: unknown) => o.send(JSON.stringify(msg));
    let tab: (() => void) | null = null;
    if (person) {
      void opened.hello(person, !o.readOnly).then(json, (e: unknown) => this.deps.log(`couldn't greet ${person.id}'s tab: ${e}`));
      tab = opened.addTab(person.id, json);
      void opened.agentState(person).then((state) => json({ type: "agent-state", state }), () => {});
    }
    const conn: Connection | null = opened.room.connect(o.send, { epoch: o.epoch, readOnly: o.readOnly });
    if (!conn) { tab?.(); return null; }
    // When the last person who may edit leaves, what they did is a version.
    let gone = false;
    if (!o.readOnly) this.editing++;
    return {
      receive: (data) => conn.receive(data),
      left: () => {
        if (gone) return;
        gone = true;
        conn.close();
        tab?.();
        if (!o.readOnly && --this.editing == 0) void this.cutSoon("left");
      },
    };
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
    if ((request.method != "GET" && request.method != "HEAD") || !url.pathname.startsWith("/doc/") || request.headers.get("upgrade")) return null;
    const info = await this.readInfo();
    if (!info || info.disk) return null;
    // doc/ itself is its page (the viewer's frame asks for it so, at the token's own address: server/documents/pages-origin.ts).
    const rel = url.pathname == "/doc/" ? info.index : cleanRel(url.pathname.slice("/doc/".length));
    if (!rel) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    // The file (its bytes, or its ref if it's a blob), and the files whose latest text storage doesn't have yet (the room
    // stopped before writing them): one read.
    const got = await this.storage.get<unknown>([FILE + rel, REF + rel, KEYS.unwritten]);
    if ((got.get(KEYS.unwritten) as string[] | undefined)?.includes(rel)) return null;
    const ref = got.get(REF + rel);
    if (isBlobRef(ref) && this.deps.blobs && !request.headers.get(INLINE_HEADER)) return blobPointer(ref, typeOf(rel), { "Cache-Control": "no-cache" });
    const bytes = (got.get(FILE + rel) as Uint8Array | undefined) ?? (isBlobRef(ref) ? (await this.deps.blobs?.bytes(ref.hash)) ?? undefined : undefined);
    if (!bytes) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const r = docFile(rel, bytes, request.headers.get("if-none-match"), request.headers.get("range"), "stored");
    return new Response(request.method == "HEAD" ? null : (r.body as Uint8Array<ArrayBuffer>), { status: r.status, headers: { "Content-Type": r.type, ...r.headers } });
  }

  // ---------------------------------------------------------------- who may, and what viewers see

  /**
   * A request from the front door, decided here: who it's from (x-erga-who,
   * the person the front door signed in) and what their permission lets them
   * do, from this document's copy of its permissions (Directory.decide, the
   * directory's own rule). It goes on with x-erga-access; a Response refuses
   * it. A GET of a file with a key the front door checked (x-erga-checked:
   * the viewer's files, the editor's pages origin) needs no one.
   */
  async authorize(request: Request): Promise<Request | Response> {
    const headers = new Headers(request.headers);
    headers.delete("x-erga-access");
    const url = new URL(request.url);
    const read = request.method == "GET" || request.method == "HEAD";
    if (headers.has("x-erga-checked")) {
      headers.delete("x-erga-who");
      if (read && url.pathname.startsWith("/doc/") && !headers.get("upgrade")) return new Request(request, { headers });
      return new Response("Not allowed", { status: 403 });
    }
    let who: Asker | null = null;
    try {
      who = JSON.parse(headers.get("x-erga-who") ?? "null") as Asker | null;
    } catch {
      /* nobody */
    }
    if (!who || typeof who.login != "string") return new Response("Sign in first", { status: 401 });
    const info = await this.readInfo();
    if (!info) return new Response("No such document", { status: 404 });
    const access = accessOf(await this.roleOf(who));
    if (!access) return new Response("Not allowed", { status: 403 });
    headers.set("x-erga-access", access);
    return new Request(request, { headers });
  }

  /** What `who` may do with the document, as a role (null: nothing), from its copy of its permissions. */
  async roleOf(who: Asker): Promise<Role | null> {
    const info = await this.readInfo();
    if (!info) return null;
    return this.directory.decide(who, { id: info.id, owner: info.owner, test: !!info.test }, await this.permissions(info.id));
  }

  /** The directory says who may do what with this document now (every change is pushed here). */
  async setPermissions(list: readonly { login: string; role: Role }[], at = Date.now()): Promise<void> {
    if (this.perms === undefined) this.perms = (await this.storage.get<{ list: { login: string; role: Role }[]; at: number }>(PERMS)) ?? null;
    if (this.perms && this.perms.at > at) return;
    this.perms = { list: list.map((p) => ({ login: p.login, role: p.role })), at };
    await this.storage.put(PERMS, this.perms);
  }

  /**
   * Its permissions: the copy it keeps, read from the directory when it has
   * none, and again (meanwhile answering with the copy) once the copy is
   * older than PERMISSIONS_FRESH_MS, in case a change didn't reach it.
   */
  private async permissions(id: string): Promise<{ login: string; role: Role }[]> {
    if (this.perms === undefined) this.perms = (await this.storage.get<{ list: { login: string; role: Role }[]; at: number }>(PERMS)) ?? null;
    const kept = this.perms;
    if (kept && Date.now() - kept.at < PERMISSIONS_FRESH_MS) return kept.list;
    const fresh = this.readPermissions(id);
    if (!kept) return fresh;
    this.deps.background(fresh.catch((e) => this.deps.log(`couldn't read ${id}'s permissions: ${e}`)));
    return kept.list;
  }

  private async readPermissions(id: string): Promise<{ login: string; role: Role }[]> {
    const at = Date.now();
    const list = await this.directory.permissions(id);
    // (None: a row not there yet, or gone. Nothing is kept, so the next request asks again.)
    if (list.length) await this.setPermissions(list, at);
    return list;
  }

  /** A file changed: what viewers see is worked out again. */
  private viewChanged(): void {
    // The first change after a quiet while: a viewer's answer kept meanwhile (view's `quiet`) is out of date.
    if (Date.now() - this.lastChange > QUIET_MS) { const id = this.info?.id; if (id) this.deps.viewChanged?.(id); }
    this.lastChange = Date.now();
    this.latestView = null;
    if (!this.viewKept) return;
    this.viewKept = false;
    void this.storage.delete(VIEW).catch((e) => this.deps.log(`couldn't forget the view: ${e}`));
  }

  /**
   * What viewers see now, and its version: a digest of the files (their paths
   * and digests) and the page, so the same files are always the same version,
   * whatever happened between: the files as they are now (from the room, or
   * kept in storage while no file has changed: a request needn't open the room).
   */
  private async viewNow(info: DocumentInfo): Promise<ViewState> {
    if (this.latestView && this.latestView.index == info.index) return this.latestView;
    if (!this.opened && !info.disk) {
      await this.closing;
      const kept = await this.storage.get<ViewState>(VIEW);
      if (kept && kept.index == info.index) { this.viewKept = true; return (this.latestView = kept); }
    }
    const opened = await this.room();
    if (!opened) { this.open = null; throw new Error("There's no such document."); }
    const doc = opened.room.doc, encoder = new TextEncoder();
    const entries: [string, string][] = [];
    for (const [path, text] of texts(doc).entries()) entries.push([path, digest(encoder.encode(text.toString()))]);
    for (const [path, d] of assets(doc).entries()) if (!texts(doc).has(path)) entries.push([path, d]);
    entries.sort(([a], [b]) => (a < b ? -1 : 1));
    const state: ViewState = { ver: "l" + hashText(JSON.stringify([info.index, entries])), index: info.index, paths: entries.map(([p]) => p) };
    this.latestView = state;
    this.viewKept = true;
    if (!info.disk) await this.storage.put(VIEW, state);
    return state;
  }



  /**
   * A document's page for a viewer (the front door's viewer, server/documents/view.ts), in one call: what `who` may do
   * (`anyone`: the front page, which everyone may view), which file the address `page` is (its path under the
   * document's; "" its own page) in what viewers see, that version, and the document's name (the page itself comes
   * from the document's pages origin: server/documents/pages-origin.ts). Null if there's no such document.
   */
  async view(who: Asker | null, opts: { page: string; anyone?: boolean }): Promise<ViewAnswer | null> {
    const info = await this.readInfo();
    if (!info) return null;
    const role = who ? await this.roleOf(who) : null;
    const name = info.name ?? null;
    if (!role && !opts.anyone) return { role: null, name, test: !!info.test };
    return this.hold(async () => {
      const state = await this.viewNow(info);
      const paths = new Set(state.paths);
      const found = opts.page ? resolvePage((p) => paths.has(p), opts.page, state.index) : paths.has(state.index) ? { file: state.index, canonical: "" } : null;
      // Quiet: no file changed in a while, so the front door may keep this answer a moment. A document being edited is
      // asked each time.
      const quiet = Date.now() - this.lastChange > QUIET_MS;
      return { role, name, test: !!info.test, ver: state.ver, file: found?.file ?? null, canonical: found?.canonical ?? null, quiet };
    });
  }



  // ---------------------------------------------------------------- versions

  /**
   * An edit reached the room (a file's text, or another file, changed), by
   * `author`. When to cut a version, so that a burst of edits is one version:
   *
   * - edits pause for `idleMs` (30 seconds);
   * - a burst has gone on for `maxMs` (5 minutes) since its first edit;
   * - an agent's turn ends (the embedded agent's, or an external agent's
   *   calls, 8 seconds after its last), so an agent's turn is one version:
   *   while any agent works, the two rules above wait for it;
   * - the last person who may edit leaves (their room connection closes);
   * - when the room opens, if what it holds isn't the latest version (edits
   *   made while timers couldn't run: the object was evicted).
   *
   * A cut that finds nothing changed since the latest version makes none.
   */
  private noteEdit(author: string | null): void {
    const p = this.pending;
    p.dirty = true;
    this.activity();
    if (author) p.authors.add(author);
    if (!p.since) {
      p.since = Date.now();
      // Stored, so a document stopped before it cut the version cuts it as it opens again.
      void this.markUncut(true);
      const burst = () => { p.max = this.agentWorking() ? setTimeout(burst, this.idleMs) : null; if (!p.max) void this.cutSoon("burst"); };
      p.max = setTimeout(burst, this.maxMs);
    }
    if (p.idle) clearTimeout(p.idle);
    const idle = () => { p.idle = this.agentWorking() ? setTimeout(idle, this.idleMs) : null; if (!p.idle) void this.cutSoon("idle"); };
    p.idle = setTimeout(idle, this.idleMs);
  }

  /** Notes in its record whether it has edits no version holds yet (only when that changes). */
  private async markUncut(uncut: boolean): Promise<void> {
    const info = await this.readInfo();
    if (!info || !!info.uncut == uncut) return;
    const { uncut: _, ...rest } = info;
    await this.saveInfo(uncut ? { ...rest, uncut } : rest).catch((e) => this.deps.log(`couldn't note the edits: ${e}`));
  }

  /** Whether any agent in the room is in the middle of a turn (its busy flag, on awareness). */
  private agentWorking(): boolean {
    const room = this.opened?.room;
    if (!room) return false;
    for (const state of room.awareness.getStates().values()) {
      const s = state as { busy?: boolean; user?: Author } | null;
      if (s?.busy && s.user?.kind == "agent") return true;
    }
    return false;
  }

  private clearPending(): { authors: string[]; dirty: boolean } {
    const p = this.pending;
    if (p.idle) clearTimeout(p.idle);
    if (p.max) clearTimeout(p.max);
    const out = { authors: [...p.authors], dirty: p.dirty };
    this.pending = { dirty: false, since: 0, authors: new Set(), idle: null, max: null };
    return out;
  }

  /** Cuts a version of what the document holds now (after any cut under way); the new version, or null if nothing changed. */
  private cutSoon(reason: string, as?: { authors: string[]; description: string }): Promise<StoredVersion | null> {
    const run = this.cutting.then(() => this.cutNow(reason, as));
    this.cutting = run.catch((e) => this.deps.log(`couldn't cut a version (${reason}): ${e instanceof Error ? e.stack : e}`));
    return run;
  }

  private async cutNow(_reason: string, as?: { authors: string[]; description: string }): Promise<StoredVersion | null> {
    // Edits from in-process peers (agents) sync on microtasks: they've reached the room by the next macrotask.
    await sleep(0);
    const opened = this.opened;
    const info = await this.readInfo();
    if (!opened || !info) return null;
    const { authors } = this.clearPending();
    const r = await this.versions.cut(await opened.entries(), info.index, as?.authors ?? authors, as?.description ?? ((await this.versions.head()) == 0 ? "First version" : null), opened.room.folderPaths());
    if (!this.pending.dirty) await this.markUncut(false);
    // At a version, a long log becomes a snapshot: the next open reads less.
    await Effect.runPromise(opened.room.settle);
    if (!r) return null;
    opened.broadcast({ type: "versions" });
    this.versionCut(info.id);
    if (r.previous && !as) this.deps.background(this.describe(r.version, r.previous, info).catch((e) => this.deps.log(`couldn't describe version ${r.version.n}: ${e}`)));
    return r.version;
  }

  /** Writes a version's description in the background: the model's five words, or the fallback. Never in the way of editing. */
  private async describe(version: StoredVersion, previous: StoredVersion, info: DocumentInfo): Promise<void> {
    const changes = await this.versions.changes(previous, version);
    // The agent's key, as it is now (an admin may have stored one since the document opened).
    const key = info.test ? "" : await this.deps.agents.descriptionKey();
    const text = (key ? await describeChange(key, changes) : null) ?? fallbackDescription(changes);
    await this.versions.describe(version.n, text);
    this.opened?.broadcast({ type: "versions" });
  }

  /** A new version: the homepage, which shows the document as it is, deploys again soon. */
  private versionCut(docId: string): void {
    // If it's the homepage, its next deploy is scheduled.
    this.deps.background(this.directory.homeId().then((home) => home == docId ? this.deps.home.changed(docId) : undefined)
      .catch((e) => this.deps.log(`couldn't schedule the homepage's deploy: ${e}`)));
  }

  /** Opens the document and waits for any cut under way (the first, when it opens, makes sure there is a version). */
  private async ready(): Promise<{ opened: Opened; info: DocumentInfo } | null> {
    const opened = await this.room();
    if (!opened) { this.open = null; return null; }
    await this.cutting;
    if ((await this.versions.head()) == 0) await this.cutSoon("first");
    const info = await this.readInfo();
    return info ? { opened, info } : null;
  }

  /** Its versions, newest first (`limit`, before version `before`), and the current one. Null if there's no such document. */
  async versionsState(opts: { before?: string | number | null; limit?: number } = {}): Promise<VersionsState | null> {
    const r = await this.ready();
    if (!r) return null;
    const before = opts.before != null ? versionNumber(opts.before) : null;
    const { versions, total } = await this.versions.list({ before, limit: opts.limit });
    const latest = (await this.versions.latest())!;
    return { current: publicVersion(latest), versions: versions.map(publicVersion), total, pending: this.pending.dirty };
  }

  /** One version (by id or number), with its files' paths; null if there's none. */
  async version(ref: string | number): Promise<(Version & { files: string[]; index: string }) | null> {
    const n = versionNumber(ref);
    if (!(await this.ready()) || n == null) return null;
    const v = await this.versions.get(n);
    return v && { ...publicVersion(v), index: v.index, files: Object.keys(v.files) };
  }

  /** One file of a version; null if there's no such version or file. */
  async versionFile(ref: string | number, path: string): Promise<Uint8Array | null> {
    const n = versionNumber(ref);
    if (!(await this.ready()) || n == null) return null;
    const v = await this.versions.get(n);
    return v ? this.versions.file(v, path) : null;
  }

  /**
   * Brings a version back: its files are written over the document as it
   * is now (every file: those it didn't have are deleted), as an edit open
   * editors see live, and that becomes a new version, the current one, by
   * `by`, "Restored version <n>". With `path`, only that file comes back
   * ("Restored <path> from version <n>"); the other files stay as they are.
   * Edits not yet in a version become one first, so nothing is lost.
   * Viewers then see it.
   */
  async restore(ref: string | number, by: string, path?: string | null): Promise<RestoreResult> {
    const r = await this.ready();
    if (!r) return { ok: false, status: 404, error: "There's no such document." };
    const n = versionNumber(ref);
    const v = n != null ? await this.versions.get(n) : null;
    if (!v) return { ok: false, status: 404, error: `There's no version ${ref} of this document: its versions are v1 to v${await this.versions.head()}.` };
    if (path != null) {
      path = path.replace(/^\.?\/+/, "");
      if (!(path in v.files)) return { ok: false, status: 404, error: `Version ${v.n} has no file ${path}: its files are ${Object.keys(v.files).sort().join(", ")}.` };
    }
    await this.cutSoon("restore");
    const files = await this.versions.entries(v);
    if (path != null) {
      const out = await this.publish({ [path]: files.get(path)! }, [], by);
      if (out.refused.length) return { ok: false, status: 409, error: `Couldn't restore ${path}: ${out.refused[0].why}.` };
      const made = await this.cutSoon("restored", { authors: [by], description: `Restored ${path} from version ${v.n}` });
      return { ok: true, current: publicVersion(made ?? (await this.versions.latest())!), from: v.id, files: [path] };
    }
    const room = r.opened.room;
    // Folders it didn't have go (unless something of it is inside); then its files over the current ones; then its folders.
    const keep = [...files.keys(), ...(v.folders ?? [])];
    for (const d of room.folderPaths()) if (!keep.some((p) => p == d || p.startsWith(`${d}/`)) && room.exists(d) == "folder") await Effect.runPromise(room.remove(d)).catch(() => {});
    const now = new Set((await r.opened.current()).keys());
    const out = await this.publish(Object.fromEntries(files), [...now].filter((p) => !files.has(p)), by);
    for (const d of v.folders ?? []) if (room.exists(d) != "folder") await Effect.runPromise(room.mkdir(d)).catch(() => {});
    if (out.refused.length) this.deps.log(`restoring ${v.id}: ${out.refused.map((x) => `${x.path} (${x.why})`).join(", ")}`);
    const made = await this.cutSoon("restored", { authors: [by], description: `Restored version ${v.n}` });
    return { ok: true, current: publicVersion(made ?? (await this.versions.latest())!), from: v.id, files: [...files.keys()].sort() };
  }

  /**
   * The document as it is now (up to the keystroke), with its current
   * version: what the homepage and the document's site deploy.
   */
  async currentFiles(): Promise<{ version: Version; index: string; files: Map<string, Uint8Array> } | null> {
    const r = await this.ready();
    if (!r) return null;
    return { version: publicVersion((await this.versions.latest())!), index: r.info.index, files: await r.opened.current() };
  }

  // ---------------------------------------------------------------- files arriving whole, and blobs

  /**
   * PUT /api/files/<path>: one file from a person or an HTTP client (the
   * files view's drop), its bytes the body, its size Content-Length. Its
   * kind is decided now (D5): a text file's name, UTF-8 and at most TEXT_MAX
   * bytes is text, merged into the room as a publish is; anything else is a
   * blob, which streams to the blob store (`x-erga-sha256`, the bytes'
   * sha-256 in hex, lets one of any size stream: without it, one over
   * BUFFER_MAX is refused). A file at the path is replaced (it stays in the
   * versions): the answer says so. Refused when the file, or the project
   * with it, would pass the limits an admin sets (max_file_mb, max_project_gb).
   */
  private async upload(request: Request): Promise<Response> {
    const fail = (status: number, error: string) => { void request.body?.cancel().catch(() => {}); return json({ ok: false, error }, status); };
    if (request.headers.get("x-erga-access") != "edit") return fail(403, "You can only view this document.");
    const path = cleanRel(new URL(request.url).pathname.slice("/api/files/".length));
    if (!path) return fail(400, "Name the file in the address, PUT /api/files/<path>: a path inside the document, with no \"..\" and no part that starts with a dot.");
    const opened = await this.room();
    if (!opened) { this.open = null; return fail(404, "There's no such document."); }
    const length = request.headers.get("content-length");
    const size = Number(length);
    if (length == null || !Number.isInteger(size) || size < 0) return fail(411, "Send the file's size in bytes as Content-Length.");
    const check = await this.mayAdd(opened, path, size);
    if (!check.ok) return fail(check.status, check.error);
    const info = (await this.readInfo())!;
    const blobs = info.disk ? null : this.deps.blobs ?? null;
    const person = personOf(request.headers);
    const by = byLine(person.id, request.headers.get("x-erga-agent") ? viaOf(request.headers.get("x-erga-via") ?? undefined) : null);
    // Small files (and every file, without a blob store) come whole: a text may be one, and a small blob stays in the object too.
    const given = request.headers.get("x-erga-sha256")?.trim().toLowerCase() ?? "";
    if (!blobs || size <= Math.max(TEXT_MAX, OBJECT_MAX) || !/^[0-9a-f]{64}$/.test(given)) {
      if (blobs && size > BUFFER_MAX) return fail(400, `${path} is ${megabytes(size)}: send its sha-256 (hex) as x-erga-sha256, so a file over ${BUFFER_MAX / MB} MB can stream.`);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length != size) return fail(400, `The body had ${bytes.length} bytes, not the ${size} of its Content-Length.`);
      const r = await this.addBytes(opened, path, bytes, by);
      return r.ok ? json({ ok: true, path, kind: r.kind, size, ...(r.hash ? { hash: r.hash } : {}), replaced: check.replaced }) : fail(r.status, r.error);
    }
    if (path == info.index) return fail(409, `${path} is the document's page, which is text: it can't be replaced by a file that isn't.`);
    // A big blob streams to the store, which checks the bytes against the hash: a wrong one stores nothing.
    if (await blobs.head(given)) void request.body?.cancel().catch(() => {});
    else {
      try { await blobs.put(given, request.body ?? new Uint8Array(), size); } catch (e) {
        return fail(400, `${path} wasn't stored: ${e instanceof Error ? e.message : String(e)}. Check its x-erga-sha256 and Content-Length.`);
      }
    }
    const ref: BlobRef = { hash: given, size, at: Date.now() };
    this.publisher = by;
    try { await Effect.runPromise(opened.room.putBlob(path, ref)); } finally { this.publisher = null; }
    return json({ ok: true, path, kind: "file", size, hash: ref.hash, replaced: check.replaced });
  }

  /**
   * Whether a file of `size` bytes may be added at `path`: not over a
   * folder, not inside a file, and within the limits an admin sets (one
   * file, and the project with it); whether it replaces a file there.
   */
  private async mayAdd(opened: Opened, path: string, size: number): Promise<{ ok: true; replaced: boolean } | { ok: false; status: number; error: string }> {
    const maxMb = (await this.directory.config.get("max_file_mb")) as number;
    if (size > maxMb * MB) return { ok: false, status: 413, error: `${path} is ${megabytes(size)}: a file can have at most ${maxMb} MB here (an admin sets it: max_file_mb).` };
    const room = opened.room;
    const at = room.exists(path);
    if (at == "folder") return { ok: false, status: 409, error: `There's a folder at ${path}: a file can't take its place.` };
    const inFile = parentsOf(path).find((d) => room.exists(d) == "file");
    if (inFile) return { ok: false, status: 409, error: `${inFile} is a file, so nothing can go inside it.` };
    const notPage = at ? null : pageRefusal((await this.readInfo())?.kind ?? "project", path, (await this.readInfo())?.index ?? "index.html");
    if (notPage) return { ok: false, status: 409, error: notPage };
    const maxGb = (await this.directory.config.get("max_project_gb")) as number;
    const used = (await this.bytesUsed(opened)) - (at == "file" ? await this.sizeOf(opened, path) : 0);
    if (used + size > maxGb * GB) return { ok: false, status: 413, error: `The files here have ${megabytes(used)} together: with ${path} (${megabytes(size)}) they'd pass the ${maxGb} GB a project can have (an admin sets it: max_project_gb).` };
    return { ok: true, replaced: at == "file" };
  }

  /**
   * A file's bytes, arriving whole (an upload, an agent's write of bytes), as
   * `by`: its kind decided now (D5), text merged into the room as a publish
   * is, anything else a blob.
   */
  private async addBytes(opened: Opened, path: string, bytes: Uint8Array, by: string): Promise<{ ok: true; kind: "text" | "file"; hash?: string } | { ok: false; status: number; error: string }> {
    const info = (await this.readInfo())!;
    const blobs = info.disk ? null : this.deps.blobs ?? null;
    let text: string | null = null;
    if (isTextPath(path) && bytes.length <= TEXT_MAX) {
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { /* not UTF-8: a blob */ }
    }
    if (text != null || !blobs) {
      const r = await this.publish({ [path]: text ?? bytes }, [], by);
      if (r.refused.length) return { ok: false, status: 409, error: `Couldn't add ${path}: ${r.refused[0].why}.` };
      return { ok: true, kind: text != null ? "text" : "file" };
    }
    if (path == info.index) return { ok: false, status: 409, error: `${path} is the document's page, which is text: it can't be replaced by a file that isn't.` };
    const ref = await storeBlob(blobs, bytes);
    this.publisher = by;
    try { await Effect.runPromise(opened.room.putBlob(path, ref, bytes)); } finally { this.publisher = null; }
    return { ok: true, kind: "file", hash: ref.hash };
  }

  /** An agent's write of bytes (document/host.ts, putFile): as an upload, within its limits; throws why not. */
  private async putFile(path: string, bytes: Uint8Array, by: string): Promise<{ kind: "text" | "file"; replaced: boolean }> {
    return this.hold(async () => {
      const opened = await this.room();
      if (!opened) { this.open = null; throw new Error("There's no such document."); }
      const clean = cleanRel(path);
      if (!clean) throw new Error(`${path} isn't a path a file can have here (no "..", and no part that starts with a dot).`);
      const check = await this.mayAdd(opened, clean, bytes.length);
      if (!check.ok) throw new Error(check.error);
      const r = await this.addBytes(opened, clean, bytes, by);
      if (!r.ok) throw new Error(r.error);
      return { kind: r.kind, replaced: check.replaced };
    });
  }

  /** How many bytes the project's files have together: each text as it is, each blob as its ref says (one of storage's lists). */
  private async bytesUsed(opened: Opened): Promise<number> {
    const encoder = new TextEncoder();
    let n = 0;
    for (const t of texts(opened.room.doc).values()) n += encoder.encode(t.toString()).length;
    for (const ref of (await this.storage.list<BlobRef>({ prefix: REF })).values()) if (isBlobRef(ref)) n += ref.size;
    return n;
  }

  /** One file's size now (0 if it has none). */
  private async sizeOf(opened: Opened, path: string): Promise<number> {
    const text = opened.room.text(path);
    if (text != null) return new TextEncoder().encode(text).length;
    const ref = opened.files.ref ? await Effect.runPromise(Effect.orElseSucceed(opened.files.ref(path), () => null)) : null;
    return ref?.size ?? (await this.storage.get<Uint8Array>(FILE + path))?.length ?? 0;
  }

  /**
   * Copies what the object kept before blobs to the blob store, once: every
   * file that isn't text (it gets its ref; its bytes stay in the object too)
   * and every version's blob. Nothing is deleted: a Worker from before blobs
   * still reads it all. Stopped part way (the object slept), it goes on at
   * the next open.
   */
  private async copyToBlobs(room: Room, refs: RefIndex, blobs: BlobStore): Promise<void> {
    let files = 0, versions = 0;
    for (const path of [...assets(room.doc).keys()]) {
      if (await refs.has(path)) continue;
      const bytes = await this.storage.get<Uint8Array>(FILE + path);
      if (!bytes) continue;
      const ref = await storeBlob(blobs, bytes);
      // Still these bytes, and still no blob (an upload may have replaced the file meanwhile): only then its ref.
      if (assets(room.doc).get(path) != digest(bytes) || (await refs.has(path))) continue;
      await refs.add(path);
      await this.storage.put(REF + path, ref);
      files++;
    }
    let after: string | undefined;
    for (;;) {
      const page = await this.storage.list<Uint8Array>({ prefix: VERSION_BLOB, ...(after ? { startAfter: after } : {}), limit: 32 });
      if (!page.size) break;
      for (const [key, bytes] of page) {
        after = key;
        const hash = key.slice(VERSION_BLOB.length);
        if (await blobs.head(hash)) continue;
        try { await blobs.put(hash, bytes, bytes.length); versions++; } catch (e) { this.deps.log(`couldn't copy the version blob ${hash}: ${e}`); }
      }
    }
    await this.storage.put(COPIED, { at: Date.now(), files, versions });
    if (files || versions) this.deps.log(`${this.info?.id}: ${files} files and ${versions} version blobs copied to the blob store`);
  }

  /** Opens the room on this document's storage, for as long as the document lives. */
  private async load(): Promise<Opened | null> {
    // Closed for being idle a moment ago: its last writes land first.
    await this.closing;
    const info = await this.readInfo();
    if (!info) return null;
    // A document on disk has its files there, and the rest of its storage here.
    const storage = info.disk && this.deps.disk ? this.deps.disk.storage(info.disk.only ? info.index : null) : this.storage;
    // Its files that aren't text are blobs (none on disk: it keeps its own files there), and which those are, the file
    // store and the room's writes share.
    const blobs = info.disk ? undefined : this.deps.blobs;
    const refs = new RefIndex(storage), times = new TimeIndex(storage);
    const files = fileStoreOf(storage, { touch: () => this.touch() }, { blobs, refs, times });
    // Its history, with its files written in the same transaction (and its record, as touch notes the edit).
    // On disk the files change while it's closed, so it reads them all as it opens.
    const state = stateStoreOf(storage, { reconcile: !!info.disk, edited: () => this.touch(), blobs, refs, times });

    // The room's scope lasts until the document closes (idle, deleted, replaced): closing it writes what's left.
    const scope = Effect.runSync(Scope.make());
    const room = await Effect.runPromise(Room.make({ log: this.deps.log, writeDelay: this.deps.timing.writeDelay, fileDelay: this.deps.timing.fileDelay }).pipe(
      Effect.provideService(FileStore, files),
      Effect.provideService(StateStore, state),
      Scope.provide(scope),
    )).catch(async (e) => { await Effect.runPromise(Scope.close(scope, Exit.void)); throw e; });
    const host = makeHost({
      room,
      files,
      docId: info.id,
      agents: this.deps.agents,
      // A test document's agent is the scripted one: free, and the same every run.
      scripted: !!info.test,
      doc: { name: info.index, path: info.index, dir: info.disk?.path ?? info.owner },
      only: info.disk?.only ? info.index : undefined,
      personOf: (req) => personOf(new Headers(req.headers as Record<string, string>)),
      // The front door sets x-erga-agent only on a request whose agent token it checked.
      // With x-erga-via, how the person acts through it: "a shared agent (label)".
      agentOf: (req) => (req.headers["x-erga-agent"] ? { ...personOf(new Headers(req.headers as Record<string, string>)), via: viaOf(req.headers["x-erga-via"]) } : null),
      // Their agent edits only if they may (and only while they may).
      canEdit: (person) => this.editors.get(person.id) ?? false,
      mayPublish: (req) => req.headers["x-erga-access"] == "edit",
      baseUrl: (req) => req.headers["x-erga-base"] ?? "",
      avatarOf: this.deps.avatarOf,
      // Its title and address, renamed as whoever asks (test people are "test-...": they may rename only test documents).
      naming: (person) => naming({ login: person.id, test: person.id.startsWith("test-") }),
      // An agent's turn is one version, and where its next diff_versions starts from ("last_turn").
      turnEnded: () => this.cutSoon("agent turn").then(async (v) => (v ?? (await this.versions.latest()))?.id ?? null),
      versions: {
        state: (opts) => this.versionsState(opts).then((s) => s!),
        version: (ref) => this.version(ref),
        file: (ref, path) => this.versionFile(ref, path),
        files: async (ref) => {
          const n = versionNumber(ref);
          const v = n != null && (await this.ready()) ? await this.versions.get(n) : null;
          return v ? this.versions.files(v) : null;
        },
        current: async () => (await this.ready())?.opened.current() ?? new Map(),
        restore: (ref, by, path) => this.restore(ref, by, path),
      },
      // A new page in its file tree starts as a new document does.
      newPage: this.deps.pageTemplate,
      blobs,
      // An agent's write of bytes: as an upload is.
      putFile: (path, bytes, by) => this.putFile(path, bytes, by),
      // One from before kinds is decided (below) before anyone reaches it.
      kind: () => this.info?.kind ?? "project",
      setKind: (kind) => this.setKind(kind),
    });
    // From before kinds: a project if it has more than one page, else a document. Kept, and told to the directory.
    if (!info.kind && !info.disk?.only) {
      const kind = kindOf(room.paths());
      await this.saveInfo({ ...((await this.readInfo()) ?? info), kind });
      this.deps.background(this.directory.setKind(info.id, kind).catch((e) => this.deps.log(`couldn't tell the directory ${info.id}'s kind: ${e}`)));
    }
    // Every edit to the files, and who made it: a version is cut once a burst of them ends (noteEdit).
    room.doc.on("afterTransaction", (tr: Y.Transaction) => {
      if (!touchesFiles(room.doc, tr)) return;
      this.viewChanged();
      const a = authorOf(room.doc, tr);
      this.noteEdit(a ? (a.kind == "disk" ? (info.disk ? "on disk" : this.publisher ?? "files published") : editorOf(a)) : null);
    });
    // Its name from its record once the directory has said it; a rename goes to the directory, and what it answers is kept.
    const named = namingFor(this.directory, info.id, () => titleOf(room.text(info.index) ?? ""));
    const naming = (who: Asker): Naming => {
      const n = named(who);
      return {
        get: async () => (await this.readInfo())?.name ?? this.rememberName(await n.get()),
        set: async (patch) => this.rememberName(await n.set(patch)),
      };
    };

    const opened: Opened = {
      broadcast: host.broadcast,
      // Every file as it is now: text from the room (the latest keystroke), the rest from storage.
      current: async () => {
        const out = new Map<string, Uint8Array>();
        const encoder = new TextEncoder();
        for (const path of new Set([...texts(room.doc).keys(), ...assets(room.doc).keys()])) {
          const text = room.text(path);
          const bytes = text != null ? encoder.encode(text) : await Effect.runPromise(Effect.orElseSucceed(files.read(path), () => null));
          if (bytes) out.set(path, bytes);
        }
        return out;
      },
      // The same, with a blob as its ref (no bytes read): what a version, a copy and a restore take.
      entries: async () => {
        const out = new Map<string, Uint8Array | BlobRef>();
        const encoder = new TextEncoder();
        for (const path of new Set([...texts(room.doc).keys(), ...assets(room.doc).keys()])) {
          const text = room.text(path);
          if (text != null) { out.set(path, encoder.encode(text)); continue; }
          const ref = files.ref ? await Effect.runPromise(Effect.orElseSucceed(files.ref(path), () => null)) : null;
          const data = ref ?? await Effect.runPromise(Effect.orElseSucceed(files.read(path), () => null));
          if (data) out.set(path, data);
        }
        return out;
      },
      files,
      handler: host.handler,
      renamed: host.renamed,
      notify: host.notify,
      addTab: host.addTab,
      hello: host.hello,
      agentState: host.agentState,
      resumeAgent: host.resumeAgent,
      room,
      // Back in touch with disk: every file there, and every one the room holds, is looked at again.
      catchUp: async () => {
        const paths = new Set([...await Effect.runPromise(files.list), ...texts(room.doc).keys(), ...assets(room.doc).keys()]);
        for (const path of paths) await Effect.runPromise(room.fileChanged(path)).catch(() => {});
        await Effect.runPromise(room.syncFolders).catch(() => {});
      },
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)).then(host.dispose),
    };
    this.opened = opened;
    // A version of what it holds, if it stopped with edits no version has (or there's none yet).
    if (info.uncut || (await this.versions.head()) == 0) void this.cutSoon("open");
    // What it kept in its object before blobs goes to the blob store too (once; copied, not moved).
    if (blobs && !(await this.storage.get(COPIED))) this.deps.background(this.copyToBlobs(room, refs, blobs).catch((e) => this.deps.log(`couldn't copy ${info.id}'s files to the blob store: ${e}`)));
    // Tabs connected while it was closed join it now.
    this.deps.tabs.attach?.(opened);
    this.activity();
    // Now with its title, for one on disk.
    if (info.disk) this.syncDirectory().catch((e) => this.deps.log(`couldn't update ${info.id}'s row: ${e}`));
    return opened;
  }
}

/** The document once its room is open. */
export interface Opened {
  /** Tells every open tab, whoever's. */
  broadcast: (msg: unknown) => void;
  /** Every file the document holds as it is now. */
  current: () => Promise<Map<string, Uint8Array>>;
  /** The same, with each blob as its ref. */
  entries: () => Promise<Map<string, Uint8Array | BlobRef>>;
  /** Its files' store (refs, blobs). */
  files: FileStore["Service"];
  handler: (request: Request) => Promise<Response>;
  /** A tab joins its person's event channel (`watch`: a files view, hearing only what every tab does); returns the leave function. */
  addTab: (user: string, send: (msg: unknown) => void, watch?: boolean) => () => void;
  /** What a tab hears first ({ type: "hello" }): the document's details as the person sees them, and its tree. */
  hello: (person: Person, canEdit: boolean) => Promise<Hello>;
  /** The person's agent: on or off, its model and its conversation (as GET /api/agent answers). */
  agentState: (person: Person) => Promise<AgentState>;
  room: Room;
  catchUp: () => Promise<void>;
  /** Tells every open tab the document's new title and address. */
  renamed: (name: DocName) => void;
  /** A message for every open tab. */
  notify: (msg: unknown) => void;
  /** A person's agent session, started if it isn't (a run a restart cut off goes on). */
  resumeAgent: (person: Person) => Promise<void>;
  close: () => Promise<void>;
}

/** Whether a transaction changed a file: a text's content, or the list of files or other files (images). */
function touchesFiles(doc: Y.Doc, tr: Y.Transaction): boolean {
  const fileMap = texts(doc) as Y.AbstractType<any>, assetMap = assets(doc) as Y.AbstractType<any>, folderMap = folders(doc) as Y.AbstractType<any>;
  for (const type of tr.changed.keys()) {
    if (type === fileMap || type === assetMap || type === folderMap) return true;
    if (type._item?.parent === fileMap) return true;
  }
  return false;
}

/** How an outside agent's person acts through it, as the front door said (x-erga-via, JSON; shared/attribution.ts). */
function viaOf(header: string | undefined): string {
  try { const v = JSON.parse(header ?? ""); if (typeof v == "string" && v) return v; } catch { /* none */ }
  return VIA.token("");
}

/** Who a request is from, as the front door said (x-erga-person: JSON {id, name, avatar?}). */
export function personOf(headers: Headers): Person {
  try {
    const p = JSON.parse(headers.get("x-erga-person") ?? "") as Person;
    if (typeof p.id == "string" && typeof p.name == "string")
      return { id: p.id, name: p.name, ...(typeof p.avatar == "string" ? { avatar: p.avatar } : {}) };
  } catch {
    /* none */
  }
  return { id: "anon", name: "Someone" };
}
