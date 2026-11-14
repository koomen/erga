// The document's frame, for every script on a document's page (server/pages/viewer.ts): the frame (#frame, the page
// on its pages origin `pages`), the address of the page it shows, whether a message came from it, and sending to it. And the page's address with ?edit
// or without (ergaWithEdit, the rest of its query kept), and whether this one has it (ergaEditAddress).
//
// Trap: #frame is not one element for the tab's life. `reload` loads the page again in a new frame, which is #frame
// from that moment (every script talks to the new page), under the old one, which shows until the new page has the
// same view (client/common/frame-swap.ts). Code asks `ergaFrames.frame` each time, and keeps no copy of the element.

import { initial, step, WAIT_MS, type SwapEvent } from "../common/frame-swap";

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
    reload: (query) => {
      key = swap.n + "-" + Date.now().toString(36);
      act({ type: "reload", deep }, window.ergaFrames.src() + query + (query ? "&" : "?") + "erga-keep=" + key + location.hash);
    },
  };
  // The page loads again with its view kept (erga-keep: client/inline/reader.ts), as frame-swap.ts says.
  let swap = initial,
    // The page's frame has entries of its own in the tab's history, as the page says when it is up.
    deep = false,
    // The frame that still shows while the new one loads, and the new load's key, which its page says back.
    old: HTMLIFrameElement | null = null,
    key = "";
  function act(e: SwapEvent, url = "") {
    const next = step(swap, e);
    swap = next.state;
    for (const effect of next.effects) {
      const f = frame()!;
      if (effect == "replace") f.contentWindow!.location.replace(url);
      else if (effect == "wait") {
        const n = swap.n;
        setTimeout(() => act({ type: "timeout", n }), WAIT_MS);
      } else if (effect == "mount") {
        // The frame that shows stays where it is on the screen, without its id: the styles and the scripts have the new
        // one, in the same place under it, unseen (a page with no background would show through).
        const cs = getComputedStyle(f),
          to = f.cloneNode(false) as HTMLIFrameElement,
          px = (n: number) => n + "px",
          fixed = {
            position: "fixed",
            left: px(f.offsetLeft),
            top: px(f.offsetTop),
            width: px(f.offsetWidth),
            height: px(f.offsetHeight),
            border: "0",
            display: "block",
            transform: cs.transform,
            transformOrigin: cs.transformOrigin,
            clipPath: cs.clipPath,
            zIndex: cs.zIndex,
            visibility: cs.visibility,
            transition: "none",
          };
        Object.assign(f.style, fixed);
        f.removeAttribute("id");
        to.style.cssText = "opacity: 0";
        // (A page that says nothing, an error's, is up when its frame's load ends.)
        to.addEventListener("load", () => act({ type: "up", n: swap.n }));
        to.src = url;
        f.before(to);
        old = f;
      } else if (old) {
        const focused = document.activeElement == old;
        old.remove();
        old = null;
        f.style.opacity = "";
        if (focused) f.focus();
      }
    }
  }
  addEventListener("message", (e) => {
    if (!window.ergaFrames.from(e)) return;
    if (e.data?.type == "erga-hello") {
      deep = e.data.deep === true;
      // The new page is up: the keys are its own from now on, and the old page hands over what it holds (its editor's
      // keys typed meanwhile: libs/text/ui/frame.ts).
      if (!old) return;
      old.contentWindow?.postMessage({ type: "erga-leave" }, pages);
      if (document.activeElement == old) frame()!.focus();
      // (From now on the viewer's wait for its view runs: the old page, with its editor, stayed for as long as the load took.)
      act({ type: "up", n: swap.n });
    } else if (e.data?.type == "erga-placed" && e.data.keep === key) act({ type: "placed", n: swap.n });
  });
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
