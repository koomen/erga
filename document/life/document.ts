// One running document's life, with no Cloudflare in it, and nothing of the layers above it: given a Storage and
// what the server around it offers (DocumentDeps), it keeps the document's record, opens it when the first request
// arrives, closes it when it is idle, deletes it when nobody edits it, and keeps its row in the directory up to
// date. What an open document is (its room, its history, what serves it) comes from the layers above, through the
// hooks at the top of the class: document/api/host.ts is the one document that the Durable Object runs
// (cloudflare/objects/document.ts), and the tests run on MemoryStorage.
//
// Storage keys: `info` (what the document is, read once and kept in memory), `perms` (its permissions, as the
// directory last said: document/api/permissions.ts), `view` (the version viewers see, while no file changes:
// document/api/view.ts), `files/<path>` (a file's bytes), `folders/<path>` (a folder made as one, empty ones too),
// `room/...` (the room's journal: document/store/storage.ts), and the versions' (document/history/versions.ts).
//
// Opening it is reading its journal (one read): its files are a view the room writes, never read back as it opens.
// With no edit, request or participant at work for `closeIdleMs`, it closes again (its room writes everything
// first), so its object can sleep while tabs stay connected (document/room/participants.ts).
//
// In local development a document can be a file or folder on disk (`link`). Its files then stay there: the room's
// storage is the folder itself, reached through the adapter's disk link, and only the room's journal is kept here. A
// single file on its own (`only`) is the only file such a document has.

import * as Effect from "effect/Effect";
import { nameOf, UNTITLED, type DocName, type NamedRow, type NamesDirectory } from "../model/names.ts";
import type { Asker, Person, Role } from "../model/access.ts";
import type { ViewRequest, ViewResult } from "../../shared/view-page.ts";
import { isBlobRef, isText, storeBlob, type BlobRef, type BlobStore } from "../store/blobs.ts";
import { io, StoreError } from "../store/storage.ts";

import { KEYS, type Storage } from "../store/storage.ts";
import { decodeValue, exportPage, type DocSnapshot, type Page } from "../store/snapshot.ts";
import { titleOf } from "../model/pages.ts";
import { throttle } from "../../shared/time.ts";
import { later } from "./later.ts";
import { idleStep, RESTING, type Idle, type IdleEvent } from "./idle.ts";
import { expiryOf, expiryStep, type ExpiryEffect, type ExpiryEvent } from "./expiry.ts";
import { next, type Phase, type PhaseEvent } from "./phase.ts";

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
  /** A scratch document: it goes at its alarm, edited or not, until someone saves it (keep). */
  scratch?: true;
}

/** A document that's a file or folder on disk (local development): where it is, its address there, and whether it's a single file. */
export interface OnDisk { path: string; slug: string; only?: boolean }

/**
 * What a document asks the directory (server/directory/, the Directory
 * itself): its row (made, edited, its kind and expiry, gone), its name, its
 * permissions and the rule that decides them, and the settings it reads.
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
    everyone?: "editor";
  }): Promise<{ doc: NamedRow }>;
  edited(id: string, at: { modified: number | null; pageTitle: string | null }): Promise<{ doc: NamedRow; renamed: boolean } | null>;
  setPages(id: string, pages: number): Promise<void>;
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
  /** What people did each day (server/directory/activity.ts): a version's edits, by each author. */
  activity: { add(login: string | null, counts: { edit?: number; "in:server"?: number; "out:server"?: number }): Promise<void> };
  /** The settings it reads: delete_docs_after_hours (null: never), and the limits max_file_mb and max_project_gb (numbers). */
  config: { get(key: "delete_docs_after_hours" | "max_file_mb" | "max_project_gb"): Promise<number | null> };
}

/** A render of one of the document's pages in the server's browser (view_page, eval_in_page: cloudflare/render.ts). */
export interface RenderJob {
  /** The page's file, and the text to render: the room's now, or a preview's. */
  path: string;
  html: string;
  /** The user whose participant asked (their id): the render reads the document as them. */
  by: string;
  /** The app's origin, where the document's pages origin and its token are made. */
  origin: string;
  req: ViewRequest;
}

/**
 * Runs a page's own API module (its code) in a sandbox: the call goes to the module's default export, and the answer
 * comes back as JSON (document/api/page-api.ts). Throws with what went wrong in the module.
 */
export type Sandbox = (code: string, call: SandboxCall) => Promise<unknown>;
export type SandboxCall = { op: "describe" } | { op: "apply"; html: string; edit: string; input: unknown };

/** The document while it is open, as its life needs it (its room, and what serves it: the layers above give it). */
export interface Open {
  close(): Promise<void>;
  /** Writes what the room holds: whether storage then has everything. */
  flush(): Promise<boolean>;
  /** A text file as the room has it now; null if it holds none there. */
  text(path: string): string | null;
  /** Tells every open tab the document's new title and address. */
  renamed(name: DocName): void;
  /** A document on disk: a file there changed. */
  fileChanged(path: string): Effect.Effect<void, StoreError>;
  /** A document on disk: back in touch with disk, every file is looked at again. */
  catchUp(): Promise<void>;
}

/** How often edits may update a document's row (its time, and the title that follows its heading). */
const DIRECTORY_EVERY_MS = 2000;

/** What the server around a document gives it. */
export interface DocumentDeps {
  storage: Storage;
  directory: DocumentDirectory;
  /** Who has the document open (the adapter's sockets): how many, and closing them all. */
  tabs: { count(): number; closeAll(code: number, reason: string): void };
  /** Runs a page's own API (document/api/page-api.ts) in a sandbox, for the operation call_edit. */
  sandbox: Sandbox;
  /** The key the versions' descriptions are written with ("" for none: a plain description). */
  descriptionKey: () => Promise<string>;
  /** Each domain forgets a deleted document: its link and its published version go. */
  sites: { forget: (docId: string) => Promise<void> };
  /** Local development: this document's storage with its files on disk (document/store/disk.ts), for a document that is one. */
  disk?: { storage: (only: string | null) => Storage };
  /**
   * When versions are cut: how long edits pause first, and the longest burst
   * one version holds; the room's write delay and file delay (room.ts);
   * `closeIdleMs`: how long the document stays open with nothing done (no
   * edit, no request, nothing to cut) before it closes, so its object can
   * sleep while tabs stay connected (never, if unset).
   */
  timing: { idleMs: number; maxMs: number; writeDelay?: number; fileDelay?: number; closeIdleMs?: number };
  /** Work that outlives the request (a version's description). */
  background: (work: Promise<unknown>) => void;
  log: (line: string) => void;
  /** What a new page starts from (the new-document template's page); a plain one if not given. */
  pageTemplate?: string;
  /** A person's picture, if known (hosted: the one the app sent, shared/avatars.ts). */
  avatarOf?: (person: Person) => string | undefined;
  /** The files viewers see changed after a quiet while: whatever the server kept of them goes (where it can reach). */
  viewChanged?: (docId: string) => void;
  /** Where its files that aren't text are kept (R2 on Cloudflare: document/store/blobs.ts); without it (the tests), every file is in its storage. */
  blobs?: BlobStore;
  /** Renders one of its pages in the server's browser (view_page: cloudflare/render.ts); without it, those tools say there's none. */
  render?: (job: RenderJob & { owner: string; id: string }) => Promise<ViewResult>;
}

/** A file as it arrives whole or is copied: text, bytes, or a blob already in the blob store (its ref). */
export type FileData = string | Uint8Array | BlobRef;

const { file: FILE, ref: REF, meta: INFO } = KEYS;

export abstract class Document<O extends Open> {
  /** Its room: closed, opening, open, closing or destroying (phase.ts). */
  private phase: Phase<O> = { is: "closed" };
  private sync: (() => void) | null = null;
  protected readonly storage: Storage;
  /** What the document is, as storage has it (read once; undefined: not read yet, null: no document). */
  private info: DocumentInfo | null | undefined = undefined;
  /** The changes of its record under way, one after another (updateInfo). */
  private infoWrites: Promise<unknown> = Promise.resolve();
  /** When it closes for being idle, with the calls under way (idle.ts). */
  private idle: Idle = RESTING;

  constructor(protected deps: DocumentDeps) {
    this.storage = deps.storage;
  }

  // ---------------------------------------------------------------- what the layers above give (document/api/host.ts)

  /** Opens the room on the document's storage, and what serves it, for as long as the document is open. */
  protected abstract open(info: DocumentInfo): Promise<O>;
  /** The document opened: whatever waits for it joins it (the tabs' sockets), and a version is cut if it needs one. */
  protected abstract onOpen(opened: O, info: DocumentInfo): void;
  /** The document closes for being idle. */
  protected abstract onClose(): void;
  /** Whether it may close for being idle: every edit is in a version, and no participant works. */
  protected abstract quiet(): boolean;
  /** Once the cut of a version under way is done. */
  protected abstract cut(): Promise<unknown>;
  /** A new document: its first version (the files it starts from), and whatever else it needs from the start. */
  protected abstract made(info: DocumentInfo, files: Map<string, Uint8Array | BlobRef>): Effect.Effect<void, StoreError>;
  /** Storage was emptied or replaced: what the layers above read of it is forgotten. */
  protected abstract forget(): void;
  /** The document goes (or its storage is replaced): nothing is pending. */
  protected abstract reset(): void;

  // ---------------------------------------------------------------- its record

  private get directory() { return this.deps.directory; }

  /** What the document is: from memory once read. */
  protected async readInfo(): Promise<DocumentInfo | null> {
    if (this.info === undefined) this.info = (await this.storage.get<DocumentInfo>(INFO)) ?? null;
    return this.info;
  }

  /**
   * The one way to change its record: `change` gets the latest one (null: no document) and returns the next (null: it
   * goes; the same object: no write). One change at a time, each after the last; the cached record changes only once
   * the write is done, and `change` must not edit what it gets.
   */
  protected updateInfo(change: (info: DocumentInfo | null) => DocumentInfo | null): Promise<DocumentInfo | null> {
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
    this.forget();
  }

  private step(e: PhaseEvent<O>) {
    const t = next(this.phase, e);
    this.phase = t.phase;
    return t.do;
  }

  /** The room while it's open; null in any other phase (opens nothing). */
  protected get opened(): O | null {
    return this.phase.is == "open" ? this.phase.opened : null;
  }

  /** Whether the room is open or opening: storage may be behind it. */
  protected get loading(): boolean {
    return this.phase.is == "open" || this.phase.is == "opening";
  }

  /** The room once a load under way ends; null if it isn't open or opening (opens nothing). */
  private async current(): Promise<O | null> {
    const p = this.phase;
    return p.is == "open" ? p.opened : p.is == "opening" ? p.load.catch(() => null) : null;
  }

  /** Once a room closing (or going) has written its last edits: storage then has them. */
  protected settled(): Promise<void> {
    const p = this.phase;
    return p.is == "closing" || p.is == "destroying" ? p.done.catch(() => {}) : Promise.resolve();
  }

  /**
   * The document, opened if it isn't (null if there's no such document, or it is going). One that failed to open
   * (storage failed) throws, and is tried again with the next request.
   */
  protected async room(): Promise<O | null> {
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
      this.idleGo({ on: "hold" });
      return Effect.ensuring(
        work,
        Effect.sync(() => this.idleGo({ on: "release", now: Date.now() }))
      );
    });
  }

  /**
   * Something happened (an edit, a request, a tab's message): the document
   * stays open at least `closeIdleMs` from now. Presence alone (carets
   * moving) doesn't count, so tabs left open let it close.
   */
  activity(): void {
    this.idleGo({ on: "activity", now: Date.now() });
  }

  /**
   * An event of the idle close (idle.ts): the document closes once nothing has happened for `closeIdleMs`, every edit
   * is written and in a version, and no participant is at work. Its room writes what it holds and its timers stop, so the
   * object can sleep. Tabs stay connected; the next edit or request opens it again, from storage.
   */
  private idleGo(e: IdleEvent): void {
    const ms = this.deps.timing.closeIdleMs;
    // With no idle time it never closes: only the calls under way are counted.
    if (!ms) {
      if (e.on == "hold" || e.on == "release") this.idle = { ...this.idle, busy: this.idle.busy + (e.on == "hold" ? 1 : -1) };
      return;
    }
    const t = idleStep(this.idle, e, ms);
    this.idle = t.state;
    if (!t.do) return;
    const opened = this.opened;
    if (t.do.do == "wait") later(t.do.ms, () => this.idleGo({ on: "timer" }));
    else if (t.do.do == "cut")
      void this.cut().then(() =>
        this.idleGo({ on: "cut", now: Date.now(), closable: !!this.opened && !this.info?.disk, quiet: this.quiet() })
      );
    else if (t.do.do == "flush")
      void opened!
        .flush()
        .then((saved) => this.idleGo({ on: "flushed", now: Date.now(), same: this.opened === opened, quiet: this.quiet(), saved }));
    else void this.closeRoom(opened!);
  }

  private async closeRoom(opened: O): Promise<void> {
    this.onClose();
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
  reopen(): Effect.Effect<O | null, StoreError> {
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
    opts: { test?: boolean; expires: number | null; modified?: number; scratch?: boolean }
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
      const info: DocumentInfo = {
        id,
        owner: owner.toLowerCase(),
        index,
        created: Date.now(),
        ...(opts.modified ? { modified: opts.modified } : {}),
        ...(opts.test ? { test: true } : {}),
        ...(opts.scratch ? { scratch: true as const } : {}),
      };
      yield* io(() => self.updateInfo(() => info));
      if (!info.test && opts.expires != null) yield* io(() => self.storage.setAlarm(opts.expires!));
      // Its first version: the files it starts from.
      const first = new Map(Object.entries(files).map(([path, data]) => [path, typeof data == "string" ? encoder.encode(data) : data]));
      yield* self.made(info, first);
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
      await this.updateInfo((info) =>
        info ? { ...info, index, disk } : { id, owner: owner.toLowerCase(), index, created: Date.now(), disk }
      );
      await this.storage.deleteAlarm();
      return (await this.addRow())!;
    });
  }

  /** The document's page, or null if there's no such document. */
  index(): Effect.Effect<string | null, StoreError> {
    return Effect.map(
      io(() => this.readInfo()),
      (info) => info?.index ?? null
    );
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
      test: info.test,
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
      yield* io(() => self.expire({ type: "alarm", now: Date.now(), tabs: self.deps.tabs.count(), busy: self.idle.busy, setting }));
    });
  }

  private async destroy(info: DocumentInfo): Promise<void> {
    // One on disk writes what it holds there first, while the dev server is still connected.
    if (info.disk && this.opened) await this.opened.flush();
    await this.shutDown(4404, "document deleted", async () => {
      await this.storage.deleteAlarm();
      await this.storage.deleteAll();
    });
    await this.directory.remove(info.id);
    // If it was published, its domain serves nothing from now on.
    await this.deps.sites.forget(info.id).catch((e) => this.deps.log(`couldn't tell the domains: ${e}`));
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
  protected async rememberName(name: DocName): Promise<DocName> {
    await this.updateInfo((info) => (info && JSON.stringify(info.name) != JSON.stringify(name) ? { ...info, name } : info));
    return name;
  }

  /**
   * The page's text: from the room while it's open (storage has it a little
   * later), else from storage. For a document on disk, from disk only when
   * `fromDisk` (the dev server is connected); else only from its room, since
   * reading disk waits for the dev server, which may be linking it just then.
   */
  private async pageText(info: DocumentInfo, fromDisk = false): Promise<string | null> {
    const open = this.opened?.text(info.index);
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
  protected async touch(): Promise<void> {
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
          ? o.fileChanged(path)
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
      (o) => (o ? Effect.promise(() => o.flush()) : Effect.void)
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
   * Becomes `snap` (a staging instance only: the app allows it only with
   * SNAPSHOT_FROM, its primary): whoever has it open is
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
      this.reset();
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

  /** Opens the document (`open`), for as long as it stays open: `room` starts it. */
  private async load(): Promise<O | null> {
    const info = await this.readInfo().catch((e) => {
      this.step({ on: "loaded", opened: null });
      throw e;
    });
    if (!info) {
      this.step({ on: "loaded", opened: null });
      return null;
    }
    const opened = await this.open(info).catch((e) => {
      this.step({ on: "loaded", opened: null });
      throw e;
    });
    this.step({ on: "loaded", opened });
    // Deleted meanwhile: its teardown closes it.
    if (this.opened !== opened) return opened;
    this.onOpen(opened, info);
    this.activity();
    // Now with its title, for one on disk.
    if (info.disk) this.syncDirectory().catch((e) => this.deps.log(`couldn't update ${info.id}'s row: ${e}`));
    return opened;
  }
}
