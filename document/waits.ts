// A write that waits for its bytes: how an agent adds a file from its own disk without the bytes in its
// conversation. Its write names the file by the sha-256 and the size of its bytes ({"blob", "size"}:
// server/operations/documents.ts); where Erga keeps no such bytes, the document keeps the wait, and the bytes come
// after, in a plain PUT (uploads.ts, arrive). Each path's wait is a state machine:
//
//   none     --write-->  waiting   (the path, the bytes' sha-256 and size, who wrote, the server, when it ends)
//   waiting  --write-->  waiting   (the newer write's)
//   waiting  --bytes-->  none      (effect: put the file, as who wrote it)
//   waiting  --remove-->  none      (the person or the agent took it back: a cancel)
//   waiting  --time--->  none      (past `until`: every event drops those)
//
// A person's drop in the editor waits the same way (client/shell/uploads.ts): the write, then the bytes. Every open tab
// hears the files that wait and how many bytes each has ({ type: "uploads" }: `pendingOf`), and shows them as on their way.
//
// Trap: a wait is no credential, and must never become one. The PUT's address holds no secret: whoever sends it does
// only what the write said (these bytes, at this path), so a wait names the bytes' hash and size, and uploads.ts
// takes no others. Never add a wait that takes bytes it can't check.

import type { Asker } from "./access.ts";
import type { UploadsMessage } from "../shared/room-socket.ts";

/** How long a write waits for its bytes. */
export const WAIT_MINUTES = 15;

/** The answer to bytes that no write waits for: the same for a document that isn't there, so it tells nothing of one. */
export const NO_WAIT = `No write waits for these bytes here. Write the file first, as {"blob": "<its sha-256>", "size": <its bytes>}: a write waits ${WAIT_MINUTES} minutes.`;

/** Who wrote: as the document asks what they may do when the bytes come, their name, and the server they wrote on. */
export interface Writer {
  /** The directory's Who (how they act, `via`, too). */
  who: Asker & { via?: string };
  name: string;
  /** The server's origin: a copy of the document on another server (staging's) takes no bytes for it. */
  origin: string;
}

/** One path's wait. */
export interface Wait extends Writer {
  hash: string;
  size: number;
  /** When it ends (ms). */
  until: number;
}

/** The waits, by path. */
export type Waits = Readonly<Record<string, Wait>>;

export type WaitEvent =
  | { on: "write"; files: Readonly<Record<string, { hash: string; size: number }>>; by: Writer; now: number }
  | { on: "bytes"; hash: string; origin: string; now: number }
  | { on: "remove"; path: string; now: number };

/** The files on their way now; `got`: the bytes that came of a hash, so far. */
export const pendingOf = (waits: Waits, now: number, got: (hash: string) => number | undefined = () => undefined): UploadsMessage => ({
  type: "uploads",
  files: Object.fromEntries(
    Object.entries(waits)
      .filter(([, w]) => w.until > now)
      .map(([path, w]) => {
        const n = got(w.hash);
        return [
          path,
          {
            size: w.size,
            login: w.who.login,
            name: w.name,
            ...(w.who.via ? { via: w.who.via } : {}),
            until: w.until,
            ...(n == null ? {} : { got: n }),
          },
        ];
      })
  ),
});

/** The waits for the bytes `hash` on the server `origin`, now. */
export const waitingFor = (waits: Waits, hash: string, origin: string, now: number): [string, Wait][] =>
  Object.entries(waits).filter(([, w]) => w.hash == hash && w.origin == origin && w.until > now);

/** The waits after `event`, and the files to put (the bytes came). */
export function step(waits: Waits, event: WaitEvent): { waits: Waits; put: [string, Wait][] } {
  const current = Object.fromEntries(Object.entries(waits).filter(([, w]) => w.until > event.now));
  if (event.on == "write") {
    const until = event.now + WAIT_MINUTES * 60_000;
    for (const [path, { hash, size }] of Object.entries(event.files)) current[path] = { ...event.by, hash, size, until };
    return { waits: current, put: [] };
  }
  if (event.on == "remove") {
    delete current[event.path];
    return { waits: current, put: [] };
  }
  const put = waitingFor(current, event.hash, event.origin, event.now);
  for (const [path] of put) delete current[path];
  return { waits: current, put };
}
