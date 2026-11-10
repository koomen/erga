// Going into the editor and back, on a document's page (server/pages/viewer.ts), for those who may: the pencil, ⌘⇧E, the
// editor's eye, the browser's back and forward, or a page opened with ?edit. Only the address's ?edit changes
// (pushState), never the page. client/common/edit-phase.ts decides; this script does what it says. The first time in,
// the editor's controls and styles (client/editor.html, in the page already) go on, its socket opens (ergaConnect) and
// its code loads (`scripts`: it and its first chunks), which takes the socket over; it loads the editor's half into the
// page in the frame, which stays as it is (client/shell/page-frame.ts). The editor's controls fade in over the viewer's
// once it's ready (client/shell/main.ts calls ergaShell.ready), and out again on the way back; the editor keeps running
// meanwhile (its half in the page stops), so going back in is immediate and connects nothing more.
// Viewing, it fetches the editor's files while the browser is idle, so that first time is quick too. `built`: the
// editor's files this page uses that its elements don't name (client/live/live.ts compares them with the server's).

import { type EditEvent, type Effect, looks, next, start } from "../common/edit-phase";

/** The editor, once it runs (client/shell/main.ts, window.ergaPage): what this script asks of it. */
type Editor = { pagePath: string; setEditing(on: boolean): void };

export default function viewerEditBoot(scripts: string[], built: Record<string, string>): void {
  const body = document.body;
  const editor = () => window.ergaPage as Editor | undefined;
  /** The page the viewer shows (viewer-nav.ts owns it). */
  const shown = () => document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content || "";
  // Viewing, its room is woken ahead (prefetch): asking for its details opens it.
  const base = document.querySelector<HTMLMetaElement>('meta[name="erga-base"]')!.content;
  const user = new URLSearchParams(location.search).get("user")?.trim();
  const wake = () =>
    fetch(base + "/api/doc" + (user ? "?user=" + encodeURIComponent(user) : "")).then(
      (r) => r.body?.cancel(),
      () => {}
    );
  // Into the editor, once: its socket (opening already, at ?edit), its styles and controls (in the page), then its code.
  const load = () => {
    window.ergaBuilt = built;
    ergaConnect();
    for (const href of scripts.slice(1))
      document.head.append(Object.assign(document.createElement("link"), { rel: "modulepreload", href }));
    ergaShellStyle();
    // (Made and put in the page the first time, then left in place: moved, its parts would start again, and the editor's
    // own actions would not open out of the pencil the next time in.)
    ergaControls();
    const script = Object.assign(document.createElement("script"), { type: "module", src: scripts[0] });
    script.onerror = () => dispatch({ type: "failed" });
    body.append(script);
  };
  let closing = 0;
  const run: Record<Effect, () => void> = {
    load,
    "editor-on": () => editor()?.setEditing(true),
    "editor-off": () => editor()?.setEditing(false),
    // Out: the title as the editor has it (renamed there meanwhile), so the viewer's breadcrumbs take over unmoved.
    "take-title": () => {
      const title = document.getElementById("doc-title-text")?.textContent;
      const here = document.querySelector(".erga-crumbs .erga-here > span");
      if (title && here) here.textContent = title;
    },
    // Out of the editor: its own actions close back into the pencil first (client/styles/editor.css, .edit-group, 420ms),
    // with the editor's row still up; then the viewer's, the same buttons in the same places, takes over.
    "close-later": () => {
      closing = window.setTimeout(() => dispatch({ type: "closed" }), 420);
    },
    "cancel-close": () => clearTimeout(closing),
    // Its controls run now; what moves moves again from the next frame.
    unrestore: () => requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove("erga-restored", "no-motion"))),
    "drop-edit": () => history.replaceState(history.state, "", ergaWithEdit(location.pathname, false) + location.hash),
    // (The address has ?edit already: the pencil's entry, or Back's. A reload, as going to the same address with a hash
    // in it loads nothing.)
    retry: () => location.reload(),
  };
  let state = start(body.classList.contains("erga-editing"), !!window.ergaRestored);
  function render() {
    const l = looks(state.state);
    body.classList.toggle("erga-editing", l.editing);
    body.classList.toggle("erga-closing", l.closing);
    body.classList.toggle("erga-editor-ready", l.ready);
    const wrap = document.getElementById("erga-editor");
    if (wrap) wrap.inert = !l.live;
    // The pencil is one button, viewing and editing: blue while editing, when it goes back to the page.
    const pencil = document.querySelector<HTMLAnchorElement>(".erga-edit-button");
    const on = l.editing && !l.closing;
    pencil?.setAttribute("aria-pressed", String(on));
    pencil?.setAttribute("aria-label", on ? "Editing: stop, and view the page" : "Edit");
    // Its address, for a new tab: the page in the viewer while editing, else its editor.
    if (pencil) pencil.setAttribute("href", ergaWithEdit(new URL(pencil.href).pathname, !on));
    let note = document.querySelector(".erga-edit-failed");
    if (l.failed && !note) {
      note = Object.assign(document.createElement("p"), {
        className: "erga-edit-failed",
        textContent: "The editor didn't load. Click the pencil to try again.",
      });
      note.setAttribute("role", "alert");
      body.append(note);
    } else if (!l.failed) note?.remove();
  }
  function dispatch(e: EditEvent) {
    state = next(state.state, e);
    render();
    for (const effect of state.effects) run[effect]();
  }
  const edit = (on: boolean) => dispatch({ type: "edit", on, motion: !matchMedia("(prefers-reduced-motion: reduce)").matches });
  window.ergaShell = { ready: () => dispatch({ type: "ready" }) };
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.(".erga-edit-button");
    if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    // Into the editor, or (editing, and not on the way out already) out of it.
    const on = !(looks(state.state).editing && !looks(state.state).closing);
    // A new entry, for the page shown (the page's place in its address, #3, stays: it is the same page).
    const page = shown() || editor()?.pagePath;
    history.pushState(
      { ...history.state, ergaPage: page || undefined },
      "",
      ergaWithEdit(location.pathname == "/" ? "/" : ergaPageAddress(), on) + location.hash
    );
    // The editor running on another page (the viewer went to it since): that page's editor, loaded afresh.
    const at = editor()?.pagePath;
    if (on && at != null && page && page != at) location.reload();
    else edit(on);
  });
  // ⌘⇧E (Ctrl+Shift+E off a Mac) opens and closes the editor, as a click on the pencil does: pressed here, or in the page
  // (its first script says so: client/inline/reader.ts).
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const pencil = () => {
    const on = looks(state.state).editing && !looks(state.state).closing;
    document.querySelector<HTMLElement>(on ? "#btn-edit" : ".erga-edit-button")?.click();
  };
  addEventListener("keydown", (e) => {
    if (!(mac ? e.metaKey : e.ctrlKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() != "e" || e.isComposing) return;
    e.preventDefault();
    pencil();
  });
  addEventListener("message", (e) => {
    if (ergaFrames.from(e) && e.data?.type == "erga-edit-key") pencil();
  });
  // Back and forward: editing follows the address. The entry's page is the editor's to open, in place (client/shell/main.ts,
  // popstate: it reads the entry's ergaPage), never the page shown, which the frame's own history may not have brought back yet.
  addEventListener("popstate", () => edit(ergaEditAddress()));
  // Viewing, the editor's files are fetched ahead, at low priority, and its room woken (its details asked for): sooner when the
  // pointer or focus comes to the pencil, else once the document has loaded (its frame and everything in it) and the browser is
  // idle, so it never competes with the document itself. The page fetches its half of the editor ahead too.
  let fetched = false;
  const prefetch = () => {
    if (fetched) return;
    fetched = true;
    for (const href of scripts) document.head.append(Object.assign(document.createElement("link"), { rel: "prefetch", href }));
    ergaFrames.send({ type: "erga-prefetch" });
    wake();
  };
  for (const type of ["pointerover", "focusin"])
    document.addEventListener(type, (e) => {
      if ((e.target as Element | null)?.closest?.(".erga-edit-button")) prefetch();
    });
  render();
  for (const effect of state.effects) run[effect]();
  // Reloaded in the editor, its controls are up already (viewer-editing-body.ts), shown as if it were ready (but inert)
  // until it is; its code not there in a while, the viewer's controls, with the pencil waiting, as on any way in.
  if (window.ergaRestored) setTimeout(() => dispatch({ type: "restore-timeout" }), 8000);
  if (state.state.phase == "viewing") {
    const idle = () => (window.requestIdleCallback ?? setTimeout)(prefetch);
    if (document.readyState == "complete") idle();
    else addEventListener("load", idle, { once: true });
  }
}
