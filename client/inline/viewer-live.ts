// The viewer, live (server/pages/viewer.ts): the document's page shows each change while it's open, whoever makes it
// (an editor, their agent, an agent over the API). The page listens on the document's own socket as a watcher
// (<base>/api/room?watch=view: it never joins the room), which says the version viewers see now as it opens and as it
// changes (document/view.ts, at most every 2 s). A version other than the one shown loads the page again with its view
// kept (ergaFrames.reload: the old page shows until the new one has the same view). Not while the editor is open in this page, nor in
// a hidden tab: it catches up when it shows. A dropped socket comes back by itself, and hears the version first. A
// deleted document (4404), or one no longer theirs (4403), never comes back, and the page says so (shared/socket-phase.ts).
//
// Trap: an address that differs from the frame's only by its hash loads nothing: the browser moves the page to the
// hash. Someone who can edit has no version in the files' address, so the version goes in the query too (?erga-v).

import { liveSocket } from "../live/socket";
import { DELETED_NOTE } from "../../shared/room-socket";
import { DONE_MS, QUIET_MS, writerName, writerStep, writerText, type WriterEvent, type WriterPhase } from "../common/writer-phase";

export default function viewerLive(base: string): void {
  // (The version is in a meta, not an argument: the page's build is its scripts, server/live.ts.)
  const ver = document.querySelector<HTMLMetaElement>('meta[name="erga-ver"]')!.content;
  let shown = ver,
    wanted = ver,
    // The files that changed since the version shown; null: not known (a version heard as the socket opened).
    changed: Set<string> | null = new Set(),
    asks = 0,
    last = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  // (erga-commenting: a commenter's page shows each change in place itself, viewer-comment.ts.)
  const editing = () => document.body.classList.contains("erga-editing") || document.body.classList.contains("erga-commenting");
  /** Loads the version wanted, if it isn't the one shown: now, or once the last load is 2 s old. */
  function show() {
    if (wanted == shown || document.hidden || editing()) return;
    const wait = last + 2000 - Date.now();
    clearTimeout(timer);
    if (wait > 0) {
      timer = setTimeout(show, wait);
      return;
    }
    last = Date.now();
    shown = wanted;
    // A reader's files are at an address with the version in it (server/documents/view.ts): the new version's address.
    const pages = document.querySelector<HTMLMetaElement>('meta[name="erga-pages"]');
    if (pages) pages.content = pages.content.replace(/\/@[^/]+\/$/, "/@" + wanted + "/");
    // With no new entry in the tab's history (Back would show the old version of the same page). ?erga-v: a new
    // address for each version (the trap above).
    const reload = () => window.ergaFrames.reload("?erga-v=" + shown);
    const paths = changed ? [...changed] : [];
    changed = new Set();
    // Stylesheets only: the page takes their new rules in place (client/inline/reader.ts, restyle), and keeps its view
    // and its scripts' state. If it can't, or doesn't answer, it loads again.
    if (!paths.length || !paths.every((p) => /\.css$/i.test(p)) || !pages) return reload();
    const id = ++asks;
    const done = (ok: boolean) => {
      removeEventListener("message", heard);
      clearTimeout(late);
      if (!ok) reload();
    };
    const heard = (e: MessageEvent) => {
      if (window.ergaFrames.from(e) && e.data?.type == "erga-restyled" && e.data.id === id) done(e.data.ok === true);
    };
    const late = setTimeout(() => done(false), 3000);
    addEventListener("message", heard);
    window.ergaFrames.send({ type: "erga-restyle", id, paths, files: pages.content });
  }
  document.addEventListener("visibilitychange", show);
  // Who writes (an experiment): a small pill at the top of the page while changes come, then "Updated now", then gone
  // (client/common/writer-phase.ts). Never over the text, which gets no highlight.
  let writing: WriterPhase = { at: "none" };
  function writer(e: WriterEvent) {
    const next = writerStep(writing, e);
    writing = next.phase;
    for (const f of next.effects) setTimeout(() => writer({ type: f.wait, n: f.n }), f.wait == "quiet" ? QUIET_MS : DONE_MS);
    let pill = document.getElementById("erga-writer");
    const text = writerText(writing);
    if (!pill && text) {
      pill = Object.assign(document.createElement("p"), { id: "erga-writer" });
      pill.setAttribute("role", "status");
      document.body.append(pill);
    }
    if (!pill) return;
    pill.hidden = !text;
    pill.textContent = text ?? "";
    pill.classList.toggle("on", writing.at == "writing");
  }
  liveSocket({
    name: "view",
    path: base + "/api/room?watch=view",
    // A deleted document, or one no longer theirs to open, never comes back.
    rules: { final: { 4404: "deleted", 4403: "unshared" } },
    ping: true,
    ended: (why) => (why == "deleted" ? DELETED_NOTE : "This document is no longer shared with you."),
    message(e) {
      if (typeof e.data != "string") return;
      try {
        const m = JSON.parse(e.data) as { type?: string; ver?: string; by?: string; paths?: string[] };
        if (m.type == "view" && m.ver) {
          // Someone changed it (not the version it hears as the socket opens): the pill says who writes.
          if (m.ver != wanted && typeof m.by == "string" && m.by && !editing())
            writer({ type: "change", by: writerName(m.by.slice(0, 200)) });
          if (m.ver != wanted) changed = changed && Array.isArray(m.paths) ? new Set([...changed, ...m.paths]) : null;
          wanted = m.ver;
          show();
        }
      } catch {
        /* not ours */
      }
    },
  }).start();
}
