// What goes over a linked document's /api/mirror WebSocket, between the
// document and the dev server, which has
// the files. The document asks for them as its room would ask a folder:
// list, read and write (and the tree's: remove, folders, mkdir, rmdir), each answered by a reply with the same id. The dev
// server says when a file changed on disk, so the room merges it in; and
// asks the room to write what it holds when it's about to stop.

export type ToDisk =
  | { t: "list"; id: number }
  | { t: "read"; id: number; path: string }
  /** `text`, or `b64` for a file that isn't text (one moved elsewhere). */
  | { t: "write"; id: number; path: string; text?: string; b64?: string }
  | { t: "remove"; id: number; path: string }
  /** Every folder (`dirs` in the reply), empty ones included. */
  | { t: "folders"; id: number }
  | { t: "mkdir"; id: number; path: string }
  /** A folder and whatever is still in it. */
  | { t: "rmdir"; id: number; path: string }
  | { t: "flushed" };

export type FromDisk =
  /** `paths` for a list; `b64` for a read (null: there's no such file); `error` if it failed. */
  | { t: "reply"; id: number; paths?: string[]; dirs?: string[]; b64?: string | null; error?: string }
  | { t: "changed"; path: string }
  | { t: "flush" };
