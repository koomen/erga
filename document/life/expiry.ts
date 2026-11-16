// When a document goes: its expiry, as one state and one pure step. document.ts
// reads the state from the document's record, calls `expiryStep` with what
// happened, writes the state back and does the effects it returns.

const HOUR = 60 * 60 * 1000;

/**
 * - `scratch`: it goes at its alarm, edited or not, unless someone saves it.
 * - `unedited`: it goes at its alarm, unless someone edits it first.
 * - `kept`: edited, saved, a test document or one on disk: it never goes by itself.
 * - `deleted`: it is going (the alarm decided, or its owner deleted it): nothing keeps it now.
 */
export type Expiry = "scratch" | "unedited" | "kept" | "deleted";

export type ExpiryEvent =
  | { type: "edit" }
  | { type: "save" }
  | { type: "delete" }
  /** Its alarm came: `tabs` open on it, `busy` requests and calls under way, the delete_docs_after_hours setting (null: never). */
  | { type: "alarm"; now: number; tabs: number; busy: number; setting: number | null };

export type ExpiryEffect =
  /** No alarm now: it stays. */
  | { type: "deleteAlarm" }
  /** The alarm comes again at `at`, and its row says so. */
  | { type: "alarmAt"; at: number }
  /** Its row says it never goes (the setting is never now); no alarm. */
  | { type: "neverExpires" }
  /** Its row says it is saved: on its owner's list, with no expiry. */
  | { type: "saved" }
  /** Delete it: storage, row, sockets. */
  | { type: "destroy"; why: string };

/** The state its record holds. */
export function expiryOf(info: { scratch?: true; modified?: number; test?: boolean; disk?: unknown }): Expiry {
  if (info.test || info.disk) return "kept";
  if (info.scratch) return "scratch";
  return info.modified ? "kept" : "unedited";
}

/** What a state becomes after an event, and what to do. Pure: the caller does the effects. */
export function expiryStep(state: Expiry, event: ExpiryEvent): { state: Expiry; effects: ExpiryEffect[] } {
  if (state == "deleted") return { state, effects: [] };
  switch (event.type) {
    case "edit":
      return state == "unedited" ? { state: "kept", effects: [{ type: "deleteAlarm" }] } : { state, effects: [] };
    case "save":
      // Saved again (its row may have missed the first time): the row hears it again.
      return state == "scratch"
        ? { state: "kept", effects: [{ type: "deleteAlarm" }, { type: "saved" }] }
        : { state, effects: state == "kept" ? [{ type: "saved" }] : [] };
    case "delete":
      return { state: "deleted", effects: [{ type: "destroy", why: "deleted by its owner" }] };
    case "alarm": {
      if (state == "kept") return { state, effects: [] };
      if (event.setting == null) return { state, effects: [{ type: "neverExpires" }] };
      if (state == "scratch") return { state: "deleted", effects: [{ type: "destroy", why: "scratch, not saved" }] };
      // Open somewhere, or an agent at work on it: an hour more, so it isn't pulled from under someone about to type.
      if (event.tabs > 0 || event.busy > 0) return { state, effects: [{ type: "alarmAt", at: event.now + HOUR }] };
      return { state: "deleted", effects: [{ type: "destroy", why: "never edited" }] };
    }
  }
}
