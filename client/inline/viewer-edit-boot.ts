// Going into the editor and back, on a document's page (server/pages/viewer.ts), for those who may: the pencil, the
// editor's eye, the browser's back and forward, or a page opened with ?edit. Only the address's ?edit changes
// (pushState), never the page. The first time, the editor's controls and styles (client/editor.html, in the page
// already) go on, its socket opens (ergaConnect) and its code loads (`scripts`: it and its first chunks), which takes
// the socket over; it loads the editor's half into the page in the frame, which stays as it is (client/remote.ts). The
// editor's controls fade in over the viewer's once it's ready (client/main.ts calls ergaShell.ready), and out again on
// the way back; the editor keeps running meanwhile (its half in the page stops), so going back in is immediate.
// Viewing, it fetches the editor's files while the browser is idle, so that first time is quick too. `built`: the
// editor's files this page uses that its elements don't name (client/live.ts compares them with the server's).

/** The editor, once it runs (client/main.ts, window.ergaPage): what this script asks of it. */
type Editor = { pagePath?: string; setEditing(on: boolean): void };

export default function viewerEditBoot(scripts: string[], built: Record<string, string>): void {
  const script = scripts[0];
  const body = document.body;
  const editor = () => window.ergaPage as Editor | undefined;
  let ready = false;
  // Reloaded in the editor, its controls are up already (viewer-editing-body.ts), shown as if it were ready (but inert) until it is.
  const restored = window.ergaRestored;
  if (restored) {
    // (The editor's code not there in a while: the viewer's controls, with the pencil waiting, as on any way in.)
    setTimeout(() => {
      if (!ready) {
        body.classList.remove("erga-restored", "no-motion");
        sync();
      }
    }, 8000);
  }
  const sync = () => {
    const wrap = document.getElementById("erga-editor");
    body.classList.toggle(
      "erga-editor-ready",
      ready || (!!restored && body.classList.contains("erga-restored") && body.classList.contains("erga-editing"))
    );
    if (wrap) wrap.inert = !(ready && body.classList.contains("erga-editing"));
  };
  // Viewing, its room is woken ahead (prefetch): asking for its details opens it.
  const base = document.querySelector<HTMLMetaElement>('meta[name="erga-base"]')!.content;
  const user = new URLSearchParams(location.search).get("user")?.trim();
  const wake = () =>
    fetch(base + "/api/doc" + (user ? "?user=" + encodeURIComponent(user) : "")).then(
      (r) => r.body?.cancel(),
      () => {}
    );
  // Into the editor: its socket (opening already, at ?edit), its styles and controls (in the page), then its code. (Each
  // time: each step finds what an earlier one made, and the browser runs a module once.)
  const load = () => {
    window.ergaBuilt = built;
    ergaConnect();
    for (const href of scripts.slice(1))
      document.head.append(Object.assign(document.createElement("link"), { rel: "modulepreload", href }));
    ergaShellStyle();
    body.append(ergaControls());
    sync();
    body.append(Object.assign(document.createElement("script"), { type: "module", src: script }));
  };
  // Editing, unless on the way out (erga-closing: the editor's own actions closing back into the pencil, client/editor.html).
  const editing = () => body.classList.contains("erga-editing") && !body.classList.contains("erga-closing");
  let closing = 0;
  function go(edit: boolean, push: boolean | null) {
    // The editor already running on another page (the viewer went to it since): that page's editor, loaded afresh.
    const page = editor()?.pagePath;
    if (edit && page != null && page != (document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content || page)) {
      history.replaceState(null, "", ergaWithEdit(ergaPageAddress(), true));
      location.reload();
      return;
    }
    if (push) history.pushState(null, "", ergaWithEdit(location.pathname == "/" ? "/" : ergaPageAddress(), edit));
    if (edit == editing() && push !== null) return;
    clearTimeout(closing);
    body.classList.remove("erga-closing");
    if (!edit && ready && body.classList.contains("erga-editing") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Out of the editor: its own actions close back into the pencil first (client/editor.html, .edit-group, 420ms), with the editor's
      // row still up; then the viewer's, the same buttons in the same places, takes over.
      body.classList.add("erga-closing");
      closing = window.setTimeout(() => {
        body.classList.remove("erga-closing", "erga-editing");
        sync();
      }, 420);
    } else body.classList.toggle("erga-editing", edit);
    document.querySelector(".erga-edit-button")?.setAttribute("aria-pressed", String(edit));
    editor()?.setEditing(edit);
    sync();
    if (edit) load();
  }
  // Whether the page was opened in the editor (with ?edit), rather than switched into it: client/main.ts restores
  // the agent as it was left only then, and otherwise opens it the way it does on any later switch.
  window.ergaShell = {
    ready() {
      ready = true;
      sync();
      // Its controls run now; what moves moves again from the next frame.
      requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove("erga-restored", "no-motion")));
    },
    loadedEditing: editing(),
  };
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.(".erga-edit-button, #btn-edit");
    if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(a.id != "btn-edit", true);
  });
  // Back and forward: editing follows the address.
  addEventListener("popstate", () => go(ergaEditAddress(), false));
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
  if (editing()) go(true, null);
  else {
    const idle = () => (window.requestIdleCallback ?? setTimeout)(prefetch);
    if (document.readyState == "complete") idle();
    else addEventListener("load", idle, { once: true });
  }
}
