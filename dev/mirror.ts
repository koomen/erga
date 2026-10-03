// What goes over a linked document's /api/mirror WebSocket, between the
// document (worker/disk.ts) and the dev server (dev/plugin.ts), which has
// the files. The document asks for them as its room would ask a folder:
// list, read and write, each answered by a reply with the same id. The dev
// server says when a file changed on disk, so the room merges it in; and
// asks the room to write what it holds when it's about to stop.

export type ToDisk =
  | { t: "list"; id: number }
  | { t: "read"; id: number; path: string }
  | { t: "write"; id: number; path: string; text: string }
  | { t: "flushed" };

export type FromDisk =
  /** `paths` for a list; `b64` for a read (null: there's no such file); `error` if it failed. */
  | { t: "reply"; id: number; paths?: string[]; b64?: string | null; error?: string }
  | { t: "changed"; path: string }
  | { t: "flush" };
