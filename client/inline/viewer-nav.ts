// Which of the document's pages is shown, for everyone on a document's page (server/pages/viewer.ts): the frame says
// when the page in it goes to another of the document's pages (a link followed: server/pages/reader.ts), and the
// address bar follows, without a reload: /<owner>/<slug>/<page>, ?edit kept while editing. ergaPageAddress() is the
// page's address now. And a link that leaves the document, and the document's address, which the frame's copy needs.

export default function viewerNav(): void {
  const meta = (name: string) => document.querySelector<HTMLMetaElement>('meta[name="' + name + '"]');
  const suffix = (file: string) => {
    let s = file.replace(/\.html$/i, "");
    s = s == "index" ? "" : s.replace(/\/index$/, "");
    return s ? "/" + s.split("/").map(encodeURIComponent).join("/") : "";
  };
  window.ergaPageAddress = () => meta("erga-address")!.content + (meta("erga-page") ? suffix(meta("erga-page")!.content) : "");
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e) || e.data?.type != "erga-nav") return;
    // A page's path in the document; "" for the document's own.
    const path = e.data.path;
    if (
      typeof path != "string" ||
      (path && !/\.html$/i.test(path)) ||
      path.length > 1000 ||
      (path && path.split("/").some((p) => !p || p == ".." || p.startsWith(".")))
    )
      return;
    let m = meta("erga-page");
    if (!m) {
      m = document.head.appendChild(document.createElement("meta"));
      m.name = "erga-page";
      m.content = "";
    }
    if (m.content == path || (!path && !suffix(m.content))) return;
    m.content = path;
    // Viewing at the homepage's address (/), its first page stays there.
    if (location.pathname == "/" && !suffix(path)) return;
    const here = ergaPageAddress();
    if (location.pathname != here) history.replaceState(history.state, "", here + location.search + location.hash);
    document.querySelector(".erga-view-buttons a[aria-pressed]")?.setAttribute("href", ergaWithEdit(here, true));
  });
  // The page's place in its own address (#3: agents/document/PROMPT.md, rule 11): the tab's address keeps it too, so a
  // reload, or the link in another tab, opens the page there (viewer-frame-src.ts gives it to the frame).
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e) || e.data?.type != "erga-hash") return;
    const hash = e.data.hash;
    if (typeof hash != "string" || (hash && hash[0] != "#") || hash.length > 1000 || hash == location.hash) return;
    history.replaceState(history.state, "", location.pathname + location.search + hash);
  });
  // The page's script says it is up (reader.ts): it learns the document's public address, for the links in a copy.
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e) || e.data?.type != "erga-hello") return;
    ergaFrames.send({ type: "erga-address", address: location.origin + meta("erga-address")!.content });
  });
  // A link that leaves the document (reader.ts): a new tab (tab: "new"), or the whole tab when its author set it
  // to open in this one (target="_self"), on the reader's click only. (A tab the page opened itself would have its sandbox.)
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e) || e.data?.type != "erga-go") return;
    const url = String(e.data.url ?? "");
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (!/^https?:\/\//i.test(url) || url.length > 4000 || activation?.isActive === false) return;
    if (e.data.tab == "new") window.open(url, "_blank", "noopener,noreferrer");
    else location.assign(url);
  });
}
