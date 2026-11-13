// What the other people get of an agent's edit, for the agent's journey: someone in the document's room with no browser
// (a Replica, e2e/helpers/room.ts) who notes each change by someone else, and a person's event channel.
import { authorOf } from "../../document/content";
import { until } from "../helpers/fixtures";
import { joinRoom as join } from "../helpers/room";

/** A change to the page's text by someone else, as this replica got it: who made it, and the text that it put in. */
export interface Seen {
  author: string | null;
  kind: string | null;
  inserted: string;
}

/** Joins the room of the document at `address` as `name` (local development's ?user=): `seen` has the others' changes from then on. */
export async function joinRoom(address: string, name: string) {
  const r = await join(address, name);
  const seen: Seen[] = [];
  r.text()!.observe((ev, tr) => {
    if (tr.origin === r.local) return;
    const a = authorOf(r.ydoc, tr);
    seen.push({
      author: a?.name ?? null,
      kind: a?.kind ?? null,
      inserted: ev.delta.map((op) => (typeof op.insert == "string" ? op.insert : "")).join(""),
    });
  });
  return Object.assign(r, { seen });
}
export type Joined = Awaited<ReturnType<typeof joinRoom>>;

/**
 * The document's events for `name`, as a tab of theirs gets them (the text frames of /api/room?events=1): all of them
 * so far as one text, a line each.
 */
export async function eventsOf(address: string, name: string) {
  let text = "";
  const ws = new WebSocket(`${address.replace(/^http/, "ws")}/api/room?events=1&user=${encodeURIComponent(name)}`);
  ws.onmessage = (e) => {
    if (typeof e.data == "string") text += `${e.data}\n`;
  };
  await until(() => ws.readyState == WebSocket.OPEN, 5000, `${name}'s event channel opens`);
  return { text: () => text, close: () => ws.close() };
}
