// The editor in the page, as the shell decides it: one state, and `step`, the one function that says what the page is
// told (edit, with a key, or view) and when to ask the host for an edit key. The page's editor runs only while editing,
// on the page itself (not its source), out of full screen (there the page's own keys work: a deck's arrows). It opens its
// socket with an edit key (server/documents/edit-key.ts), which the shell asks for, and again before it ends.
// No IO here: client/shell/editor.ts does what `step` returns.
//
// Trap: the frame has its own history. Back after a link in the frame loads the frame's old address again, with its
// `?erga-edit` if the editor was on then, and that page asks for the editor by itself. Only this state decides
// "editing"; the frame's address never does.

/** The page itself, or the file's source (its HTML). */
export type Mode = "text" | "html";

/** A key the host gave, and when it ends (ms since the epoch). */
export interface Held {
  key: string;
  expires: number;
}

/**
 * The edit key. `held`: the last one the host gave, if any. The status: none asked for (idle), a request on its way
 * (asking), the host refused it (failed: a note says so, and the shell asks again after RETRY_MS), or no answer
 * (offline: the editor runs from its copy with what it has, and the shell asks again after RETRY_MS or once the room is back).
 */
export interface Key {
  status: "idle" | "asking" | "failed" | "offline";
  held: Held | null;
  /** The note says that the editor can't start. */
  noted: boolean;
}

/** What the page is told: view, or edit with a key ("" for none: the editor opens from its copy, offline). */
export type Word = { mode: "view" } | { mode: "edit"; key: string };

export interface EditorState {
  /** The editor's controls are up (the pencil; the eye ends it). */
  editing: boolean;
  /** The page itself, or its source. */
  view: Mode;
  /** The page is full screen. */
  full: boolean;
  key: Key;
  /** What the page was told last. */
  told: Word;
}

export type EditorEvent =
  | { type: "editing"; on: boolean }
  | { type: "view"; view: Mode }
  | { type: "full"; on: boolean }
  /** The host gave a key. */
  | { type: "key"; held: Held }
  /** The host answered, without a key. */
  | { type: "refused" }
  /** No answer from the host. */
  | { type: "unreachable" }
  /** RETRY_MS after a refusal or no answer. */
  | { type: "retry" }
  /** The room is back. */
  | { type: "online" }
  /** A look again (the first as the shell starts, then each minute): a key near its end is renewed. */
  | { type: "tick" };

export interface Effects {
  /** Tell the page this. */
  say?: Word;
  /** Ask the host for a key, and send "key", "refused" or "unreachable". */
  ask?: true;
  /** Send "retry" after this many ms. */
  retry?: number;
  /** The note: the editor can't start (failed), or it started after that (started). */
  note?: "failed" | "started";
}

/** A key is renewed this long before it ends; a request that failed is made again after RETRY_MS. */
export const RENEW_MS = 5 * 60_000,
  RETRY_MS = 5000;

export const initial = (editing: boolean, full: boolean, held: Held | null): EditorState => ({
  editing,
  view: "text",
  full,
  key: { status: "idle", held, noted: false },
  told: { mode: "view" },
});

/** The page's editor should run. */
export const runs = (s: EditorState) => s.editing && s.view == "text" && !s.full;

const usable = (held: Held | null, now: number) => !!held && held.expires > now;

/** What the page should be told now; null while its editor should run and waits for a key. */
function word(s: EditorState, now: number): Word | null {
  if (!runs(s)) return { mode: "view" };
  const held = s.key.held;
  if (held && usable(held, now)) return { mode: "edit", key: held.key };
  if (s.key.status == "offline") return { mode: "edit", key: held?.key ?? "" };
  return null;
}

export function step(s: EditorState, e: EditorEvent, now: number): { state: EditorState; effects: Effects } {
  const effects: Effects = {};
  let key = s.key;
  switch (e.type) {
    case "editing":
      s = { ...s, editing: e.on };
      break;
    case "view":
      s = { ...s, view: e.view };
      break;
    case "full":
      s = { ...s, full: e.on };
      break;
    case "key":
      if (key.noted) effects.note = "started";
      key = { status: "idle", held: e.held, noted: false };
      break;
    case "refused": {
      // (Only when the editor waits for it: one that holds still does, a while.)
      const noted = runs(s) && !usable(key.held, now);
      if (noted) effects.note = "failed";
      key = { status: "failed", held: key.held, noted: key.noted || noted };
      effects.retry = RETRY_MS;
      break;
    }
    case "unreachable":
      key = { ...key, status: "offline" };
      effects.retry = RETRY_MS;
      break;
    case "retry":
    case "online":
      if (key.status == "failed" || key.status == "offline") key = { ...key, status: "idle" };
      break;
    case "tick":
      break;
  }
  // Running, with no key that holds RENEW_MS more: a new one.
  if (runs(s) && key.status == "idle" && !(key.held && key.held.expires - now > RENEW_MS)) {
    key = { ...key, status: "asking" };
    effects.ask = true;
  }
  s = { ...s, key };
  const w = word(s, now);
  if (w && (w.mode != s.told.mode || (w.mode == "edit" && s.told.mode == "edit" && w.key != s.told.key))) {
    effects.say = w;
    s = { ...s, told: w };
  }
  return { state: s, effects };
}
