// Opening a document's room: the room on the document's storage (or, for a
// document on disk, on the folder there), with its participants in it
// (participants.ts), and what the document holds once it is open (Opened). Every edit to the
// files reaches the document (`edited`), with the name of who made it, from
// where the change came in. The document's host puts what serves the open
// document around it (document/api/host.ts).

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type * as Y from "yjs";
import { byLine, SYSTEM, type Act } from "../../shared/attribution.ts";
import type { Open } from "../history/history.ts";
import type { DocumentDeps, DocumentInfo } from "../life/document.ts";
import { assets, files as texts, folders } from "../model/content.ts";
import type { BlobRef } from "../store/blobs.ts";
import { fileStoreOf, FileStore, RefIndex, StateStore, stateStoreOf, TimeIndex } from "../store/storage.ts";
import type { Participants } from "./participants.ts";
import { Room } from "./room.ts";

/** The document once its room is open. */
export interface Opened extends Open {
  room: Room;
  /** Whoever is in the document (participants.ts). */
  participants: Participants;
  /** Its files' store (refs, blobs). */
  files: FileStore["Service"];
  /** Back in touch with disk: every file there, and every one the room holds, is looked at again. */
  catchUp(): Promise<void>;
  /** The participants' work stops (their sockets wait for the next open), and the room writes what is left. */
  close(): Promise<void>;
}

/** What opening the room needs of its document. */
export interface RoomHost {
  deps: DocumentDeps;
  /** What the document is, as it opens. */
  info: DocumentInfo;
  /** Whoever is in the document: they are of this room while it is open. */
  participants: Participants;
  /** A file changed: the document has been edited. */
  touch(): Promise<void>;
  /** An edit to the files reached the room, by `author` (its line: "ada", "ada, via their agent"): `paths`, the files it changed. */
  edited(author: string, paths: string[]): void;
}

/** Opens the room on the document's storage, for as long as the document stays open. */
export async function openRoom(h: RoomHost): Promise<Opened> {
  const { deps, info, participants } = h;
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
  participants.opened(room, info.disk?.only ? info.index : null);
  // Every edit to the files, and who made it: a version is cut once a burst of them ends (History.noteEdit).
  room.doc.on("afterTransaction", (tr: Y.Transaction) => {
    const paths = filesTouched(room.doc, tr);
    if (!paths) return;
    // Its name comes from where the change came in: a tab can't put another user's name on its edit.
    const by = room.madeBy(tr.origin);
    h.edited(by ? byLine(by.login, by.via) : by === null ? (info.disk ? "on disk" : "files uploaded") : byLine(SYSTEM), paths);
  });
  /** The participant that a call of the server's own names: it checked that they may edit. */
  const who = (by: Act) => participants.of({ id: by.login, name: by.login }, by.via, true);
  const paths = () => new Set([...texts(room.doc).keys(), ...assets(room.doc).keys()]);

  return {
    room,
    participants,
    files,
    // Every file as it is now: text from the room (the latest keystroke), the rest from storage.
    current: async () => {
      const out = new Map<string, Uint8Array>();
      const encoder = new TextEncoder();
      for (const path of paths()) {
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
      for (const path of paths()) {
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
    folders: () => room.folderPaths(),
    isFolder: (path) => room.exists(path) == "folder",
    removeFolder: (path, by) => room.remove(path, who(by)),
    makeFolder: (path, by) => room.mkdir(path, who(by)),
    settle: () => room.settle,
    catchUp: async () => {
      const all = new Set([...(await Effect.runPromise(files.list)), ...paths()]);
      for (const path of all) await Effect.runPromise(room.fileChanged(path)).catch(() => {});
      await Effect.runPromise(room.syncFolders).catch(() => {});
    },
    close: () => {
      participants.detach();
      return Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

/**
 * The files a transaction changed: each text whose content changed, and each file added, taken away or replaced
 * (texts and other files: images). Null if it changed none, nor the list of folders.
 */
function filesTouched(doc: Y.Doc, tr: Y.Transaction): string[] | null {
  const fileMap = texts(doc) as Y.AbstractType<any>,
    assetMap = assets(doc) as Y.AbstractType<any>,
    folderMap = folders(doc) as Y.AbstractType<any>;
  const paths = new Set<string>();
  let any = false;
  for (const [type, keys] of tr.changed) {
    const path = type._item?.parent === fileMap ? type._item.parentSub : null;
    if (type === fileMap || type === assetMap) for (const k of keys) if (k != null) paths.add(k);
    if (path) paths.add(path);
    any ||= type === fileMap || type === assetMap || type === folderMap || type._item?.parent === fileMap;
  }
  return any ? [...paths] : null;
}
