// The bench's participants: people with no browser (a Replica, e2e/helpers/room.ts) in a target's document, each with
// the target's sign-in on its socket. Many of them make a crowd.

import { files } from "../../../document/content";
import { until } from "../../helpers/fixtures";
import { Replica } from "../../helpers/room";
import type { Doc } from "./target";

export class Participant extends Replica {
  /** Joins the document's room, shown to the others as a tab's person is, and waits for the first sync. */
  static join(doc: Doc, name: string): Promise<Participant> {
    return new Participant(`${doc.roomUrl}/${doc.roomName}`, name, doc.path, doc.headersFor(name)).present().joined();
  }

  paths(): string[] {
    return [...files(this.ydoc).keys()].sort();
  }
}

/** Waits until every participant holds the same text for every file, and returns it. */
export async function converged(ps: Participant[], ms: number, what = "participants converging"): Promise<Record<string, string>> {
  const snap = (p: Participant) => Object.fromEntries(p.paths().map((k) => [k, p.str(k)]));
  await until(
    () => {
      const a = JSON.stringify(snap(ps[0]));
      return ps.every((p) => JSON.stringify(snap(p)) == a);
    },
    ms,
    what,
    () => ps.map((p) => ({ who: p.name, connected: p.connected, len: p.str().length, head: p.str().slice(0, 120) }))
  );
  return snap(ps[0]);
}
