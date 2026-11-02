// The toast: a short confirmation, an explanation, or a problem with the page, with a way to have the agent fix it.

import { ms } from "../../libs/text/ui/timescale";
import { FIX_REPORTED, pageReport } from "../../shared/page-report";
import { editorContext } from "./agent-context";
import { $, type Shell } from "./shell";

export function mountToast(shell: Shell) {
  const toast = $("toast");
  let toastTimer = 0;
  let explaining = 0; // when an explanation went up, or 0
  /** A short confirmation ("Saved"): fades on its own. */
  function flash(text: string, duration = 1400) {
    explaining = 0;
    toast.classList.remove("actionable");
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), ms(duration));
  }
  // An explanation (why something can't be done, or what's wrong with the
  // page) is there to be read: it stays at least EXPLAIN_MS, then until the
  // next click or keypress anywhere. When the document is at fault it never
  // sends you off to fix it by hand: it offers a button that asks the agent
  // to, with a prompt that names the problem.
  const EXPLAIN_MS = ms(5000);
  const problemQueue: { text: string; fix?: string; key?: string }[] = [];
  function explain(text: string, fix?: string, key?: string) {
    clearTimeout(toastTimer);
    toast.textContent = "";
    toast.append(Object.assign(document.createElement("span"), { className: "toast-text", textContent: text }));
    toast.classList.toggle("actionable", !!fix);
    if (fix) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "toast-fix";
      b.textContent = "Fix with agent";
      b.addEventListener("click", () => {
        const agent = window.ergaAgentPanel;
        if (!agent || agent.off) {
          explain(agent?.off ?? "Your agent isn't here yet: try again in a moment.");
          return;
        }
        hideExplanation();
        // The page editor's report goes to your agent as data, in the page note (shared/page-report.ts).
        if (key) shell.room.shownProblems.delete(key);
        agent.ask(FIX_REPORTED, `${editorContext(shell)}\n${pageReport(fix)}`);
      });
      toast.append(b);
      syncFix();
    }
    // A problem nobody asked about closes at once (× or Escape), and doesn't come back in this page view (main.ts: shownProblems).
    if (key) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "toast-close";
      x.textContent = "×";
      x.title = "Close (Escape)";
      x.setAttribute("aria-label", "Close");
      x.addEventListener("click", () => hideExplanation());
      toast.append(x);
    }
    toast.classList.add("show");
    explaining = performance.now();
  }
  /**
   * The fix button as the agent stands: off, and why, until it's on. The agent's state comes after the page can
   * report a problem ("Connecting to the agent…" until then), so its arrival (client/agent/person-agent.ts sends
   * "erga:agent-state") updates a button already up.
   */
  window.addEventListener("erga:agent-state", () => syncFix());
  function syncFix() {
    const b = toast.querySelector<HTMLButtonElement>(".toast-fix");
    if (!b) return;
    const off = window.ergaAgentPanel ? window.ergaAgentPanel.off : "Connecting to the agent…";
    // aria-disabled, not disabled: it can still say why it can't.
    if (off) b.setAttribute("aria-disabled", "true");
    else b.removeAttribute("aria-disabled");
    b.title = off ?? "";
  }
  function hideExplanation() {
    explaining = 0;
    clearTimeout(toastTimer);
    // Only "show" goes: the note keeps its content and layout while it fades
    // (the next note replaces both), so nothing jumps on the way out.
    toast.classList.remove("show");
    // The next thing wrong with the page, if more than one thing is.
    const next = problemQueue.shift();
    if (next) toastTimer = window.setTimeout(() => explain(next.text, next.fix, next.key), 250);
  }
  function dismissExplanation(e: Event | null) {
    // (Escape closes a problem at once: closeProblem.)
    if (!explaining || (e && toast.contains(e.target as Node)) || (e as KeyboardEvent | null)?.key == "Escape") return;
    const left = EXPLAIN_MS - (performance.now() - explaining);
    clearTimeout(toastTimer);
    if (left > 0) { const shownAt = explaining; toastTimer = window.setTimeout(() => { if (explaining == shownAt) hideExplanation(); }, left); }
    else hideExplanation();
  }
  /** Closes the problem that's up, if one is (Escape); false if none is. */
  function closeProblem(): boolean {
    if (!explaining || !toast.querySelector(".toast-close")) return false;
    hideExplanation();
    return true;
  }
  /** Something wrong with the page that nobody asked about: shown in turn, never on top of another. */
  function reportProblem(text: string, fix: string, key: string) {
    if (explaining || toast.classList.contains("show")) problemQueue.push({ text, fix, key });
    else explain(text, fix, key);
  }
  // Capture phase, before whatever the click or key does (which may explain something new).
  for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, dismissExplanation, true);
  return {
    syncFix,
    flash,
    explain,
    hideExplanation,
    dismissExplanation,
    reportProblem,
    closeProblem,
    clearProblems() {
      problemQueue.length = 0;
      if (explaining) hideExplanation();
    },
  };
}

export type Toast = ReturnType<typeof mountToast>;
