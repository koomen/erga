// The document's frame, for every script on a document's page (server/pages/viewer.ts): the frame (#frame, the page
// on its pages origin `pages`), the address of the page it shows, whether a message came from it, and sending to it. And the page's address with ?edit
// or without (ergaWithEdit, the rest of its query kept), and whether this one has it (ergaEditAddress).

export default function viewerFrames(pages: string): void {
  const frame = () => document.getElementById("frame") as HTMLIFrameElement | null;
  window.ergaFrames = {
    pages,
    get frame() {
      return frame()!;
    },
    from: (e) => {
      const f = frame();
      return !!e.source && !!f && e.source == f.contentWindow && e.origin == pages;
    },
    send: (m) => {
      const f = frame(),
        w = f && f.contentWindow;
      if (w) w.postMessage(m, pages);
    },
    // The address of the page the frame shows: the document's files (meta erga-pages) and the page (meta erga-page,
    // which viewer-nav.ts moves as a link in the frame goes to another page).
    src: () => {
      const meta = (name: string) => document.querySelector<HTMLMetaElement>('meta[name="' + name + '"]')?.content ?? "";
      return meta("erga-pages") + meta("erga-page").split("/").map(encodeURIComponent).join("/");
    },
    scale: () => {
      const f = frame(),
        w = f && f.offsetWidth;
      return f && w ? f.getBoundingClientRect().width / w || 1 : 1;
    },
  };
  window.ergaEditAddress = () => /[?&]edit(=|&|$)/.test(location.search);
  window.ergaWithEdit = (path, on) => {
    const q = location.search
      .replace(/^\?/, "")
      .split("&")
      .filter((p) => p && !/^edit(=|$)/.test(p));
    if (on) q.push("edit");
    return path + (q.length ? "?" + q.join("&") : "");
  };
}
