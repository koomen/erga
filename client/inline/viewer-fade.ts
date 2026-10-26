// The fade (fade.ts) on a document's page (server/pages/viewer.ts): the page scrolls in the frame, on its own origin,
// so it says where it's scrolled to and where the pointer is over it (server/pages/reader.ts: erga-scroll,
// erga-pointer). The pointer over the band and the controls is this page's own.

import ergaFade from "../common/fade";

export default function viewerFade(): void {
  const fade = ergaFade(document.documentElement, document);
  addEventListener("message", (e) => {
    const m = e.data;
    if (!ergaFrames.from(e) || !m) return;
    if (m.type == "erga-scroll") fade.scroll(m.y);
    else if (m.type == "erga-pointer") {
      const r = ergaFrames.frame.getBoundingClientRect(),
        k = ergaFrames.scale();
      fade.pointer(Number(m.x) * k + r.left, Number(m.y) * k + r.top, m.tap === true);
    }
  });
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType == "mouse") fade.pointer(e.clientX, e.clientY, false);
    },
    { passive: true }
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType != "mouse") fade.pointer(e.clientX, e.clientY, true);
    },
    { passive: true }
  );
  // Out of the window (not into the frame, which then says where the pointer is).
  document.addEventListener("mouseout", (e) => {
    if (e.relatedTarget) return;
    const r = ergaFrames.frame.getBoundingClientRect();
    if (e.clientX > r.left + 1 && e.clientX < r.right - 1 && e.clientY > r.top + 1 && e.clientY < r.bottom - 1) return;
    fade.leave();
  });
}
