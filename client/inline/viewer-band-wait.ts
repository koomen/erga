// With no colour remembered for the document, its page waits out of sight until the band has its own (viewer-band.ts),
// half a second at most: a dark page never shows under a white band. (Unseen, not hidden: the editor may give it the
// focus.)

export default function viewerBandWait(): void {
  const root = document.documentElement;
  if (!root.style.getPropertyValue("--band")) {
    root.classList.add("erga-band-wait");
    setTimeout(() => root.classList.remove("erga-band-wait"), 500);
  }
}
