// How a tab starts on its document, and what it says on its socket besides
// the room's Yjs messages and the person's events: shared by the host
// (document/host.ts, document/tabs.ts) and the browser (libs/text/ui/collab.ts).
//
// A tab starts with one request on the connection it has already (GET
// /d/<id>/api/start: its hello and the room's whole state, START below), and
// opens its socket (/d/<id>/api/room?events=1) at the same time; a new
// socket costs a connection of its own, so the editor doesn't wait for it.
// Once the state is in, the tab asks the socket for what changed since
// (sync step 1), and edits made meanwhile go over it as soon as it's open.

import { Encoder, Decoder } from "./yjs-protocol.ts";

/** A text frame a tab sends to see that its idle socket is alive; the host answers PONG (the Durable Object without waking: setWebSocketAutoResponse). */
export const PING = "ping", PONG = "pong";

/** What a page says once its document's socket closed with 4404: the document was deleted, and it never comes back. */
export const DELETED_NOTE = "This document was deleted.";

/** GET /api/start's answer: the hello (JSON), then the room's state (a Yjs update). */
export function encodeStart(hello: unknown, state: Uint8Array): Uint8Array {
  const e = new Encoder();
  e.writeString(JSON.stringify(hello));
  e.writeBytes(state);
  return e.toBytes();
}

export function decodeStart<H>(bytes: Uint8Array): { hello: H; state: Uint8Array } {
  const d = new Decoder(bytes);
  const hello = JSON.parse(d.readString()) as H;
  return { hello, state: d.readBytes() };
}

/**
 * A file on its way (a write that waits for its bytes: document/waits.ts), as an open tab hears it: its size, whose it
 * is (`via`: how they act, when through an agent: shared/attribution.ts), until when it waits (ms), and the bytes that
 * came (none yet: no `got`).
 */
export interface Pending {
  size: number;
  login: string;
  name: string;
  via?: string;
  until: number;
  got?: number;
}
/** What every open tab hears as the waits change: the files on their way, by path. */
export interface UploadsMessage {
  type: "uploads";
  files: Record<string, Pending>;
}
