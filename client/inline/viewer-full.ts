// Full screen, from the button upper right, viewing and editing alike (server/pages/viewer.ts, client/editor.html): the
// page's frame fills the screen at its own layout, with nothing of Erga's over it but a presentation's controls
// (viewer-steps.ts). The keys go to the page (a deck's arrows). Escape (the browser's own), or the way out on those controls, leaves,
// and the page stays where it was, with the focus back where it was. It says so to the editor (client/shell/main.ts)
// with an "erga-full" event: { on }.
//
// What goes full screen is this page, with the frame over the rest of it (viewer.css, html.erga-full), not the frame
// itself: Chrome sends the clicks on anything over a frame that is itself full screen to the frame, and the controls must
// take theirs. Safari before 16.4 names it all webkit…; where a page can't go full screen (an iPhone), the button stays
// hidden (viewer.css: html.erga-can-full).

type Doc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
type Root = HTMLElement & { webkitRequestFullscreen?: () => void };

export default function viewerFull(): void {
  const d = document as Doc,
    root = document.documentElement as Root;
  if (!(d.fullscreenEnabled || d.webkitFullscreenEnabled)) return;
  root.classList.add("erga-can-full");
  const full = () => (d.fullscreenElement || d.webkitFullscreenElement) == root;
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
      if (d.exitFullscreen) d.exitFullscreen().catch(() => {});
      else d.webkitExitFullscreen?.();
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
    dispatchEvent(new CustomEvent("erga-full", { detail: { on } }));
  };
  document.addEventListener("fullscreenchange", changed);
  document.addEventListener("webkitfullscreenchange", changed);
}
