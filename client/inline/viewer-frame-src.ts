// The frame's address, opened with ?edit (its iframe has none until then: server/pages/viewer.ts): the editor's half
// starts loading with the page (?erga-edit, server/pages/reader.ts), and reloaded in the editor scrolled down the page,
// it opens where it was (?erga-y).

export default function viewerFrameSrc(): void {
  const f = document.getElementById("frame") as HTMLIFrameElement,
    kept = window.ergaRestored?.editor,
    y = kept?.mode == "text" ? Math.round(kept.scroll) : 0;
  f.src = f.dataset.src + "?erga-edit" + (y > 0 ? "&erga-y=" + y : "");
}
