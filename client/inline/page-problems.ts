// Catches the page's script errors and files that fail to load, from before its first script, and tells the viewer
// each (erga-problem: client/shell/problems.ts says it in words). The viewer asks again for those it may have missed
// as it goes into the editor (its word, erga-mode). In a document's page, for whoever may edit (server/pages/reader.ts).

import type { RawProblem as Problem } from "../shell/problems";

export default function pageProblems(): void {
  const w = window;
  const all: Problem[] = [];
  // (The viewer's origin: the page's first script, before this one, has it.)
  const shell = (w as Window & { __ergaReader?: { config: { shell: string } } }).__ergaReader?.config.shell;
  const here = location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1);
  const tell = (p: Problem) => {
    if (shell && parent != window)
      try {
        parent.postMessage({ type: "erga-problem", problem: p, base: here }, shell);
      } catch {}
  };
  function r(p: Problem) {
    if (all.length < 100) all.push(p);
    tell(p);
  }
  addEventListener("message", (e) => {
    if (e.source == parent && e.origin == shell && e.data?.type == "erga-mode" && e.data.mode == "edit") all.forEach(tell);
  });
  addEventListener(
    "error",
    (e: ErrorEvent) => {
      const t = e.target as Element | Window | null;
      if (t && t !== window && (t as Element).tagName) {
        const el = t as Element,
          u = el.getAttribute("src") || el.getAttribute("href");
        if (u) r({ kind: "resource", tag: el.tagName.toLowerCase(), url: u });
      } else
        r({
          kind: "script",
          message: String(e.message || "Script error"),
          file: e.filename || "",
          line: e.lineno || 0,
          stack: String(e.error?.stack || ""),
        });
    },
    true
  );
  // A file that loads after all (it was on its way: an upload) is no problem any more. (On the document: an element's
  // load never comes to the window.)
  document.addEventListener(
    "load",
    (e) => {
      const el = e.target as Element | null,
        u = el?.getAttribute?.("src");
      if (!u) return;
      for (let i = all.length; i--; ) if (all[i].kind == "resource" && (all[i] as { url: string }).url == u) all.splice(i, 1);
    },
    true
  );
  addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    r({
      kind: "script",
      message: "Unhandled promise rejection: " + String((e.reason && e.reason.message) || e.reason),
      file: "",
      line: 0,
      stack: String((e.reason && e.reason.stack) || ""),
    });
  });
}
