// One running document, with no Cloudflare in it: given a Storage and what
// the server around it offers (DocumentDeps), it keeps the document's files
// and its room's state, opens the room when the first request arrives,
// serves the document's API (host.ts), cuts versions as it is edited,
// restores them, deletes itself when nobody edits it, and keeps its
// row in the directory up to date. cloudflare/objects/document.ts runs one in
// a Durable Object; the tests run one on MemoryStorage.
//
// The app says who's asking, and the document decides what they may
// do: it forwards each request with the path inside the document (/api/doc,
// not /koomen/abc123/api/doc), the document's public address in x-erga-base,
// the signed-in person in x-erga-person and who they are in x-erga-who.
// The document keeps a copy of its permissions (the directory pushes every
// change; D1 stays the truth) and decides with the directory's own rule
// (access.ts), so a request here asks the database nothing. What they may do
// goes on as x-erga-access ("edit", or "view":
// their room connection is then read-only, and so are their agent and
// the files they send whole). A read of a file with a key the app checked (the
// viewer's files, the editor's pages origin) says so in x-erga-checked. A request that came with an agent token also has x-erga-agent:
// only those may run the agent's tools (/api/tools/<name>, which the server calls), as the person
// the token stands for, who may do what they last could.
//
// Storage keys: `info` (what the document is, read once and kept in
// memory), `perms` (its permissions, as the directory last said: access.ts), `view`
// (the version viewers see, while no file changes: view.ts), `files/<path>` (a file's bytes), `folders/<path>` (a folder made
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
import * as Fiber from "effect/Fiber";
import { nameOf, UNTITLED, type NamedRow, type NamesDirectory } from "./names.ts";
import { DocumentAccess, personOf, type Asker, type Person, type Role } from "./access.ts";
import { DocumentView, type ViewAnswer } from "./view.ts";
import type { DocumentAgents, RenderJob } from "./agent.ts";
import type { ViewResult } from "../shared/agent-log.ts";
import { docFile, typeOf, type EditorCalls } from "./host.ts";
import { blobPointer, isBlobRef, storeBlob, type BlobRef, type BlobStore } from "./blobs.ts";
import type { DocName } from "./api.ts";
import { io, NoSuchDocument, StoreError, type Connection } from "./room.ts";

import { KEYS, type Storage } from "./storage.ts";
import { assets, files as texts } from "./content.ts";
import type { RestoreResult, Version, VersionsState } from "./versions.ts";
import { decodeValue, exportPage, type DocSnapshot, type Page } from "./snapshot.ts";
import { cleanRel, kindOf, titleOf, type DocKind } from "./pages.ts";
import { throttle } from "../shared/time.ts";
import { later } from "./later.ts";
import { History } from "./history.ts";
import { expiryOf, expiryStep, type ExpiryEffect, type ExpiryEvent } from "./expiry.ts";
import { openRoom, type Opened } from "./open.ts";
import { next, type Phase, type PhaseEvent } from "./phase.ts";
import { isText, Uploads, type Published } from "./uploads.ts";

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
  /** A document (one page) or a project (pages). */
  kind: DocKind;
  /** A scratch document: it goes at its alarm, edited or not, until someone saves it (keep). */
  scratch?: true;
}

/** A document that's a file or folder on disk (local development): where it is, its address there, and whether it's a single file. */
export interface OnDisk { path: string; slug: string; only?: boolean }

/**
 * What a document asks the directory (server/directory/, the Directory
 * itself): its row (made, edited, its kind and expiry, gone), its name, its
 * permissions and the rule that decides them, which document is the homepage,
 * and the settings it reads.
 */
export interface DocumentDirectory extends NamesDirectory {
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
  /** A scratch document saved: on its owner's list, and kept. */
  keep(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  decide(
    who: Asker | null,
    doc: { id: string; owner: string; test: boolean },
    permissions: readonly { login: string; role: Role }[]
  ): Promise<Role | null>;
  permissions(id: string): Promise<{ login: string; role: Role }[]>;
  homeId(): Promise<string | null>;
  /** What people did each day (server/directory/activity.ts): a version's edits, by each author. */
  activity: { add(login: string | null, counts: { edit?: number; "in:server"?: number; "out:server"?: number }): Promise<void> };
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
  home: { forget: (docId: string) => Promise<void> };
  /** Local development: this document's storage with its files on disk (document/disk.ts), for a document that is one. */
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
  /** A person's picture, if known (hosted: the one the app sent, shared/avatars.ts). */
  avatarOf?: (person: Person) => string | undefined;
  /** The files viewers see changed after a quiet while: whatever the server kept of them goes (where it can reach). */
  viewChanged?: (docId: string) => void;
  /** Where its files that aren't text are kept (R2 on Cloudflare: document/blobs.ts); without it (the tests), every file is in its storage. */
  blobs?: BlobStore;
  /** Renders one of its pages in the server's browser (view_page: cloudflare/render.ts); without it, those tools say there's none. */
  render?: (job: RenderJob & { owner: string; id: string }) => Promise<ViewResult>;
}

/** A file as it arrives whole or is copied: text, bytes, or a blob already in the blob store (its ref). */
export type FileData = string | Uint8Array | BlobRef;

const { file: FILE, ref: REF, meta: INFO } = KEYS;

export class Document {
  /** Its room: closed, opening, open, closing or destroying (phase.ts). */
  private phase: Phase<Opened> = { is: "closed" };
  private sync: (() => void) | null = null;
  private readonly storage: Storage;
  /** Its versions: the edits no version holds yet, the cuts, and the reads and restores (history.ts). */
  private history: History;
  /** Files arriving whole (uploads.ts). */
  private uploads: Uploads;
  /** Room connections that may edit: when the last one goes, a version is cut. */
  private editing = 0;
  /** Who may edit, by person id, as the app said last (x-erga-access): their agents may too. */
  private editors = new Map<string, boolean>();
  /** Who may do what: its copy of its permissions, and the directory's rule (access.ts). */
  private access: DocumentAccess;
  /** What viewers see (view.ts). */
  private views: DocumentView;
  /** What the document is, as storage has it (read once; undefined: not read yet, null: no document). */
  private info: DocumentInfo | null | undefined = undefined;
  /** The changes of its record under way, one after another (updateInfo). */
  private infoWrites: Promise<unknown> = Promise.resolve();
  /** Requests and calls under way: the document doesn't close under them. */
  private busy = 0;
  private lastActive = 0;
  private idleTimer: Fiber.Fiber<void> | null = null;

  constructor(private deps: DocumentDeps) {
    this.storage = deps.storage;
    this.history = new History({
      deps,
      opened: () => this.opened,
      room: () => this.room(),
      info: () => this.readInfo(),
      updateInfo: (change) => this.updateInfo(change),
      activity: () => this.activity(),
      publish: (files, remove, by) => this.uploads.publish(files, remove, by),
    });
    this.uploads = new Uploads({
      deps,
      room: () => this.room(),
      info: () => this.readInfo(),
      hold: (work) => this.hold(work),
      touch: () => this.touch(),
    });
    this.access = new DocumentAccess({
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
      changedAfterQuiet: () => {
        const id = this.info?.id;
        if (id) deps.viewChanged?.(id);
      },
      info: () => this.readInfo(),
      tell: (ver) => this.opened?.broadcast({ type: "view", ver }),
    });
  }

  private get idleMs() { return this.deps.timing.idleMs; }
  private get maxMs() { return this.deps.timing.maxMs; }
  private get directory() { return this.deps.directory; }

  /** What the document is: from memory once read. */
  private async readInfo(): Promise<DocumentInfo | null> {
    if (this.info === undefined) this.info = (await this.storage.get<DocumentInfo>(INFO)) ?? null;
    return this.info;
  }

  /**
   * The one way to change its record: `change` gets the latest one (null: no document) and returns the next (null: it
   * goes; the same object: no write). One change at a time, each after the last; the cached record changes only once
   * the write is done, and `change` must not edit what it gets.
   */
  private updateInfo(change: (info: DocumentInfo | null) => DocumentInfo | null): Promise<DocumentInfo | null> {
    const write = this.infoWrites.then(async () => {
      const info = await this.readInfo();
      const next = change(info);
      if (next === info) return info;
      await (next ? this.storage.put(INFO, next) : this.storage.delete(INFO));
      this.info = next;
      return next;
    });
    this.infoWrites = write.catch(() => {});
    return write;
  }

  /**
   * Its expiry after `event` (expiry.ts): the record changes first, then the effects run. False if there's no such
   * document. `edit` changes the record too, in the same write (an edit's time).
   */
  private async expire(event: ExpiryEvent, edit: (info: DocumentInfo) => DocumentInfo = (i) => i): Promise<boolean> {
    const seen: { info?: DocumentInfo; effects: ExpiryEffect[] } = { effects: [] };
    await this.updateInfo((info) => {
      if (!info) return null;
      const step = expiryStep(expiryOf(info), event);
      seen.info = info;
      seen.effects = step.effects;
      if (step.state == "deleted") return null;
      const next = edit(info);
      if (step.state != "kept" || !next.scratch) return next;
      const { scratch: _, ...saved } = next;
      return { ...saved, modified: saved.modified ?? Date.now() };
    });
    const { info, effects } = seen;
    if (!info) return false;
    const forgot = (e: unknown) => this.deps.log(`couldn't update ${info.id}'s row: ${e}`);
    for (const effect of effects) {
      if (effect.type == "deleteAlarm") await this.storage.deleteAlarm();
      else if (effect.type == "alarmAt") {
        await this.storage.setAlarm(effect.at);
        await this.directory.setExpires(info.id, effect.at).catch(forgot);
      } else if (effect.type == "neverExpires") await this.directory.setExpires(info.id, null).catch(forgot);
      else if (effect.type == "saved") await this.directory.keep(info.id);
      else {
        this.deps.log(`deleting ${info.owner}/${info.id}: ${effect.why}`);
        await this.destroy(info);
      }
    }
    return true;
  }

  /** Storage was emptied or replaced: what was read of it is forgotten. */
  private forgetStorage(): void {
    this.info = undefined;
    this.access.forget();
    this.views.forget();
    this.history.forget();
  }

  private step(e: PhaseEvent<Opened>) {
    const t = next(this.phase, e);
    this.phase = t.phase;
    return t.do;
  }

  /** The room while it's open; null in any other phase (opens nothing). */
  private get opened(): Opened | null {
    return this.phase.is == "open" ? this.phase.opened : null;
  }

  /** The room once a load under way ends; null if it isn't open or opening (opens nothing). */
  private async current(): Promise<Opened | null> {
    const p = this.phase;
    return p.is == "open" ? p.opened : p.is == "opening" ? p.load.catch(() => null) : null;
  }

  /** Once a room closing (or going) has written its last edits: storage then has them. */
  private settled(): Promise<void> {
    const p = this.phase;
    return p.is == "closing" || p.is == "destroying" ? p.done.catch(() => {}) : Promise.resolve();
  }

  /**
   * The document, opened if it isn't (null if there's no such document, or it is going). One that failed to open
   * (storage failed) throws, and is tried again with the next request.
   */
  private async room(): Promise<Opened | null> {
    for (;;) {
      const d = this.step({ on: "use" })!;
      if (d.do == "use") {
        this.activity();
        return d.opened;
      }
      if (d.do == "refuse") return null;
      if (d.do == "load") this.step({ on: "load", load: this.load() });
      else if (d.do == "await") {
        if (!(await d.load)) return null;
      } else if (d.do == "wait") await d.done.catch(() => {});
    }
  }

  /** Runs `work` with the document held open: it doesn't close for being idle meanwhile. */
  hold<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.suspend(() => {
      this.busy++;
      return Effect.ensuring(
        work,
        Effect.sync(() => {
          this.busy--;
          this.activity();
        })
      );
    });
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
    if (!this.idleTimer)
      this.idleTimer = later(ms, () => {
        this.idleTimer = null;
        void this.closeIfIdle();
      });
  }

  /**
   * Closes the document once nothing has happened for `closeIdleMs`, every
   * edit is written and in a version, and no agent is at work: its room
   * writes what it holds and its timers stop, so the object can sleep. Tabs
   * stay connected; the next edit or request opens it again, from storage.
   */
  private async closeIfIdle(): Promise<void> {
    const ms = this.deps.timing.closeIdleMs!;
    await this.history.cutting;
    const opened = this.opened;
    if (!opened || this.info?.disk || this.idleTimer) return;
    const idle = () => this.lastActive + ms <= Date.now() && this.busy == 0 && !this.history.dirty && !this.history.agentWorking();
    // Its room writes everything first: while a write fails, it stays open (its room tries again), so nothing is lost.
    if (idle()) await Effect.runPromise(opened.room.flush);
    if (this.opened !== opened || this.idleTimer) return;
    if (!idle() || !opened.room.saved) {
      const wait = this.lastActive + ms - Date.now();
      this.idleTimer = later(wait > 0 ? wait : Math.min(ms, 1000), () => {
        this.idleTimer = null;
        void this.closeIfIdle();
      });
      return;
    }
    this.editing = 0;
    this.deps.tabs.detach?.();
    const done = opened.close().catch((e) => this.deps.log(`couldn't close the room: ${e}`));
    this.step({ on: "closing", done });
    await done;
    this.step({ on: "closed" });
  }

  /** Whether the document is open now (its room loaded). */
  isOpen(): boolean {
    return this.opened != null;
  }

  /** Opens the document if it isn't (a tab's message after a sleep): null if there's no such document. */
  reopen(): Effect.Effect<Opened | null, StoreError> {
    return io(() => this.room());
  }

  /**
   * Creates the document, whose row the app has just added to the
   * directory, from a template's files; false if it already exists. Unless
   * someone edits it, it's deleted at `expires` (the delete_docs_after_hours setting
   * after it's made, or sooner when local development asks, to test it). A scratch one goes then, edited or not.
   */
  create(
    owner: string,
    id: string,
    files: Record<string, FileData>,
    index: string,
    opts: { test?: boolean; expires: number | null; modified?: number; kind?: DocKind; scratch?: boolean }
  ): Effect.Effect<boolean, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      if (yield* io(() => self.readInfo())) return false;
      const encoder = new TextEncoder();
      const blobs = self.deps.blobs;
      // A blob (a copy's file that is one) goes by its ref; bytes that aren't text go to the blob store first.
      const entries: (readonly [string, unknown])[] = [];
      for (const [path, data] of Object.entries(files)) {
        if (isBlobRef(data)) entries.push([REF + path, data]);
        else if (typeof data == "string") entries.push([FILE + path, encoder.encode(data)]);
        else if (blobs && !isText(path, data))
          entries.push([REF + path, yield* storeBlob(blobs, data).pipe(Effect.mapError((e) => new StoreError({ message: e.message })))]);
        else entries.push([FILE + path, data]);
      }
      for (let i = 0; i < entries.length; i += 128) yield* io(() => self.storage.put(Object.fromEntries(entries.slice(i, i + 128))));
      // A project if asked, or if its files have more than one page; else a document.
      const kind = opts.kind ?? kindOf(Object.keys(files));
      const info: DocumentInfo = {
        id,
        owner: owner.toLowerCase(),
        index,
        created: Date.now(),
        kind,
        ...(opts.modified ? { modified: opts.modified } : {}),
        ...(opts.test ? { test: true } : {}),
        ...(opts.scratch ? { scratch: true as const } : {}),
      };
      yield* io(() => self.updateInfo(() => info));
      if (!info.test && opts.expires != null) yield* io(() => self.storage.setAlarm(opts.expires!));
      // Its first version: the files it starts from.
      const first = new Map(Object.entries(files).map(([path, data]) => [path, typeof data == "string" ? encoder.encode(data) : data]));
      yield* self.history.versions.cut(first, index, [info.owner], "First version");
      // Who may open it, from the start: its first viewer needn't wait for the directory.
      yield* Effect.promise(() => self.access.readPermissions(id).catch((e) => self.deps.log(`couldn't read ${id}'s permissions: ${e}`)));
      return true;
    });
  }

  /**
   * Local development: the document for a file or folder on disk, made if
   * it doesn't exist yet, and its row in the directory (its address the
   * folder's or file's name, `disk.slug`). Its files stay on disk (the dev
   * server connects to /api/mirror to reach them); it never expires, and
   * deleting it leaves them as they are.
   */
  link(owner: string, id: string, index: string, disk: OnDisk): Effect.Effect<NamedRow, StoreError> {
    return io(async () => {
      // A single file is a document; a folder a project (it may hold pages).
      await this.updateInfo((info) =>
        info
          ? { ...info, index, disk }
          : { id, owner: owner.toLowerCase(), index, created: Date.now(), disk, kind: disk.only ? "document" : "project" }
      );
      await this.storage.deleteAlarm();
      return (await this.addRow())!;
    });
  }

  /**
   * Changes the document's kind (the switch in the document's settings, or an agent: make_project, make_document):
   * a project may have more pages, a document one. The tree's operation checks a project has one page before it
   * becomes a document. Kept here, where the rule is checked, and in its row, which the documents list reads.
   */
  setKind(kind: DocKind): Effect.Effect<void, StoreError> {
    return io(async () => {
      const info = await this.updateInfo((info) => (info && info.kind != kind ? { ...info, kind } : info));
      if (info) await this.directory.setKind(info.id, kind);
    });
  }

  /** Every file the document holds (the room's view: text files and others). */
  paths(): Effect.Effect<string[], StoreError> {
    return Effect.map(
      io(() => this.room()),
      (opened) => (opened ? [...new Set([...texts(opened.room.doc).keys(), ...assets(opened.room.doc).keys()])].sort() : [])
    );
  }

  /** The document's page, or null if there's no such document. */
  index(): Effect.Effect<string | null, StoreError> {
    return Effect.map(
      io(() => this.readInfo()),
      (info) => info?.index ?? null
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
   * A scratch document saved (save_document): it stays, as an edited one does, and its row says so (again, if the
   * row missed it the first time). False if there's no such document.
   */
  keep(): Effect.Effect<boolean, StoreError> {
    return io(() => this.expire({ type: "save" }));
  }

  /** Deletes the document (the app has asked the directory who may): everyone on it is disconnected. */
  delete(): Effect.Effect<boolean, StoreError> {
    return io(() => this.expire({ type: "delete" }));
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
   * The alarm: its unedited time is up (expiry.ts decides what then). The setting is read first, so the decision
   * comes after the last wait, from the record as it is then: a save or a first edit meanwhile counts.
   */
  wake(): Effect.Effect<void, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const info = yield* io(() => self.readInfo());
      // A kept one stays kept: no need to ask the directory.
      if (!info || expiryOf(info) == "kept") return;
      const setting = yield* io(() => self.directory.config.get("delete_docs_after_hours"));
      yield* io(() => self.expire({ type: "alarm", now: Date.now(), tabs: self.deps.tabs.count(), busy: self.busy, setting }));
    });
  }

  private async destroy(info: DocumentInfo): Promise<void> {
    // One on disk writes what it holds there first, while the dev server is still connected.
    if (info.disk && this.opened) await Effect.runPromise(this.opened.room.flush);
    await this.shutDown(4404, "document deleted", async () => {
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
    });
    await this.directory.remove(info.id);
    // If it was the homepage, its snapshot goes too (the next / makes another).
    await this.deps.home.forget(info.id).catch((e) => this.deps.log(`couldn't tell the homepage: ${e}`));
  }

  /**
   * Brings its row up to date after edits: when it was last edited, and the
   * title, which follows its first heading until someone sets it (and the
   * slug the title). Every open tab hears of a new title or address.
   */
  private async syncDirectory(fromDisk = false): Promise<void> {
    const info = await this.readInfo();
    if (!info) return;
    const text = await this.pageText(info, fromDisk);
    const r = await this.directory.edited(info.id, {
      modified: info.modified ?? null,
      pageTitle: text != null ? titleOf(text) : null,
    });
    if (r) await this.rememberName(nameOf(r.doc));
    if (r?.renamed) (await this.current())?.renamed(nameOf(r.doc));
  }

  /**
   * The document's title and address as the directory last said (D1 stays
   * the truth: every rename goes through this document, which keeps what
   * the directory answers), so opening it asks the directory nothing.
   */
  private async rememberName(name: DocName): Promise<DocName> {
    const info = await this.readInfo();
    await this.updateInfo((info) => (info && JSON.stringify(info.name) != JSON.stringify(name) ? { ...info, name } : info));
    return name;
  }

  /** A message for everyone who has the document open (the homepage's deploy status). Opens nothing. */
  notify(msg: unknown): void {
    this.opened?.broadcast(msg);
  }

  /**
   * The page's text: from the room while it's open (storage has it a little
   * later), else from storage. For a document on disk, from disk only when
   * `fromDisk` (the dev server is connected); else only from its room, since
   * reading disk waits for the dev server, which may be linking it just then.
   */
  private async pageText(info: DocumentInfo, fromDisk = false): Promise<string | null> {
    const open = this.opened?.room.text(info.index);
    if (open != null) return open;
    if (info.disk) {
      if (!fromDisk || !this.deps.disk) return null;
      const bytes = await this.deps.disk.storage(info.disk.only ? info.index : null).get<Uint8Array>(FILE + info.index);
      return bytes ? new TextDecoder().decode(bytes) : null;
    }
    await this.settled();
    const bytes = await this.storage.get<Uint8Array>(FILE + info.index);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  /**
   * A file changed: the document has been edited, so it stays (and its row
   * says when). Only its record is written (in the same transaction as the
   * files, when the room writes them), and its alarm deleted once.
   */
  private async touch(): Promise<void> {
    const modified = Date.now();
    if (!(await this.expire({ type: "edit" }, (info) => ({ ...info, modified })))) return;
    // At most every DIRECTORY_EVERY_MS, however fast the edits come; the last always lands.
    this.sync ??= throttle(
      () => this.syncDirectory().catch((e) => this.deps.log(`couldn't update ${this.info?.id}'s row: ${e}`)),
      DIRECTORY_EVERY_MS
    );
    this.sync();
  }

  /** Where its files are, for a document on disk (local development); null for any other. */
  diskPath(): Effect.Effect<string | null, StoreError> {
    return Effect.map(
      io(() => this.readInfo()),
      (info) => info?.disk?.path ?? null
    );
  }

  /** A file on disk changed (the dev server says which): the room takes it; closed, the page's title comes from disk. */
  diskChanged(path: string): Effect.Effect<void, StoreError> {
    return Effect.flatMap(
      io(() => this.current()),
      (o) =>
        o
          ? o.room.fileChanged(path)
          : io(async () => {
              if (path == (await this.readInfo())?.index) await this.syncDirectory(true);
            })
    );
  }

  /**
   * The dev server is connected (again): every file there, and every one the room holds, is looked at again. With no
   * room open, the row takes the page's title from disk (linked, the row had none: the files weren't reachable yet).
   */
  diskConnected(): Effect.Effect<void, StoreError> {
    return io(async () => {
      const open = await this.current();
      await (open ? open.catchUp() : this.syncDirectory(true));
    });
  }

  /** Writes what the room holds (before the dev server goes). */
  flush(): Effect.Effect<void, StoreError> {
    return Effect.flatMap(
      io(() => this.current()),
      (o) => (o ? o.room.flush : Effect.void)
    );
  }

  /**
   * A part of its storage, and its alarm: the snapshot staging copies,
   * a part at a time, since the whole can be more than
   * one RPC carries. Only reads: the room isn't opened, nothing is written,
   * the directory isn't touched. Null if there's no document.
   */
  exportStorage(id: string, page: Page): Effect.Effect<DocSnapshot | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const storage = self.storage;
      if (page.after == null && (yield* io(() => storage.get(INFO))) == null) return null;
      // An open room writes its files first, so the copy has them as they are (else it writes them as it opens there).
      if (page.after == null) yield* Effect.ignore(self.flush());
      const alarm = yield* io(() => storage.getAlarm());
      return yield* io(() =>
        exportPage(id, page, alarm, (after, limit) => storage.list(after == null ? { limit } : { startAfter: after, limit }))
      );
    });
  }

  /**
   * Becomes `snap` (staging only: the app allows it only with
   * SNAPSHOT_IMPORT, never on production): whoever has it open is
   * disconnected and the room closed first (it writes what it holds as it
   * closes), then its storage is emptied and the snapshot written in. A
   * later part (`append`) is only written in.
   */
  importStorage(snap: DocSnapshot): Effect.Effect<void, StoreError> {
    return io(() =>
      this.shutDown(1012, "document replaced by a snapshot", async () => {
        if (!snap.append) {
          await this.storage.deleteAlarm();
          await this.storage.deleteAll();
        }
        const entries = Object.fromEntries(snap.entries.map(([k, e]) => [k, decodeValue(e)]));
        const keys = Object.keys(entries);
        for (let i = 0; i < keys.length; i += 100)
          await this.storage.put(Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, entries[k]])));
        if (snap.alarm != null) await this.storage.setAlarm(snap.alarm);
      })
    );
  }

  /** Empties it (staging only: a document production no longer has). The directory row is already gone with the old database. */
  wipeStorage(): Effect.Effect<void, StoreError> {
    return io(() =>
      this.shutDown(1012, "document replaced by a snapshot", async () => {
        await this.storage.deleteAlarm();
        await this.storage.deleteAll();
      })
    );
  }

  /**
   * Closes the room for good while `work` changes its storage under it (a delete, a snapshot): every tab is
   * disconnected, and a call meanwhile finds no document. The room writes what it holds as it closes, so it closes
   * before `work` starts; what was read of storage is forgotten after it.
   */
  private async shutDown(code: number, reason: string, work: () => Promise<void>): Promise<void> {
    for (;;) {
      const d = this.step({ on: "destroy" })!;
      if (d.do == "wait") {
        await d.done.catch(() => {});
        continue;
      }
      if (d.do != "teardown") return;
      this.deps.tabs.closeAll(code, reason);
      this.history.reset();
      const done = (async () => {
        const opened = await d.room;
        await opened?.close().catch((e) => this.deps.log(`couldn't close the room: ${e}`));
        await work();
        this.forgetStorage();
      })();
      this.step({ on: "destroying", done });
      try {
        await done;
      } finally {
        this.step({ on: "destroyed" });
      }
      return;
    }
  }

  /**
   * A request inside the document (not a WebSocket: the adapter takes those
   * after `admit`). Viewers see the files as they are now, at /doc/.
   */
  handle(request: Request): Effect.Effect<Response, StoreError> {
    return Effect.flatMap(this.authorize(request), (allowed) =>
      allowed instanceof Response ? Effect.succeed(allowed) : io(() => this.serve(allowed))
    );
  }

  private async serve(request: Request): Promise<Response> {
    if (request.method == "PUT" && new URL(request.url).pathname.startsWith("/api/files/"))
      return Effect.runPromise(this.hold(io(() => this.uploads.upload(request))));
    // Someone viewing it: its files straight from storage while the room isn't open, without opening it
    // (once a room closing a moment ago has written them).
    await this.settled();
    const stored = this.phase.is == "open" || this.phase.is == "opening" ? null : await this.storedFile(request);
    if (stored) return stored;
    const self = this;
    return Effect.runPromise(
      this.hold(
        Effect.gen(function* () {
          const opened = yield* self.admit(request);
          // Not made yet: asked again next time, since it may be by then (made, or linked from disk).
          if (!opened) return new Response("No such document", { status: 404 });
          return yield* io(() => opened.handler(request));
        })
      )
    );
  }

  /**
   * Opens the document for a request and notes what the app said the
   * person may do; null if there's no such document. The adapter calls it
   * before it accepts a WebSocket.
   */
  admit(request: Request): Effect.Effect<Opened | null, StoreError> {
    return Effect.map(
      io(() => this.room()),
      (opened) => {
        if (!opened) return null;
        if (request.headers.has("x-erga-person"))
          this.editors.set(personOf(request.headers).id, request.headers.get("x-erga-access") == "edit");
        return opened;
      }
    );
  }

  /**
   * A tab joins the room over a socket the adapter holds: `send` carries the
   * room's messages to it. Returns what to do with the tab's messages and
   * its going, or null when the tab holds another epoch's history (it is
   * refused, never merged). Someone who may only view joins read-only: they
   * see every edit, and theirs go nowhere.
   */
  joinRoom(opened: Opened, o: { epoch: string | null; readOnly: boolean; send: (m: Uint8Array | string) => void; events?: Person | null; watch?: boolean }): { receive: (data: Uint8Array) => boolean; left: () => void } | null {
    // A watcher (a viewer's page): it hears what every tab hears, first the version to show, and never joins the room.
    if (o.watch && o.events) {
      const leave = opened.addTab(o.events.id, (msg) => o.send(JSON.stringify(msg)), true);
      this.views.greet((ver) => o.send(JSON.stringify({ type: "view", ver })));
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
      // A tab that joins as the document wakes brings no request: what its person may do is what its socket says.
      if (!this.editors.has(person.id)) this.editors.set(person.id, !o.readOnly);
      void opened.hello(person, !o.readOnly).then(json, (e: unknown) => this.deps.log(`couldn't greet ${person.id}'s tab: ${e}`));
      tab = opened.addTab(person.id, json);
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
        if (!o.readOnly && --this.editing == 0) void this.history.cutSoon("left");
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
    if (isBlobRef(ref)) return this.deps.blobs ? blobPointer(ref, typeOf(rel), { "Cache-Control": "no-cache" }) : null;
    const bytes = got.get(FILE + rel) as Uint8Array | undefined;
    if (!bytes) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const r = docFile(rel, bytes, request.headers.get("if-none-match"), request.headers.get("range"), "stored");
    return new Response(request.method == "HEAD" ? null : (r.body as Uint8Array<ArrayBuffer>), { status: r.status, headers: { "Content-Type": r.type, ...r.headers } });
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
   * (`anyone`: the homepage, which everyone may view), which file the address `page` is (its path under the
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
      return yield* self
        .hold(self.views.answer(info, role, name, opts.page))
        .pipe(Effect.catchTag("NoSuchDocument", () => Effect.succeed(null)));
    });
  }

  /** An operation's call (host.ts) on the document, opened; null if there's none. */
  call<A>(f: (calls: EditorCalls) => A | Promise<A>): Effect.Effect<A | null, StoreError> {
    return io(async () => {
      const o = await this.room();
      return o ? f(o.calls) : null;
    });
  }

  // ---------------------------------------------------------------- versions (history.ts), and files arriving whole (uploads.ts)

  /** Files arriving whole, from the server's API (Uploads.publish): says what it did with each. */
  publish(files: Record<string, FileData>, remove: string[], by?: string): Effect.Effect<Published, StoreError | NoSuchDocument> {
    return this.uploads.publish(files, remove, by);
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
  restore(ref: string | number, by: string, path?: string | null): Effect.Effect<RestoreResult, StoreError> {
    return this.history.restore(ref, by, path);
  }

  /** The document as it is now (up to the keystroke), with its current version: what the homepage and its site deploy. */
  currentFiles(): Effect.Effect<{ version: Version; index: string; files: Map<string, Uint8Array> } | null, StoreError> {
    return this.history.currentFiles();
  }

  /** Opens the room on this document's storage (open.ts), for as long as the document lives: `room` starts it. */
  private async load(): Promise<Opened | null> {
    const info = await this.readInfo().catch((e) => {
      this.step({ on: "loaded", opened: null });
      throw e;
    });
    if (!info) {
      this.step({ on: "loaded", opened: null });
      return null;
    }
    const opened = await openRoom({
      deps: this.deps,
      info,
      history: this.history,
      owner: () => this.access.owner(),
      canEdit: (id) => this.editors.get(id) ?? false,
      touch: () => this.touch(),
      readInfo: () => this.readInfo(),
      rememberName: (name) => this.rememberName(name),
      putFile: (path, bytes, by) => this.uploads.putFile(path, bytes, by),
      kind: () => this.info?.kind ?? "project",
      setKind: (kind) => this.setKind(kind),
      edited: (author) => {
        this.views.changed();
        this.history.noteEdit(author);
      },
    }).catch((e) => {
      this.step({ on: "loaded", opened: null });
      throw e;
    });
    this.step({ on: "loaded", opened });
    // Deleted meanwhile: its teardown closes it.
    if (this.opened !== opened) return opened;
    // A version of what it holds, if it stopped with edits no version has (or there's none yet).
    if (info.uncut || (await Effect.runPromise(this.history.versions.head)) == 0) void this.history.cutSoon("open");
    // Tabs connected while it was closed join it now.
    this.deps.tabs.attach?.(opened);
    this.activity();
    // Now with its title, for one on disk.
    if (info.disk) this.syncDirectory().catch((e) => this.deps.log(`couldn't update ${info.id}'s row: ${e}`));
    return opened;
  }
}
