// One running document, with no Cloudflare in it: given a Storage and what
// the server around it offers (DocumentDeps), it keeps the document's files
// and its room's state, opens the room when the first request arrives,
// serves the document's API (host.ts), cuts versions as it is edited,
// publishes, restores, deletes itself when nobody edits it, and keeps its
// row in the directory up to date. cloudflare/document-object.ts runs one in
// a Durable Object; the tests run one on MemoryStorage.
//
// The front door has already checked who's asking: it forwards each request
// with the path inside the document (/api/doc, not /koomen/abc123/api/doc),
// the document's public address in x-erga-base, the signed-in person in
// x-erga-person, and what they may do in x-erga-access ("edit", or "view":
// their room connection is then read-only, and so are their agent and
// publishes). A request that came with an agent token also has x-erga-agent:
// only those may call the external agent's tools (/api/ext), as the person
// the token stands for, who may do what they last could.
//
// Storage keys: `info` (what the document is), `files/<path>` (a file's
// bytes), `folders/<path>` (a folder made as one, empty ones too),
// `room-state` (the room's Yjs state), and the versions' (versions.ts).
//
// In local development a document can be a file or folder on disk
// (`link`). Its files then stay there: the room's storage is the folder
// itself, reached through the adapter's disk link, and only the room's Yjs
// state is kept here. A single file on its own (`only`) is the only file
// such a document has.

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import * as Y from "yjs";
import { DIRECTORY_EVERY_MS, nameOf, namingFor, throttle, UNTITLED, type Directory, type DocName, type DocRow } from "../server/directory.ts";
import { afterUnedited, titleOf } from "../server/routes.ts";
import type { SiteRow } from "../server/sites.ts";
import { cleanRel, docFile, makeHost, relativeUrl } from "./host.ts";
import { resolvePage } from "./pages.ts";
import { FileStore, Room, StateStore, type Connection } from "./room.ts";
import { fileStoreOf, KEYS, kvOf, stateStoreOf, writeText, type Storage } from "./storage.ts";
import { VIA } from "../shared/attribution.ts";
import { assets, authorOf, editorOf, files as texts, folders, isTextPath, type Author } from "./content.ts";
import { describeChange, fallbackDescription, firePublished, publicVersion, versionNumber, Versions, type Published, type PublishRequest, type PublishResult, type RestoreResult, type StoredVersion, type Version, type VersionsState } from "./versions.ts";
import { decodeValue, exportPage, type DocSnapshot, type Page } from "../deploy/snapshot.ts";
import type { AgentConfig } from "../agents/models.ts";
import type { ExportedDocument } from "../server/admin/cutover.ts";

/**
 * What a document is: its id, who made it, which file is its page, whether
 * it's a test document, when a file last changed (never, if unset), where it
 * is on disk (local development), and the published version in "manual" mode.
 */
export interface DocumentInfo { id: string; owner: string; index: string; created: number; modified?: number; test?: boolean; disk?: OnDisk; published?: { n: number } }

/** A document that's a file or folder on disk (local development): where it is, its address there, and whether it's a single file. */
export interface OnDisk { path: string; slug: string; only?: boolean }

export interface Person { id: string; name: string }

export type AgentSettings = AgentConfig | { readonly missing: string };

/** The files of a document on disk, as the adapter reaches them: a FileStore but for `write`, which the document wraps. */
export type DiskFiles = FileStore["Service"];

/** What the server around a document gives it. */
export interface DocumentDeps {
  storage: Storage;
  directory: Directory;
  /** Who has the document open (the adapter's sockets): how many, and closing them all. */
  tabs: { count(): number; closeAll(code: number, reason: string): void };
  /** The agent's settings as they are now: the key an admin stored, else the Worker's. */
  agentSettings: () => Promise<AgentSettings>;
  /** The tools beyond the document a person's agent may use now (sharing, the documents list, an admin's settings and users). */
  serverTools: (person: Person, here: string) => Promise<AgentTool[]>;
  /** Takes down the document's site on its person's Cloudflare account; a refusal, or nothing. */
  takeDownSite: (site: SiteRow) => Promise<string | null | undefined>;
  /** The homepage forgets a deleted document; and its next deploy is scheduled when the homepage's published version changed. */
  home: { forget: (docId: string) => Promise<void>; publishedChanged: (docId: string) => Promise<void> };
  /** The document's site, if it has one, deploys again a short time from now. */
  siteChanged: (docId: string) => Promise<void>;
  /** Local development: the files of a document on disk (null when it isn't one). */
  disk?: { store: (only: string | null) => DiskFiles };
  /** When versions are cut: how long edits pause first, and the longest burst one version holds; the room's write delay. */
  timing: { idleMs: number; maxMs: number; writeDelay?: number };
  /** Work that outlives the request (a version's description, telling the homepage). */
  background: (work: Promise<unknown>) => void;
  log: (line: string) => void;
  /** What a new page starts from (the new-document template's page); a plain one if not given. */
  pageTemplate?: string;
  /** A person's picture, if known (hosted: their GitHub avatar). */
  avatarOf?: (person: Person) => string | undefined;
}

const { file: FILE, dir: DIR, meta: INFO, state: STATE } = KEYS;

/** A new Markdown page (a document whose page is index.md). */
const plainMarkdown = "# Untitled\n\nStart writing here.\n";

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
  /** The published version's number in "manual" mode, null in "latest" (undefined: not read yet). */
  private pub: number | null | undefined = undefined;
  /** Who the files arriving whole now are by (publish), for the version. */
  private publisher: string | null = null;
  /**
   * Who may edit, by person id, as the front door last said (x-erga-access):
   * their agent, and an external agent acting for them, may do what they could
   * at their latest request.
   */
  private editors = new Map<string, boolean>();

  constructor(private deps: DocumentDeps) {
    this.storage = deps.storage;
    this.versions = new Versions(kvOf(this.storage));
  }

  private get idleMs() { return this.deps.timing.idleMs; }
  private get maxMs() { return this.deps.timing.maxMs; }
  private get directory() { return this.deps.directory; }

  /**
   * Creates the document, whose row the front door has just added to the
   * directory, from a template's files; false if it already exists. Unless
   * someone edits it, it's deleted at `expires` (the delete_docs_after_hours setting
   * after it's made, or sooner when local development asks, to test it).
   */
  async create(owner: string, id: string, files: Record<string, string | Uint8Array>, index: string, opts: { test?: boolean; expires: number | null; modified?: number }): Promise<boolean> {
    if (await this.storage.get<DocumentInfo>(INFO)) return false;
    const encoder = new TextEncoder();
    for (const [path, data] of Object.entries(files)) await this.storage.put(FILE + path, typeof data == "string" ? encoder.encode(data) : data);
    const info: DocumentInfo = { id, owner: owner.toLowerCase(), index, created: Date.now(), ...(opts.modified ? { modified: opts.modified } : {}), ...(opts.test ? { test: true } : {}) };
    await this.storage.put(INFO, info);
    if (!info.test && opts.expires != null) await this.storage.setAlarm(opts.expires);
    // Its first version: the files it starts from.
    const first = new Map(Object.entries(files).map(([path, data]) => [path, typeof data == "string" ? encoder.encode(data) : data]));
    await this.versions.cut(first, index, [info.owner], "First version");
    return true;
  }

  /**
   * The storage cutover: becomes an exported document (server/admin/cutover.ts)
   * under its own id, whose row the directory still has. Its current files
   * are the latest version; when it was published at another version, that
   * version's files are the first version, and stay published. An unedited
   * document expires when its row says. Refused if the document exists.
   */
  async importExported(doc: ExportedDocument, decode: (file: { text?: string; base64?: string }) => Uint8Array): Promise<{ ok: true; versions: number } | { ok: false; error: string }> {
    if (await this.storage.get<DocumentInfo>(INFO)) return { ok: false, error: "The document exists already." };
    const files = new Map(Object.entries(doc.files).map(([path, f]) => [path, decode(f)]));
    for (const [path, bytes] of files) await this.storage.put(FILE + path, bytes);
    const info: DocumentInfo = { id: doc.record.id, owner: doc.record.owner.toLowerCase(), index: doc.index, created: doc.record.created, ...(doc.record.modified ? { modified: doc.record.modified } : {}) };
    const by = [doc.record.owner.toLowerCase()];
    let versions = 0;
    if (doc.publishedFiles) {
      const published = new Map(Object.entries(doc.publishedFiles).map(([path, f]) => [path, decode(f)]));
      await this.versions.cut(published, doc.index, by, "The published version, before the storage cutover");
      info.published = { n: 1 };
      versions++;
    }
    if (await this.versions.cut(files, doc.index, by, versions ? "The document as it was at the storage cutover" : "First version")) versions++;
    await this.storage.put(INFO, info);
    if (doc.record.modified == null && doc.record.expires != null) await this.storage.setAlarm(doc.record.expires);
    return { ok: true, versions };
  }

  /**
   * Local development: the document for a file or folder on disk, made if
   * it doesn't exist yet, and its row in the directory (its address the
   * folder's or file's name, `disk.slug`). Its files stay on disk (the dev
   * server connects to /api/mirror to reach them); it never expires, and
   * deleting it leaves them as they are.
   */
  async link(owner: string, id: string, index: string, disk: OnDisk): Promise<DocRow> {
    const info = await this.storage.get<DocumentInfo>(INFO);
    await this.storage.put(INFO, info ? { ...info, index, disk } : { id, owner: owner.toLowerCase(), index, created: Date.now(), disk });
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
  async publish(files: Record<string, string | Uint8Array>, remove: string[], by?: string): Promise<{ written: string[]; removed: string[]; refused: { path: string; why: string }[] }> {
    const opened = await (this.open ??= this.load());
    if (!opened) { this.open = null; throw new Error("There's no such document."); }
    this.publisher = by ?? null;
    try { return await this.publishNow(opened, files, remove); } finally { this.publisher = null; }
  }

  private async publishNow(opened: Opened, files: Record<string, string | Uint8Array>, remove: string[]): Promise<{ written: string[]; removed: string[]; refused: { path: string; why: string }[] }> {
    const info = (await this.storage.get<DocumentInfo>(INFO))!;
    const out = { written: [] as string[], removed: [] as string[], refused: [] as { path: string; why: string }[] };
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    // Edits not yet written land first, so a published file replaces what's there now rather than merging with it.
    await Effect.runPromise(opened.room.flush);
    for (const [path, data] of Object.entries(files)) {
      if (info.disk?.only && path != info.index) { out.refused.push({ path, why: `this document is the single file ${info.index}` }); continue; }
      let text: string | null = null;
      if (typeof data == "string") text = data;
      else if (isTextPath(path)) { try { text = decoder.decode(data); } catch { out.refused.push({ path, why: "not UTF-8 text" }); continue; } }
      if (text != null && isTextPath(path)) {
        const r = await Effect.runPromise(opened.room.push(path, text));
        if (r.ok) out.written.push(path); else out.refused.push({ path, why: r.reason ?? "refused" });
        continue;
      }
      if (info.disk) { out.refused.push({ path, why: "a document on disk takes only text files this way" }); continue; }
      await this.storage.put(FILE + path, typeof data == "string" ? new TextEncoder().encode(data) : data);
      await Effect.runPromise(opened.room.fileChanged(path));
      out.written.push(path);
    }
    for (const path of remove) {
      if (path == info.index) { out.refused.push({ path, why: "it's the document's page" }); continue; }
      if (info.disk) { out.refused.push({ path, why: "files on disk aren't deleted this way" }); continue; }
      if (!(await this.storage.get(FILE + path))) continue;
      await this.storage.delete(FILE + path);
      await Effect.runPromise(opened.room.fileChanged(path));
      out.removed.push(path);
    }
    if (out.written.length || out.removed.length) await this.touch();
    return out;
  }

  /** Every file the document holds (the room's view: text files and others). */
  async paths(): Promise<string[]> {
    const opened = await (this.open ??= this.load());
    if (!opened) { this.open = null; return []; }
    return [...new Set([...texts(opened.room.doc).keys(), ...assets(opened.room.doc).keys()])].sort();
  }

  /** The document's page, or null if there's no such document. */
  async index(): Promise<string | null> {
    return (await this.storage.get<DocumentInfo>(INFO))?.index ?? null;
  }

  /**
   * Every file the document holds as it is now (text from the room, so the
   * latest edits are in it), and its page: what a copy of it starts from.
   * Null if there's no such document.
   */
  async snapshot(opts: { published?: boolean } = {}): Promise<{ index: string; files: Record<string, string | Uint8Array> } | null> {
    const info = await this.storage.get<DocumentInfo>(INFO);
    // Someone who may only view it, in "manual" mode, copies what they see: the published version.
    const v = opts.published && info?.published ? await this.versions.get(info.published.n) : null;
    if (v) return { index: v.index, files: Object.fromEntries(await this.versions.files(v)) };
    const opened = info && await (this.open ??= this.load());
    if (!info || !opened) { if (!opened) this.open = null; return null; }
    const files: Record<string, string | Uint8Array> = {};
    for (const path of await this.paths()) {
      const text = opened.room.text(path);
      const data = text ?? (await this.storage.get<Uint8Array>(FILE + path));
      if (data != null) files[path] = data;
    }
    return { index: info.index, files };
  }

  /** Deletes the document (the front door has asked the directory who may): everyone on it is disconnected. */
  async delete(): Promise<boolean> {
    const info = await this.storage.get<DocumentInfo>(INFO);
    if (!info) return false;
    await this.destroy(info);
    return true;
  }

  /**
   * Puts a document on disk in the directory if it isn't there yet, as it is
   * now: its row. Anyone signed in may edit it (on this machine, that's
   * whoever local development lets in). Null if there's no such document.
   */
  private async addRow(): Promise<DocRow | null> {
    const info = await this.storage.get<DocumentInfo>(INFO);
    if (!info) return null;
    const text = await this.pageText(info);
    const { doc } = await this.directory.add({
      id: info.id, owner: info.owner,
      title: (text && titleOf(text, info.index)) || UNTITLED,
      // A test document's address stays its id (the suite addresses it so); one on disk is its folder's or file's name.
      ...(info.test ? { slug: info.id, slugSet: true } : info.disk ? { slug: info.disk.slug, slugSet: true } : {}),
      created: info.created, modified: info.modified ?? null,
      expires: info.modified || info.test || info.disk ? null : (await this.storage.getAlarm()),
      test: info.test,
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
    const info = await this.storage.get<DocumentInfo>(INFO);
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
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
    this.versions = new Versions(kvOf(this.storage));
    this.pub = undefined;
    // If it had a site on its person's Cloudflare account, the site comes down too.
    const site = await this.directory.sites.get(info.id).catch(() => null);
    if (site) {
      const refused = await this.deps.takeDownSite(site).catch((e) => String(e));
      if (refused) this.deps.log(`couldn't take down ${site.hostname}: ${refused}`);
      await this.directory.sites.remove(site.docId);
    }
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
    const info = await this.storage.get<DocumentInfo>(INFO);
    if (!info) return;
    const text = await this.pageText(info);
    const r = await this.directory.edited(info.id, {
      modified: info.modified ?? null,
      pageTitle: text != null ? titleOf(text, info.index) : null,
    });
    if (r?.renamed) (await this.open)?.renamed(nameOf(r.doc));
  }

  /** A message for everyone who has the document open (the homepage's deploy status). Opens nothing. */
  notify(msg: unknown): void {
    this.opened?.notify(msg);
  }

  /**
   * The page's text: from storage, or for a document on disk from its room
   * (once it's open; never waited for, since opening waits for the dev
   * server, which may be linking it just then).
   */
  private async pageText(info: DocumentInfo): Promise<string | null> {
    if (info.disk) return this.opened?.room.text(info.index) ?? null;
    const bytes = await this.storage.get<Uint8Array>(FILE + info.index);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  /**
   * The room writes a file only when its text changed (its own seeding and
   * people merely looking never do), so a write that changes what storage
   * holds is an edit: by a person, an agent or a publish.
   */
  private async edited(path: string, text: string): Promise<void> {
    if ((await writeText(this.storage, path, text)).changed) await this.touch();
  }

  /** A file changed: the document has been edited, so it stays (and its row says when). */
  private async touch(): Promise<void> {
    const info = await this.storage.get<DocumentInfo>(INFO);
    if (!info) return;
    info.modified = Date.now();
    await this.storage.put(INFO, info);
    if (!info.test) await this.storage.deleteAlarm();
    // At most every DIRECTORY_EVERY_MS, however fast the edits come; the last always lands.
    this.sync ??= throttle(() => this.syncDirectory().catch((e) => this.deps.log(`couldn't update ${info.id}'s row: ${e}`)), DIRECTORY_EVERY_MS);
    this.sync();
  }

  /** Where its files are, for a document on disk (local development); null for any other. */
  async diskPath(): Promise<string | null> {
    return (await this.storage.get<DocumentInfo>(INFO))?.disk?.path ?? null;
  }

  /** Whether it is a document on disk. */
  async onDisk(): Promise<boolean> {
    return !!(await this.storage.get<DocumentInfo>(INFO))?.disk;
  }

  /** Whether the document exists. */
  async exists(): Promise<boolean> {
    return (await this.storage.get<DocumentInfo>(INFO)) != null;
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
  }

  /** Empties it (staging only: a document production no longer has). The directory row is already gone with the old database. */
  async wipeStorage(): Promise<void> {
    await this.closeForSnapshot();
    await this.storage.deleteAlarm();
    await this.storage.deleteAll();
  }

  private async closeForSnapshot(): Promise<void> {
    this.deps.tabs.closeAll(1012, "document replaced by a snapshot");
    const opened = await this.open?.catch(() => null);
    this.open = null;
    this.opened = null;
    await opened?.close().catch(() => {});
  }

  /**
   * A request inside the document (not a WebSocket: the adapter takes those
   * after `admit`). What viewers see: in "manual" mode the published
   * version's files (/pub/); in "latest" the files as they are now, as /doc/.
   */
  async handle(request: Request): Promise<Response> {
    const asked = new URL(request.url);
    if (asked.pathname.startsWith("/pub/")) {
      const served = await this.publishedFile(request, asked);
      if (served) return served;
      asked.pathname = "/doc/" + asked.pathname.slice("/pub/".length);
      request = new Request(asked, request);
    }
    // Someone viewing it: its files straight from storage while the room isn't open, without opening it.
    const stored = this.opened || this.open ? null : await this.storedFile(request);
    if (stored) return stored;
    const opened = await this.admit(request);
    // Not made yet: asked again next time, since it may be by then (made, or linked from disk).
    if (!opened) return new Response("No such document", { status: 404 });
    return opened.handler(request);
  }

  /**
   * Opens the document for a request and notes what the front door said the
   * person may do; null if there's no such document. The adapter calls it
   * before it accepts a WebSocket.
   */
  async admit(request: Request): Promise<Opened | null> {
    const opened = await (this.open ??= this.load());
    if (!opened) { this.open = null; return null; }
    if (request.headers.has("x-erga-person")) this.editors.set(personOf(request.headers).id, request.headers.get("x-erga-access") == "edit");
    return opened;
  }

  /**
   * A tab joins the room over a socket the adapter holds: `send` carries the
   * room's messages to it. Returns what to do with the tab's messages and
   * its going, or null when the tab holds another epoch's history (it is
   * refused, never merged). Someone who may only view joins read-only: they
   * see every edit, and theirs go nowhere.
   */
  joinRoom(opened: Opened, o: { epoch: string | null; readOnly: boolean; send: (m: Uint8Array) => void }): { receive: (data: Uint8Array) => boolean; left: () => void } | null {
    const conn: Connection | null = opened.room.connect(o.send, { epoch: o.epoch, readOnly: o.readOnly });
    if (!conn) return null;
    // When the last person who may edit leaves, what they did is a version.
    let gone = false;
    if (!o.readOnly) this.editing++;
    return {
      receive: (data) => conn.receive(data),
      left: () => {
        if (gone) return;
        gone = true;
        conn.close();
        if (!o.readOnly && --this.editing == 0) void this.cutSoon("left");
      },
    };
  }

  /** A tab joins its person's event channel (the agent's events, the versions' changes); returns the leave function. */
  joinEvents(opened: Opened, person: Person, send: (msg: unknown) => void): () => void {
    return opened.addTab(person.id, send);
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
    const info = await this.storage.get<DocumentInfo>(INFO);
    if (!info || info.disk) return null;
    // doc/ itself is its page (server/routes.ts's frame asks for it so, not knowing its name).
    const rel = url.pathname == "/doc/" ? info.index : cleanRel(url.pathname.slice("/doc/".length));
    if (!rel) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const bytes = await this.storage.get<Uint8Array>(FILE + rel);
    if (!bytes) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const r = docFile(rel, bytes, request.headers.get("if-none-match"));
    return new Response(request.method == "HEAD" ? null : (r.body as Uint8Array<ArrayBuffer>), { status: r.status, headers: { "Content-Type": r.type, ...r.headers, "Server-Timing": 'doc;desc="stored"' } });
  }

  /**
   * A GET of one of the published version's files, in "manual"
   * mode; null in "latest" mode (the caller serves the files as they are now),
   * which costs no more than reading the document's info, kept in memory.
   */
  private async publishedFile(request: Request, url: URL): Promise<Response | null> {
    if (request.method != "GET" && request.method != "HEAD") return null;
    const n = await this.publishedNumber();
    const v = n != null ? await this.versions.get(n) : null;
    if (!v) return null;
    const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const raw = url.pathname.slice("/pub/".length);
    const rel = raw ? cleanRel(raw) : v.index;
    // A page by its address (blog for blog.html or blog/index.html), as doc/ does: sent to its file, relatively.
    if (!rel || !(rel in v.files)) {
      const found = resolvePage((p) => p in v.files, raw, v.index);
      if (!found || found.file == rel) return notFound();
      let from = raw;
      try { from = decodeURIComponent(raw); } catch { /* resolvePage refused it already */ }
      return new Response(null, { status: 302, headers: { Location: relativeUrl(from, found.file), "Cache-Control": "no-store" } });
    }
    const bytes = await this.versions.file(v, rel);
    if (!bytes) return notFound();
    const r = docFile(rel, bytes, request.headers.get("if-none-match"));
    return new Response(request.method == "HEAD" ? null : (r.body as Uint8Array<ArrayBuffer>), { status: r.status, headers: { "Content-Type": r.type, ...r.headers, "Server-Timing": `doc;desc="version ${n}"` } });
  }

  /** The published version's number in "manual" mode; null in "latest". */
  private async publishedNumber(): Promise<number | null> {
    if (this.pub === undefined) this.pub = (await this.storage.get<DocumentInfo>(INFO))?.published?.n ?? null;
    return this.pub;
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
   * - before a publish, so what's published can be the latest edit;
   * - when the room opens, if what it holds isn't the latest version (edits
   *   made while timers couldn't run: the object was evicted).
   *
   * A cut that finds nothing changed since the latest version makes none.
   */
  private noteEdit(author: string | null): void {
    const p = this.pending;
    p.dirty = true;
    if (author) p.authors.add(author);
    if (!p.since) {
      p.since = Date.now();
      const burst = () => { p.max = this.agentWorking() ? setTimeout(burst, this.idleMs) : null; if (!p.max) void this.cutSoon("burst"); };
      p.max = setTimeout(burst, this.maxMs);
    }
    if (p.idle) clearTimeout(p.idle);
    const idle = () => { p.idle = this.agentWorking() ? setTimeout(idle, this.idleMs) : null; if (!p.idle) void this.cutSoon("idle"); };
    p.idle = setTimeout(idle, this.idleMs);
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
    await new Promise((r) => setTimeout(r, 0));
    const opened = this.opened;
    const info = await this.storage.get<DocumentInfo>(INFO);
    if (!opened || !info) return null;
    const { authors } = this.clearPending();
    const r = await this.versions.cut(await opened.current(), info.index, as?.authors ?? authors, as?.description ?? ((await this.versions.head()) == 0 ? "First version" : null), opened.room.folderPaths());
    if (!r) return null;
    opened.broadcast({ type: "versions" });
    if (!info.published) this.firePublished(info);
    if (r.previous && !as) this.deps.background(this.describe(r.version, r.previous, info).catch((e) => this.deps.log(`couldn't describe version ${r.version.n}: ${e}`)));
    return r.version;
  }

  /** Writes a version's description in the background: the model's five words, or the fallback. Never in the way of editing. */
  private async describe(version: StoredVersion, previous: StoredVersion, info: DocumentInfo): Promise<void> {
    const changes = await this.versions.changes(previous, version);
    // The agent's key, as it is now (an admin may have stored one since the document opened).
    const cfg = info.test ? null : await this.deps.agentSettings();
    const key = cfg && !("missing" in cfg) && cfg.model != "script" ? Redacted.value(cfg.apiKey) : "";
    const text = (key ? await describeChange(key, changes) : null) ?? fallbackDescription(changes);
    await this.versions.describe(version.n, text);
    this.opened?.broadcast({ type: "versions" });
  }

  private async publishedNow(info: DocumentInfo): Promise<Published> {
    const latest = (await this.versions.latest())!;
    const v = info.published ? await this.versions.get(info.published.n) : null;
    return v ? { mode: "manual", version: publicVersion(v) } : { mode: "latest", version: publicVersion(latest) };
  }

  private firePublished(info: DocumentInfo): void {
    const docId = info.id;
    this.publishedNow(info).then((published) => firePublished({ docId, published, files: async () => (await this.publishedFiles())?.files ?? new Map() }))
      .catch((e) => this.deps.log(`couldn't tell of ${docId}'s published version: ${e}`));
    // If it's the homepage, its next deploy is scheduled.
    this.deps.background(this.directory.homeId().then((home) => home == docId ? this.deps.home.publishedChanged(docId) : undefined)
      .catch((e) => this.deps.log(`couldn't schedule the homepage's deploy: ${e}`)));
    // If it has a site on its person's Cloudflare account, the site's next deploy is scheduled.
    this.deps.background(this.deps.siteChanged(docId).catch((e) => this.deps.log(`couldn't schedule ${docId}'s site deploy: ${e}`)));
  }

  /** Opens the document and waits for any cut under way (the first, when it opens, makes sure there is a version). */
  private async ready(): Promise<{ opened: Opened; info: DocumentInfo } | null> {
    const opened = await (this.open ??= this.load());
    if (!opened) { this.open = null; return null; }
    await this.cutting;
    if ((await this.versions.head()) == 0) await this.cutSoon("first");
    const info = await this.storage.get<DocumentInfo>(INFO);
    return info ? { opened, info } : null;
  }

  /** Its versions, newest first (`limit`, before version `before`), the current one and the published one. Null if there's no such document. */
  async versionsState(opts: { before?: string | number | null; limit?: number } = {}): Promise<VersionsState | null> {
    const r = await this.ready();
    if (!r) return null;
    const before = opts.before != null ? versionNumber(opts.before) : null;
    const { versions, total } = await this.versions.list({ before, limit: opts.limit });
    const latest = (await this.versions.latest())!;
    return { current: publicVersion(latest), published: await this.publishedNow(r.info), versions: versions.map(publicVersion), total, pending: this.pending.dirty };
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
   * Sets what viewers see (the front door has checked the person may edit):
   * "latest", the document as it is, up to the keystroke, or "manual", one
   * version (by default the current one). Edits not yet in a version become
   * one first. Every open tab hears of it ({ type: "versions" }).
   */
  async setPublished(req: PublishRequest): Promise<PublishResult> {
    const r = await this.ready();
    if (!r) return { ok: false, status: 404, error: "There's no such document." };
    if (req?.mode != "latest" && req?.mode != "manual") return { ok: false, status: 400, error: 'Send {"mode": "latest"} or {"mode": "manual", "versionId": "v3"}.' };
    // Edits not yet in a version become one: publishing the current version means up to the keystroke.
    const before = await this.versions.head();
    await this.cutSoon("publish");
    const info = (await this.storage.get<DocumentInfo>(INFO))!;
    if (req.mode == "latest") delete info.published;
    else {
      const head = await this.versions.head();
      const asked = req.versionId == null ? head : versionNumber(req.versionId);
      // The version that was current when the person asked is the current state, now cut.
      const n = asked == before ? head : asked;
      if (n == null || n > head || !(await this.versions.get(n))) return { ok: false, status: 404, error: `There's no version ${req.versionId} of this document: its versions are v1 to v${head}.` };
      info.published = { n };
    }
    await this.storage.put(INFO, info);
    this.pub = info.published?.n ?? null;
    r.opened.broadcast({ type: "versions" });
    this.firePublished(info);
    return { ok: true, published: await this.publishedNow(info) };
  }

  /**
   * Brings a version back: its files are written over the document as it
   * is now (every file: those it didn't have are deleted), as an edit open
   * editors see live, and that becomes a new version, the current one, by
   * `by`, "Restored version <n>". With `path`, only that file comes back
   * ("Restored <path> from version <n>"); the other files stay as they are.
   * Edits not yet in a version become one first, so nothing is lost. In
   * "latest" mode viewers then see it; in "manual" mode what's published stays.
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
    const files = await this.versions.files(v);
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
   * The files viewers see, and which version that is: the published
   * version's in "manual" mode; in "latest" mode the document as it is now
   * (up to the keystroke), with the current version. For the homepage's
   * deploy.
   */
  async publishedFiles(): Promise<{ published: Published; index: string; files: Map<string, Uint8Array> } | null> {
    const r = await this.ready();
    if (!r) return null;
    const published = await this.publishedNow(r.info);
    const v = r.info.published ? await this.versions.get(r.info.published.n) : null;
    return v ? { published, index: v.index, files: await this.versions.files(v) } : { published, index: r.info.index, files: await r.opened.current() };
  }

  /** Opens the room on this document's storage, for as long as the document lives. */
  private async load(): Promise<Opened | null> {
    const info = await this.storage.get<DocumentInfo>(INFO);
    if (!info) return null;
    const onDisk = info.disk && this.deps.disk ? this.deps.disk.store(info.disk.only ? info.index : null) : null;
    const files = onDisk ? FileStore.of({
      ...onDisk,
      // A write to disk is an edit too (the room writes only files whose text changed).
      write: (path, text) => onDisk.write(path, text).pipe(Effect.andThen(Effect.promise(() => this.touch()))),
    }) : fileStoreOf(this.storage, { edited: (path, text) => this.edited(path, text), touch: () => this.touch() });
    const state = stateStoreOf(this.storage);

    // The room's scope lasts as long as the document: a Durable Object is evicted only when
    // idle, by which time the room's writes (400ms behind the last edit) are in.
    const scope = Effect.runSync(Scope.make());
    const room = await Effect.runPromise(Room.make({ log: this.deps.log, writeDelay: this.deps.timing.writeDelay }).pipe(
      Effect.provideService(FileStore, files),
      Effect.provideService(StateStore, state),
      Scope.provide(scope),
    ));
    // A test document's agent is the scripted one: free, and the same every run.
    // Others read the key at each turn (one row of D1), so a key an admin stores, replaces or clears reaches an open document's agent.
    const agent = info.test
      ? { apiKey: Redacted.make(""), model: "script" as const, effort: "medium" }
      : () => this.deps.agentSettings();
    const template = this.deps.pageTemplate;
    const host = makeHost({
      room, files, agent,
      doc: { name: info.index, path: info.index, kind: info.index.endsWith(".md") ? "md" : "html", dir: info.disk?.path ?? info.owner },
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
      // Sharing this document (or another), the documents list (list, make, delete), and for an admin the server's settings and users, as the person.
      serverTools: (person) => this.deps.serverTools(person, info.id),
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
        publish: (req) => this.setPublished(req),
        restore: (ref, by, path) => this.restore(ref, by, path),
      },
      // A new page in its file tree starts as a new document does.
      newPage: template ? (path) => (path.endsWith(".md") ? plainMarkdown : template) : undefined,
    });
    // Every edit to the files, and who made it: a version is cut once a burst of them ends (noteEdit).
    room.doc.on("afterTransaction", (tr: Y.Transaction) => {
      if (!touchesFiles(room.doc, tr)) return;
      const a = authorOf(room.doc, tr);
      this.noteEdit(a ? (a.kind == "disk" ? (info.disk ? "on disk" : this.publisher ?? "files published") : editorOf(a)) : null);
    });
    const naming = namingFor(this.directory, info.id, () => titleOf(room.text(info.index) ?? "", info.index));

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
      handler: host.handler,
      renamed: host.renamed,
      notify: host.notify,
      addTab: host.addTab,
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
    // A version of what it holds, if that isn't the latest one (or there's none yet).
    void this.cutSoon("open");
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
  handler: (request: Request) => Promise<Response>;
  /** A tab joins its person's event channel; returns the leave function. */
  addTab: (user: string, send: (msg: unknown) => void) => () => void;
  room: Room;
  catchUp: () => Promise<void>;
  /** Tells every open tab the document's new title and address. */
  renamed: (name: DocName) => void;
  /** A message for every open tab. */
  notify: (msg: unknown) => void;
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

/** Who a request is from, as the front door said (x-erga-person: JSON {id, name}). */
export function personOf(headers: Headers): Person {
  try {
    const p = JSON.parse(headers.get("x-erga-person") ?? "") as Person;
    if (typeof p.id == "string" && typeof p.name == "string") return p;
  } catch { /* none */ }
  return { id: "anon", name: "Someone" };
}
