// The document's frame, for every script on a document's page (server/pages/viewer.ts): the frame (#frame, the page
// on its pages origin `pages`), whether a message came from it, and sending to it. And the page's address with ?edit
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
