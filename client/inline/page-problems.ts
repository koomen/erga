// Catches the page's script errors and files that fail to load, from before its first script, and hands them to the
// editor once it's there (window.__ergaReport: client/page-editor/render.ts, watchProblems). In a document's page, for
// whoever may edit (server/pages/reader.ts).

type Problem =
  | { kind: "resource"; tag: string; url: string }
  | { kind: "script"; message: string; file: string; line: number; stack?: string };
type ProblemWindow = Window & { __ergaProblems?: Problem[]; __ergaReport?: (p: Problem) => void };

export default function pageProblems(): void {
  const w = window as ProblemWindow;
  const q: Problem[] = (w.__ergaProblems = []);
  function r(p: Problem) {
    if (w.__ergaReport) w.__ergaReport(p);
    else q.push(p);
  }
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
