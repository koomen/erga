// A picture marked data-erga-fallback in `root` (a document or a shadow root) that doesn't load goes, and the initial
// under it shows. (Not an onerror attribute: the site's pages run no inline handler, server/security.ts.)

export function imgFallback(root: Document | ShadowRoot | Element): void {
  for (const img of root.querySelectorAll<HTMLImageElement>("img[data-erga-fallback]")) if (img.complete && !img.naturalWidth) img.remove();
  root.addEventListener(
    "error",
    (e) => {
      const t = e.target as Element | null;
      if (t?.matches?.("img[data-erga-fallback]")) t.remove();
    },
    true
  );
}
