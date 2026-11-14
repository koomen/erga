// The frame's address: the page's place in the tab's address goes with it (#3: agents/document/PROMPT.md, rule 11), so
// a reload or a link opens the page there. Opened with ?edit (`editing`), the editor's half starts loading with the page
// (?erga-edit, server/pages/reader.ts). When the person loads the tab again, or comes back to it (Back), the page opens
// with the view it had (?erga-keep: client/inline/reader.ts kept it in this tab).

export default function viewerFrameSrc(editing: boolean): void {
  const f = document.getElementById("frame") as HTMLIFrameElement,
    how = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type,
    query = [...(editing ? ["erga-edit"] : []), ...(how == "reload" || how == "back_forward" ? ["erga-keep=tab"] : [])];
  f.src = window.ergaFrames.src() + (query.length ? "?" + query.join("&") : "") + location.hash;
}
