// A keeper of a replica in this browser (kept.ts, keepReplica) holds one history: its epoch. Before each write it reads
// the record kept under its name, and writes only beside a record of its own epoch. Its first write replaces any other
// (a replica of an older history, or rows left with no record). After that, another epoch's record, or none (a tab took
// the replica to adopt it into a newer history: collab.ts, adopt), means this keeper's history is gone: it stops for good,
// so its rows never go under another history's record.

/** Before its first write; writing beside its own record; stopped for good. */
export type Keeping = "fresh" | "keeping" | "refused";
/** clear: delete the rows kept under the name. record: write the record of this epoch. add: add the new rows. */
export type KeepEffect = "clear" | "record" | "add";

/**
 * A write: `found` is the epoch of the record under the name (null: none), `base` whether this write brings the room's
 * texts (they go in the record).
 */
export function keepStep(state: Keeping, epoch: string, found: string | null, base: boolean): { state: Keeping; effects: KeepEffect[] } {
  if (state == "refused") return { state, effects: [] };
  if (state == "fresh") return { state: "keeping", effects: found == epoch ? ["record", "add"] : ["clear", "record", "add"] };
  if (found != epoch) return { state: "refused", effects: [] };
  return { state, effects: base ? ["record", "add"] : ["add"] };
}
