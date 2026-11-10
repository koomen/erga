// Where a replica's first state comes from (collab.ts): one value, and one pure step from it. Three things can bring
// it: the start's answer (GET /api/start: the hello and the room's whole state), the socket's first sync, and, when the
// room can't be reached, what this browser kept (kept.ts). collab.ts keeps the value and does what each step says.
//
//   starting --started, with the state--> room
//   starting --started, with nothing--> empty --synced--> room
//   starting | empty --the socket failed, and this browser kept the replica--> kept --synced--> room
//   starting --synced--> starting, synced --started--> room

export type Replica =
  /** The start's answer isn't in. `synced`: the socket's sync brought the room's state already. `failed`: the socket failed meanwhile. */
  | { at: "starting"; synced: boolean; failed: boolean }
  /** The start brought nothing: the socket's sync must bring the state. `kept`: this browser kept the replica. */
  | { at: "empty"; kept: boolean; failed: boolean }
  /** It holds the room's state, with what this browser kept in it. */
  | { at: "room" }
  /** It holds what this browser kept: the room can't be reached yet. */
  | { at: "kept" };

export type ReplicaEvent =
  /** The start answered (`got`: with the hello and the state), and what this browser kept is read (`kept`: there is one). `connecting`: the socket isn't open now. */
  | { type: "started"; got: boolean; kept: boolean; connecting: boolean }
  /** The socket failed, and opens again later. */
  | { type: "failed" }
  /** The room answered this tab's first sync on a socket. */
  | { type: "synced" };

export type ReplicaDo =
  /** What this browser kept goes into the room's state: as it is, if it's of the same history; else as edits. */
  | "merge"
  /** The start's hello is the document's first. */
  | "greet"
  /** The replica opens from what this browser kept. */
  | "openKept"
  /** The first state is in: the editor can start. */
  | "ready"
  /** Ask the room what changed (once it has a state, on each socket). */
  | "ask";

export const STARTING: Replica = { at: "starting", synced: false, failed: false };

/** Whether the replica holds a state (the room's, or what this browser kept). */
export const holdsState = (r: Replica) => r.at == "room" || r.at == "kept" || (r.at == "starting" && r.synced);

export function replicaStep(r: Replica, e: ReplicaEvent): { state: Replica; effects: ReplicaDo[] } {
  const same = { state: r, effects: [] };
  switch (e.type) {
    case "started": {
      if (r.at != "starting") return same;
      const merge: ReplicaDo[] = e.kept ? ["merge"] : [];
      if (e.got) return { state: { at: "room" }, effects: [...merge, "greet", "ready", "ask"] };
      if (r.synced) return { state: { at: "room" }, effects: [...merge, "ask"] };
      // Nothing from the room, and the socket failed: the replica opens from what this browser kept.
      if (r.failed && e.kept && e.connecting) return { state: { at: "kept" }, effects: ["openKept", "ready"] };
      return { state: { at: "empty", kept: e.kept, failed: r.failed }, effects: ["ask"] };
    }
    case "failed":
      if (r.at == "starting") return r.synced ? same : { state: { ...r, failed: true }, effects: [] };
      if (r.at != "empty") return same;
      return r.kept ? { state: { at: "kept" }, effects: ["openKept", "ready"] } : { state: { ...r, failed: true }, effects: [] };
    case "synced":
      if (r.at == "starting") return { state: { ...r, synced: true }, effects: ["ready"] };
      if (r.at == "empty") return { state: { at: "room" }, effects: [...(r.kept ? (["merge"] as const) : []), "ready"] };
      return r.at == "kept" ? { state: { at: "room" }, effects: [] } : same;
  }
}

// The room confirms what this tab sent: this tab asks (a sync step 1 with what the room has not confirmed), and the
// room answers in order. One ask at a time; an edit made meanwhile asks once more after the answer.
//
//   closed --replied--> asked --answered--> idle --want--> asked
//   asked --want--> again --answered--> asked
//   any --closed--> closed

/** closed: the room's own step 1 is not answered on this socket. idle: no ask is out. asked: one is. again: one is, and another is wanted. */
export type Ack = "closed" | "idle" | "asked" | "again";

export type AckEvent =
  /** This tab answered the room's step 1 on this socket: it has sent all it holds. */
  | { type: "replied" }
  /** This tab changed the document. */
  | { type: "want" }
  /** The room answered a step 1 of this tab's. `ask`: one that asked for a confirmation. */
  | { type: "answered"; ask: boolean }
  /** The socket went. */
  | { type: "closed" };

/** `locked`: the room holds a lock, when it drops other tabs' edits: no ask goes out. */
export function ackStep(a: Ack, e: AckEvent, locked: boolean): { state: Ack; ask: boolean } {
  const ask = (): { state: Ack; ask: boolean } => (locked ? { state: "idle", ask: false } : { state: "asked", ask: true });
  const same = { state: a, ask: false };
  switch (e.type) {
    case "closed":
      return { state: "closed", ask: false };
    case "replied":
      return a == "closed" ? ask() : same;
    case "want":
      return a == "idle" ? ask() : a == "asked" ? { state: "again", ask: false } : same;
    case "answered":
      if (!e.ask) return same;
      return a == "again" ? ask() : a == "asked" ? { state: "idle", ask: false } : same;
  }
}
