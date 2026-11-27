// The viewer, live (server/pages/viewer.ts): the document's page shows each change while it's open, whoever makes it
// (an editor, their agent, an agent over the API). The page listens on the document's own socket as a watcher
// (<base>/api/room?watch=view: it never joins the room), which says the version viewers see now as it opens and as it
// changes (document/api/view.ts, at most every 2 s). A version other than the one shown loads the page again with its view
// kept (ergaFrames.reload: the old page shows until the new one has the same view). Not while the editor is open in this page, nor in
// a hidden tab: it catches up when it shows. A dropped socket comes back by itself, and hears the version first. A
// deleted document (4404), or one no longer theirs (4403), never comes back, and the page says so (shared/socket-phase.ts).
//
// Trap: an address that differs from the frame's only by its hash loads nothing: the browser moves the page to the
// hash. Someone who can edit has no version in the files' address, so the version goes in the query too (?erga-v).

import { liveSocket } from "../live/socket";
import { DELETED_NOTE } from "../../shared/room-socket";
import { normalizePagePath, scopeViewPaths } from "../common/live-scope";
import { DONE_MS, QUIET_MS, writerName, writerStep, writerText, type WriterEvent, type WriterPhase } from "../common/writer-phase";

export function viewerLive(base: string): void {
  // (The version is in a meta, not an argument: the page's build is its scripts, server/live.ts.)
  const ver = document.querySelector<HTMLMetaElement>('meta[name="erga-ver"]')!.content;
  const currentPage = () => normalizePagePath(document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content);
  let shown = ver,
    wanted = ver,
    // The files that changed since the version shown; null: not known (a version heard as the socket opened, or >100 files).
    changed: Set<string> | null = new Set(),
    pendingBy = "",
    asks = 0,
    last = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  // (erga-commenting: a commenter's page shows each change in place itself, client/viewer/comment.ts.)
  const editing = () => document.body.classList.contains("erga-editing") || document.body.classList.contains("erga-commenting");
  /** Updates the reader's versioned files prefix to `to` without reloading the frame. */
  function advanceVersion(to: string): HTMLMetaElement | null {
    shown = to;
    // A reader's files are at an address with the version in it (server/documents/view.ts): the new version's address.
    const pages = document.querySelector<HTMLMetaElement>('meta[name="erga-pages"]');
    if (pages) pages.content = pages.content.replace(/\/@[^/]+\/$/, "/@" + to + "/");
    return pages;
  }
  const noteWriter = (by: string) => {
    if (by && !editing()) writer({ type: "change", by: writerName(by.slice(0, 200)) });
  };
  /** Loads or restyles the version wanted if it affects this page: now, or once the last load is 2 s old. */
  function show() {
    if (wanted == shown || document.hidden || editing()) return;
    const scoped = scopeViewPaths(currentPage(), changed ? [...changed] : null);
    if (scoped.action == "skip") {
      changed = new Set();
      pendingBy = "";
      advanceVersion(wanted);
      return;
    }
    const wait = last + 2000 - Date.now();
    clearTimeout(timer);
    if (wait > 0) {
      timer = setTimeout(show, wait);
      return;
    }
    const targetVer = wanted;
    const by = pendingBy;
    pendingBy = "";
    changed = new Set();
    const pages = advanceVersion(targetVer);
    // With no new entry in the tab's history (Back would show the old version of the same page). ?erga-v: a new
    // address for each version (the trap above).
    const reload = () => {
      last = Date.now();
      noteWriter(by);
      ergaFrames.reload("?erga-v=" + targetVer);
    };
    if (scoped.action == "reload" || !pages) return reload();
    // Non-HTML files only: ask the page whether it uses any of them (skip unused, restyle CSS in place, or reload).
    const id = ++asks;
    const done = (result: "skip" | "restyled" | "reload") => {
      removeEventListener("message", heard);
      clearTimeout(late);
      if (result == "skip") return;
      last = Date.now();
      noteWriter(by);
      if (result == "reload") ergaFrames.reload("?erga-v=" + targetVer);
    };
    const heard = (e: MessageEvent) => {
      if (!ergaFrames.from(e) || e.data?.type != "erga-files-done" || e.data.id !== id) return;
      const r = e.data.result;
      done(r == "skip" || r == "restyled" ? r : "reload");
    };
    const late = setTimeout(() => done("reload"), 3000);
    addEventListener("message", heard);
    ergaFrames.send({ type: "erga-files", id, paths: scoped.paths, files: pages.content });
  }
  document.addEventListener("visibilitychange", show);
  // In-frame navigation loaded a fresh page from the server: drop pending paths from the previous page.
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e) || e.data?.type != "erga-nav") return;
    changed = new Set();
    pendingBy = "";
    shown = wanted;
  });
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
  const sock = liveSocket({
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
          if (m.ver != wanted) {
            const by = typeof m.by == "string" ? m.by : "";
            changed = changed && Array.isArray(m.paths) ? new Set([...changed, ...m.paths]) : null;
            // If this page's HTML was edited (or unknown diff), show the writer pill right away even during throttle waits.
            if (by && !document.hidden && scopeViewPaths(currentPage(), Array.isArray(m.paths) ? m.paths : null).action == "reload") {
              noteWriter(by);
              pendingBy = "";
            } else if (by) {
              pendingBy = by;
            }
          }
          wanted = m.ver;
          show();
        }
      } catch {
        /* not ours */
      }
    },
  });
  // While editing or commenting, the editor's own socket keeps the page live: close ?watch=view and reopen it on exit.
  let active = false;
  function sync() {
    const want = !editing();
    if (want == active) return;
    active = want;
    if (want) sock.start();
    else sock.stop();
  }
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  sync();
}
