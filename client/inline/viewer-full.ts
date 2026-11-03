// Full screen, from the button upper right, viewing and editing alike (server/pages/viewer.ts, client/editor.html): the
// page's frame fills the screen at its own layout, with nothing of Erga's over it: a presentation draws its own controls
// in its page (libs/steps), which this tells when full screen is on ("erga-full": { on }), and whose way out asks this
// to leave. The keys go to the page (a deck's arrows). Escape (the browser's own), or that way out, leaves, and the page
// stays where it was, with the focus back where it was. It says so to the editor (client/shell/main.ts) with an
// "erga-full" event: { on }.
//
// And the arrows pressed here, outside the viewer's text, go to the page ("erga-arrow"): a presentation steps by them,
// whichever has the focus.
//
// What goes full screen is this page, with the frame over the rest of it (viewer.css, html.erga-full), not the frame
// itself: Chrome sends the clicks on anything over a frame that is itself full screen to the frame. Safari before 16.4
// names it all webkit…; where a page can't go full screen (an iPhone), the button stays hidden (viewer.css:
// html.erga-can-full).

type Doc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
type Root = HTMLElement & { webkitRequestFullscreen?: () => void };

export default function viewerFull(): void {
  const d = document as Doc,
    root = document.documentElement as Root;
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key != "ArrowLeft" && e.key != "ArrowRight")) return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.closest?.(".cm-editor"))) return;
    ergaFrames.send({ type: "erga-arrow", key: e.key });
  });
  if (!(d.fullscreenEnabled || d.webkitFullscreenEnabled)) return;
  root.classList.add("erga-can-full");
  const full = () => (d.fullscreenElement || d.webkitFullscreenElement) == root;
  const leave = () => {
    if (d.exitFullscreen) d.exitFullscreen().catch(() => {});
    else d.webkitExitFullscreen?.();
  };
  let back: Element | null = null;
  const button = (e: Event) => (e.target as Element | null)?.closest?.(".erga-full-button");
  // The button keeps the focus where it was: in the page, which has the keys at once.
  document.addEventListener(
    "mousedown",
    (e) => {
      if (button(e)) e.preventDefault();
    },
    true
  );
  document.addEventListener("click", (e) => {
    if (!button(e)) return;
    e.preventDefault();
    if (full()) {
      leave();
      return;
    }
    back = document.activeElement;
    if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else root.webkitRequestFullscreen?.();
  });
  const changed = () => {
    const on = full();
    if (on == root.classList.contains("erga-full")) return;
    root.classList.toggle("erga-full", on);
    if (on) ergaFrames.frame.focus();
    else if (back instanceof HTMLElement && back.isConnected && back != document.body) back.focus({ preventScroll: true });
    ergaFrames.send({ type: "erga-full", on });
    dispatchEvent(new CustomEvent("erga-full", { detail: { on } }));
  };
  // The page's controls: their way out, and their ask as they come (another page in the frame).
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e)) return;
    if (e.data?.type == "erga-full" && e.data.on === false && full()) leave();
    else if (e.data?.type == "erga-full-ask") ergaFrames.send({ type: "erga-full", on: full() });
  });
  document.addEventListener("fullscreenchange", changed);
  document.addEventListener("webkitfullscreenchange", changed);
}
