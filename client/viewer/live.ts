// The viewer, live (server/pages/viewer.ts): the document's page shows each change while it's open, whoever makes it
// (an editor, their agent, an agent over the API). The page listens on the document's own socket as a watcher
// (<base>/api/room?watch=view: it never joins the room), which says the version viewers see now as it opens and as it
// changes (document/api/view.ts, at most every 2 s). Unrelated pages and runtime-fetched data skip quietly; active-page
// text, DOM, and styles patch in place without reloading or showing a writer banner; only script/unpatchable changes
// reload the frame (ergaFrames.reload: the old page shows until the new one has the same view). Not while the editor is
// open in this page, nor in a hidden tab: it catches up when it shows, diffing per-file digests on reconnect so sibling
// edits still skip cleanly.
//
// Trap: an address that differs from the frame's only by its hash loads nothing: the browser moves the page to the
// hash. Someone who can edit has no version in the files' address, so the version goes in the query too (?erga-v).

import { liveSocket } from "../live/socket";
import { DELETED_NOTE } from "../../shared/room-socket";
import { diffDigests, normalizePagePath, scopeViewPaths } from "../common/live-scope";
import { DONE_MS, QUIET_MS, writerName, writerStep, writerText, type WriterEvent, type WriterPhase } from "../common/writer-phase";

export function viewerLive(base: string): void {
  // (The version is in a meta, not an argument: the page's build is its scripts, server/live.ts.)
  const ver = document.querySelector<HTMLMetaElement>('meta[name="erga-ver"]')!.content;
  const currentPage = () => normalizePagePath(document.querySelector<HTMLMetaElement>('meta[name="erga-page"]')?.content);
  let shown = ver,
    wanted = ver,
    // The files that changed since the version shown; null: not known (a greet without digests, or >100 files).
    changed: Set<string> | null = new Set(),
    // Content digests of the document's files at `wanted` (for exact diffing across reconnects / exiting Edit mode).
    lastDigests: Record<string, string> | null = null,
    pendingBy = "",
    asks = 0,
    last = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  // (erga-commenting: a commenter's page shows each change in place itself, client/viewer/comment.ts.)
  const editing = () => document.body.classList.contains("erga-editing") || document.body.classList.contains("erga-commenting");
  /** Updates the reader's versioned files prefix to `to` without reloading the frame. */
  function advanceVersion(to: string): HTMLMetaElement | null {
    shown = to;
    const pages = document.querySelector<HTMLMetaElement>('meta[name="erga-pages"]');
    if (pages) pages.content = pages.content.replace(/\/@[^/]+\/$/, "/@" + to + "/");
    return pages;
  }
  const noteWriter = (by: string) => {
    if (by && !editing()) writer({ type: "change", by: writerName(by.slice(0, 200)) });
  };
  /** Sends a request to the frame and waits for its matching response (fallback `"reload"` on timeout). */
  function askFrame<R extends string>(
    msg: Record<string, unknown>,
    replyType: string,
    valid: (r: unknown) => R | null
  ): Promise<R | "reload"> {
    const id = ++asks;
    return new Promise((resolve) => {
      const done = (result: R | "reload") => {
        removeEventListener("message", heard);
        clearTimeout(late);
        resolve(result);
      };
      const heard = (e: MessageEvent) => {
        if (!ergaFrames.from(e) || e.data?.type != replyType || e.data.id !== id) return;
        done(valid(e.data.result) ?? "reload");
      };
      const late = setTimeout(() => done("reload"), 3000);
      addEventListener("message", heard);
      ergaFrames.send({ ...msg, id });
    });
  }
  /** Loads, patches, or restyles the version wanted if it affects this page: now, or once the last reload is 2 s old. */
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
    const reload = () => {
      last = Date.now();
      noteWriter(by);
      ergaFrames.reload("?erga-v=" + targetVer);
    };
    if (scoped.action == "reload" || !pages) return reload();
    if (scoped.action == "check") {
      void askFrame({ type: "erga-files", paths: scoped.paths, files: pages.content }, "erga-files-done", (r) =>
        r === "skip" || r === "restyled" ? r : null
      ).then((result) => {
        if (result == "reload") reload();
      });
      return;
    }
    // Active page changed (with optional accompanying non-HTML assets): check assets and patch HTML in place.
    const page = currentPage();
    void Promise.all([
      askFrame({ type: "erga-patch", page, files: pages.content }, "erga-patch-done", (r) => (r === "patched" ? r : null)),
      scoped.assets.length
        ? askFrame({ type: "erga-files", paths: scoped.assets, files: pages.content }, "erga-files-done", (r) =>
            r === "skip" || r === "restyled" ? r : null
          )
        : Promise.resolve<"skip">("skip"),
    ]).then(([patchResult, assetResult]) => {
      if (patchResult == "reload" || assetResult == "reload") reload();
    });
  }
  document.addEventListener("visibilitychange", show);
  // In-frame navigation loaded a fresh page from the server: drop pending paths from the previous page.
  addEventListener("message", (e) => {
    if (!ergaFrames.from(e) || e.data?.type != "erga-nav") return;
    changed = new Set();
    pendingBy = "";
    shown = wanted;
  });
  // Who writes (shown only when a hard reload is required): a small pill at the top, then "Updated now", then gone.
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
        const m = JSON.parse(e.data) as {
          type?: string;
          ver?: string;
          by?: string;
          paths?: string[];
          digests?: Record<string, string | null>;
        };
        if (m.type == "view" && m.ver) {
          const fullDigests =
            !Array.isArray(m.paths) && m.digests && typeof m.digests == "object" ? (m.digests as Record<string, string>) : null;
          if (m.ver != wanted) {
            const by = typeof m.by == "string" ? m.by : "";
            const paths = Array.isArray(m.paths) ? m.paths : diffDigests(lastDigests, fullDigests);
            changed = changed && paths ? new Set([...changed, ...paths]) : null;
            if (by) pendingBy = by;
          }
          if (fullDigests) {
            lastDigests = { ...fullDigests };
          } else if (Array.isArray(m.paths) && m.digests && lastDigests) {
            for (const [p, d] of Object.entries(m.digests)) {
              if (d == null) delete lastDigests[p];
              else lastDigests[p] = d;
            }
          } else if (!Array.isArray(m.paths)) {
            lastDigests = null;
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
