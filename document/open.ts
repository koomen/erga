// Opening a document's room: the room on the document's storage (or, for a
// document on disk, on the folder there), the document's host (host.ts)
// around it, and what the document holds once it is open (Opened). Every
// edit to the files reaches the Document (`edited`), which cuts versions.

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type * as Y from "yjs";
import { personOf, viaOf, type Person } from "./access.ts";
import type { RenderJob } from "./agent.ts";
import type { DocName, Hello } from "./api.ts";
import type { BlobRef } from "./blobs.ts";
import { assets, authorOf, editorOf, files as texts, folders } from "./content.ts";
import type { DocumentDeps, DocumentInfo } from "./document.ts";
import type { History } from "./history.ts";
import { makeHost, type EditorCalls } from "./host.ts";
import { namingFor, type Naming } from "./names.ts";
import { titleOf, type DocKind } from "./pages.ts";
import { FileStore, Room, StateStore, type StoreError } from "./room.ts";
import { fileStoreOf, RefIndex, stateStoreOf, TimeIndex } from "./storage.ts";
import { versionNumber } from "./versions.ts";

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
  /** What the operations call (host.ts). */
  calls: EditorCalls;
  /** A tab joins its person's event channel (`watch`: a watcher, hearing only what every tab does); returns the leave function. */
  addTab: (user: string, send: (msg: unknown) => void, watch?: boolean) => () => void;
  /** What a tab hears first ({ type: "hello" }): the document's details as the person sees them, and its tree. */
  hello: (person: Person, canEdit: boolean) => Promise<Hello>;
  room: Room;
  catchUp: () => Promise<void>;
  /** Tells every open tab the document's new title and address. */
  renamed: (name: DocName) => void;
  close: () => Promise<void>;
}

/** What opening the room needs of its document. */
export interface RoomHost {
  deps: DocumentDeps;
  /** What the document is, as it opens. */
  info: DocumentInfo;
  history: History;
  /** The document's owner as the directory has it (access.ts). */
  owner(): Promise<string | null>;
  /** Whether a person may edit, as the app said last: their agent may then too. */
  canEdit(personId: string): boolean;
  /** A file changed: the document has been edited. */
  touch(): Promise<void>;
  readInfo(): Promise<DocumentInfo | null>;
  /** Keeps the title and address the directory answered. */
  rememberName(name: DocName): Promise<DocName>;
  /** An agent's write of bytes (uploads.ts). */
  putFile(path: string, bytes: Uint8Array, by: string): Promise<{ kind: "text" | "file"; replaced: boolean }>;
  kind(): DocKind;
  setKind(kind: DocKind): Effect.Effect<void, StoreError>;
  /** An edit to the files reached the room, by `author` (null: unknown). */
  edited(author: string | null): void;
}

/** Opens the room on the document's storage, for as long as the document lives. */
export async function openRoom(h: RoomHost): Promise<Opened> {
  const { deps, info, history } = h;
  // A document on disk has its files there, and the rest of its storage here.
  const storage = info.disk && deps.disk ? deps.disk.storage(info.disk.only ? info.index : null) : deps.storage;
  // Its files that aren't text are blobs (none on disk: it keeps its own files there), and which those are, the file
  // store and the room's writes share.
  const blobs = info.disk ? undefined : deps.blobs;
  const refs = new RefIndex(storage),
    times = new TimeIndex(storage);
  const files = fileStoreOf(storage, { touch: () => h.touch() }, { blobs, refs, times });
  // Its history, with its files written in the same transaction (and its record, as touch notes the edit).
  // On disk the files change while it's closed, so it reads them all as it opens.
  const state = stateStoreOf(storage, { reconcile: !!info.disk, edited: () => h.touch(), blobs, refs, times });

  // The room's scope lasts until the document closes (idle, deleted, replaced): closing it writes what's left.
  const scope = Effect.runSync(Scope.make());
  const room = await Effect.runPromise(
    Room.make({ log: deps.log, writeDelay: deps.timing.writeDelay, fileDelay: deps.timing.fileDelay }).pipe(
      Effect.provideService(FileStore, files),
      Effect.provideService(StateStore, state),
      Scope.provide(scope)
    )
  ).catch(async (e) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw e;
  });
  const host = makeHost({
    room,
    files,
    docId: info.id,
    agents: deps.agents,
    // The render's token and pages origin name the owner the directory has: the host's info.owner can be an old one.
    ...(deps.render
      ? { render: async (job: RenderJob) => deps.render!({ ...job, owner: (await h.owner()) ?? info.owner, id: info.id }) }
      : {}),
    doc: { name: info.index, path: info.index, dir: info.disk?.path ?? info.owner },
    only: info.disk?.only ? info.index : undefined,
    personOf: (req) => personOf(new Headers(req.headers as Record<string, string>)),
    // The app sets x-erga-agent only on a request whose agent token it checked.
    // With x-erga-via, how the person acts through it: "a shared agent (label)".
    agentOf: (req) =>
      req.headers["x-erga-agent"]
        ? { ...personOf(new Headers(req.headers as Record<string, string>)), via: viaOf(req.headers["x-erga-via"]) }
        : null,
    // Their agent edits only if they may (and only while they may).
    canEdit: (person) => h.canEdit(person.id),
    mayPublish: (req) => req.headers["x-erga-access"] == "edit",
    avatarOf: deps.avatarOf,
    // Its title and address (the app decided who may rename it: rename_document).
    naming: () => naming,
    // An agent's turn is one version, and where its next diff_versions starts from ("last_turn").
    cutVersion: () =>
      history.cutSoon("agent turn").then(async (v) => (v ?? (await Effect.runPromise(history.versions.latest)))?.id ?? null),
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
    blobs,
    // An agent's write of bytes: as an upload is.
    putFile: (path, bytes, by) => h.putFile(path, bytes, by),
    kind: () => h.kind(),
    setKind: (kind) => h.setKind(kind),
  });
  // Every edit to the files, and who made it: a version is cut once a burst of them ends (History.noteEdit).
  room.doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (!touchesFiles(room.doc, tr)) return;
    const a = authorOf(room.doc, tr);
    h.edited(a ? (a.kind == "disk" ? (info.disk ? "on disk" : (room.by ?? "files published")) : editorOf(a)) : null);
  });
  // Its name from its record once the directory has said it; a rename goes to the directory, and what it answers is kept.
  const named = namingFor(deps.directory, info.id, () => titleOf(room.text(info.index) ?? ""));
  const remember = (name: DocName) => Effect.promise(() => h.rememberName(name));
  const naming: Naming = {
    get: () =>
      Effect.flatMap(
        Effect.promise(() => h.readInfo()),
        (i) => (i?.name ? Effect.succeed(i.name) : Effect.flatMap(named.get(), remember))
      ),
    set: (patch) => Effect.flatMap(named.set(patch), remember),
  };

  return {
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
        if (text != null) {
          out.set(path, encoder.encode(text));
          continue;
        }
        const ref = files.ref ? await Effect.runPromise(Effect.orElseSucceed(files.ref(path), () => null)) : null;
        const data = ref ?? (await Effect.runPromise(Effect.orElseSucceed(files.read(path), () => null)));
        if (data) out.set(path, data);
      }
      return out;
    },
    files,
    handler: host.handler,
    calls: host.calls,
    renamed: host.renamed,
    addTab: host.addTab,
    hello: host.hello,
    room,
    // Back in touch with disk: every file there, and every one the room holds, is looked at again.
    catchUp: async () => {
      const paths = new Set([...(await Effect.runPromise(files.list)), ...texts(room.doc).keys(), ...assets(room.doc).keys()]);
      for (const path of paths) await Effect.runPromise(room.fileChanged(path)).catch(() => {});
      await Effect.runPromise(room.syncFolders).catch(() => {});
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)).then(host.dispose),
  };
}

/** Whether a transaction changed a file: a text's content, or the list of files or other files (images). */
function touchesFiles(doc: Y.Doc, tr: Y.Transaction): boolean {
  const fileMap = texts(doc) as Y.AbstractType<any>,
    assetMap = assets(doc) as Y.AbstractType<any>,
    folderMap = folders(doc) as Y.AbstractType<any>;
  for (const type of tr.changed.keys()) {
    if (type === fileMap || type === assetMap || type === folderMap) return true;
    if (type._item?.parent === fileMap) return true;
  }
  return false;
}
