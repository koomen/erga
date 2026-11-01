// The frame's address: the page's place in the tab's address goes with it (#3: agents/document/PROMPT.md, rule 14), so
// a reload or a link opens the page there. Opened with ?edit (`editing`), the editor's half starts loading with the page
// (?erga-edit, server/pages/reader.ts), and reloaded in the editor scrolled down the page, it opens where it was (?erga-y).

export default function viewerFrameSrc(editing: boolean): void {
  const f = document.getElementById("frame") as HTMLIFrameElement,
    kept = window.ergaRestored?.editor,
    y = editing && kept?.mode == "text" ? Math.round(kept.scroll) : 0;
  f.src = window.ergaFrames.src() + (editing ? "?erga-edit" + (y > 0 ? "&erga-y=" + y : "") : "") + location.hash;
}
