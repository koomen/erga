// What an origin's storage says of its offline copies (client/common/offline.ts): someone is signed in and its writers
// keep the replicas and the page copies, or sign-out came and nothing goes in any more. The state is one mark in the
// origin's storage, which every writer reads: the pages, and Erga's worker after a restart too. A write that began
// before sign-out and lands after it is deleted at once (`undo`): sign-out's own delete may have come before it.

/** Signed in: the writers keep. Signed out: nothing goes in. */
export type Offline = "keeping" | "signed-out";
/** Sign-in or sign-out on this origin; a writer about to write (`write`), and one that just wrote (`wrote`). */
export type OfflineEvent = "sign-in" | "sign-out" | "write" | "wrote";
/**
 * mark, unmark: set or delete the "signed out" mark. clear: delete all this origin keeps (the replicas, the copy, the
 * worker). write: the writer writes. undo: the writer deletes what it just wrote.
 */
export type OfflineEffect = "mark" | "unmark" | "clear" | "write" | "undo";

export function offlineStep(state: Offline, event: OfflineEvent): { state: Offline; effects: OfflineEffect[] } {
  switch (event) {
    case "sign-in":
      return { state: "keeping", effects: state == "signed-out" ? ["unmark"] : [] };
    case "sign-out":
      // (The mark first: a writer that reads it after this never writes again.)
      return { state: "signed-out", effects: state == "keeping" ? ["mark", "clear"] : ["clear"] };
    case "write":
      return { state, effects: state == "keeping" ? ["write"] : [] };
    case "wrote":
      return { state, effects: state == "signed-out" ? ["undo"] : [] };
  }
}
