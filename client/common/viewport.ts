// Visual-viewport tracking for the on-screen keyboard across View mode, Edit mode, and app pages.
// Sets `--vv-top` (visual viewport pan offset), `--kb` (bottom obstruction below visual viewport), and
// `html.kb-open` so fixed panels (`.agent`, `.help`) shrink synchronously into the visible area above the
// keyboard instead of clipping off the top or getting occluded.

export interface ViewportMetrics {
  innerHeight: number;
  vvHeight: number;
  vvOffsetTop: number;
  vvScale: number;
}

export interface ViewportVars {
  /** Top offset of the visual viewport inside the layout viewport, in px (`--vv-top`). */
  vvTop: number;
  /** Bottom obstruction below the visual viewport, in px (`--kb`). */
  kb: number;
  /** Whether an on-screen keyboard is open (visual viewport significantly shorter than layout viewport). */
  kbOpen: boolean;
}

/**
 * Computes `--vv-top`, `--kb`, and `kbOpen` from layout + `visualViewport` geometry.
 * Zoomed in (`vvScale > 1.01`), the visual viewport is smaller for another reason: none of it is keyboard.
 */
export function viewportVars(m: ViewportMetrics): ViewportVars {
  if (!Number.isFinite(m.vvScale) || m.vvScale > 1.01) return { vvTop: 0, kb: 0, kbOpen: false };
  const vvTop = Math.max(0, Math.round(m.vvOffsetTop));
  const kb = Math.max(0, Math.round(m.innerHeight - m.vvHeight - m.vvOffsetTop));
  const kbOpen = m.innerHeight - m.vvHeight > 80;
  return { vvTop, kb, kbOpen };
}

/**
 * Watches `window.visualViewport` (idempotent across separate bundles on the same window) and keeps
 * `--vv-top`, `--kb`, and `html.kb-open` in sync on `<html>`.
 */
export function watchViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const g = window as Window & { __ergaViewportWatched?: boolean };
  if (g.__ergaViewportWatched) return;
  g.__ergaViewportWatched = true;
  const root = document.documentElement;
  const sync = () => {
    const { vvTop, kb, kbOpen } = viewportVars({
      innerHeight: window.innerHeight,
      vvHeight: vv.height,
      vvOffsetTop: vv.offsetTop,
      vvScale: vv.scale,
    });
    root.style.setProperty("--vv-top", `${vvTop}px`);
    root.style.setProperty("--kb", `${kb}px`);
    root.classList.toggle("kb-open", kbOpen);
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  sync();
}
