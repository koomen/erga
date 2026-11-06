// The viewer's way into the editor and back (client/inline/viewer-edit-boot.ts does what this says): one state, and what
// each event makes of it. The editor's code loads once, the first time in (`load`), and its socket opens with it; from
// then on it keeps running, hidden while viewing, so each later way in is immediate. No IO here.

/** Whether the editor's code runs: not asked for, on its way, or running (it called ergaShell.ready). */
export type Editor = "none" | "loading" | "ready";

export type EditState =
  | { phase: "viewing"; editor: Editor }
  /** On the way in, the editor's code on its way. `restored`: reloaded in the editor, its controls up as it kept them. */
  | { phase: "booting"; restored: boolean }
  | { phase: "editing" }
  /** On the way out: the editor's own actions close back into the pencil (420 ms), then the viewer's controls. */
  | { phase: "closing" }
  /** The editor's code didn't load: the viewer, with a note by the pencil; the pencil loads the page again to retry. */
  | { phase: "failed" };

export type EditEvent =
  /** The pencil, the eye, Back or Forward: editing on or off. `motion`: the way out may move (no reduced motion). */
  | { type: "edit"; on: boolean; motion: boolean }
  | { type: "ready" }
  | { type: "failed" }
  /** The way out's 420 ms are over. */
  | { type: "closed" }
  /** Reloaded in the editor, its code still not running after a while: the viewer's controls, the pencil waiting. */
  | { type: "restore-timeout" };

export type Effect =
  /** Loads the editor: its socket, its styles and controls, its code. Once for each page load. */
  | "load"
  /** Tells the running editor that editing is on, or off. */
  | "editor-on"
  | "editor-off"
  /** The viewer's breadcrumbs take the title the editor has (renamed there meanwhile). */
  | "take-title"
  | "close-later"
  | "cancel-close"
  /** Takes off the look kept from before a reload (erga-restored, no-motion). */
  | "unrestore"
  /** The address without ?edit: the viewer shows. */
  | "drop-edit"
  /** Loads the page again, at ?edit: a module that failed to load fails again in the same page. */
  | "retry";

export type Step = { state: EditState; effects: Effect[] };

/** The state as the page opens: at ?edit, on the way in at once. */
export function start(editing: boolean, restored: boolean): Step {
  return editing
    ? { state: { phase: "booting", restored }, effects: ["load"] }
    : { state: { phase: "viewing", editor: "none" }, effects: [] };
}

export function next(s: EditState, e: EditEvent): Step {
  const stay = { state: s, effects: [] };
  switch (s.phase) {
    case "viewing":
      if (e.type == "edit" && e.on) {
        if (s.editor == "ready") return { state: { phase: "editing" }, effects: ["editor-on"] };
        return { state: { phase: "booting", restored: false }, effects: s.editor == "none" ? ["load"] : [] };
      }
      if (s.editor == "loading" && e.type == "ready") return { state: { phase: "viewing", editor: "ready" }, effects: ["unrestore"] };
      if (s.editor == "loading" && e.type == "failed") return { state: { phase: "failed" }, effects: ["drop-edit"] };
      return stay;
    case "booting":
      if (e.type == "edit" && !e.on) return { state: { phase: "viewing", editor: "loading" }, effects: s.restored ? ["unrestore"] : [] };
      if (e.type == "ready") return { state: { phase: "editing" }, effects: ["unrestore"] };
      if (e.type == "failed") return { state: { phase: "failed" }, effects: ["unrestore", "drop-edit"] };
      if (e.type == "restore-timeout" && s.restored) return { state: { phase: "booting", restored: false }, effects: ["unrestore"] };
      return stay;
    case "editing":
      if (e.type == "edit" && !e.on)
        return e.motion
          ? { state: { phase: "closing" }, effects: ["take-title", "editor-off", "close-later"] }
          : { state: { phase: "viewing", editor: "ready" }, effects: ["take-title", "editor-off"] };
      return stay;
    case "closing":
      if (e.type == "edit" && e.on) return { state: { phase: "editing" }, effects: ["cancel-close", "editor-on"] };
      if (e.type == "closed") return { state: { phase: "viewing", editor: "ready" }, effects: [] };
      return stay;
    case "failed":
      if (e.type == "edit" && e.on) return { state: s, effects: ["retry"] };
      return stay;
  }
}

/** The page's classes, as the state has them (client/inline/viewer.css, client/styles/editor.css). */
export function looks(s: EditState) {
  const running = s.phase == "editing" || s.phase == "closing" || (s.phase == "viewing" && s.editor == "ready");
  return {
    /** Editing, or on the way in or out: the pencil pressed, the editor's controls placed. */
    editing: s.phase == "booting" || s.phase == "editing" || s.phase == "closing",
    closing: s.phase == "closing",
    /** The editor's controls show as ready: it runs, or a reload in the editor shows them as it kept them. */
    ready: running || (s.phase == "booting" && s.restored),
    /** The editor's controls take input. */
    live: s.phase == "editing" || s.phase == "closing",
    failed: s.phase == "failed",
  };
}
