// Pausing the page: a page that reacts to clicks and keys (slides that advance on click, a game) gets in the way of
// editing its text.

import { $, type Shell } from "./shell";

export function mountPause(shell: Shell) {

  // Pausing the page: a page that reacts to clicks and keys (slides that
  // advance on click, a game) gets in the way of editing its text. If it
  // defines window.ergaPause (agents/document/PROMPT.md, rule 10), the pause button
  // tells it to stop, and only the editor answers clicks until it resumes.
  // A page that can't be paused gets the button disabled, with a card that
  // offers to have the agent make it pausable.
  const PAUSE_FIX = "Make this page pausable in the editor, so people can edit its text without the page reacting to their clicks and keys. Follow the document rules: define window.ergaPause(paused), which the editor calls with true when someone pauses the page and false when they resume, and while it's paused have the page ignore clicks, keys and scrolling, and stop anything that changes the page on its own. If nothing on the page reacts to input, there's nothing to pause: say so rather than adding it.";
  /** Brings the button up to date with the page, which may have gained or lost window.ergaPause. */
  function syncPause() {
    const b = $("btn-pause"), can = shell.page.canPause;
    if (!can && shell.page.isPaused) shell.page.setPaused(false);
    const on = shell.page.isPaused;
    b.setAttribute("aria-disabled", String(!can));
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", !can ? "This page can't be paused" : on ? "Resume the page" : "Pause the page");
    // The disabled button explains itself with its card instead of a tooltip.
    if (can) b.dataset.tip = on ? "Paused: only the editor responds (click to resume)" : "Pause the page to edit it";
    else delete b.dataset.tip;
    if (can) showPauseCard(false);
  }
  let pauseCardTimer = 0;
  function showPauseCard(open: boolean) {
    clearTimeout(pauseCardTimer);
    const card = $("pause-card");
    if (open != (card.hidden == true)) return;
    card.hidden = !open;
    if (!open) return;
    shell.chrome.showChrome(); shell.chrome.toggleHelp(false); shell.sharing.toggleSharing(false);
    const fix = $("pause-fix");
    // aria-disabled, not disabled: it can still say why it can't.
    const off = window.ergaAgentPanel ? window.ergaAgentPanel.off : "Connecting to the agent…";
    fix.setAttribute("aria-disabled", String(!!off));
    fix.title = off ?? "";
  }
  // Hovering the disabled button opens the card; it stays while the pointer moves into it.
  // (A mouse only: a tap opens and closes it with the click below.)
  for (const el of [$("btn-pause"), $("pause-card")]) {
    el.addEventListener("pointerenter", (e) => { if (e.pointerType == "mouse") { syncPause(); if (!shell.page.canPause) showPauseCard(true); } });
    el.addEventListener("pointerleave", (e) => { if (e.pointerType == "mouse") { clearTimeout(pauseCardTimer); pauseCardTimer = window.setTimeout(() => showPauseCard(false), 300); } });
  }
  $("btn-pause").addEventListener("click", () => {
    syncPause();
    if (!shell.page.canPause) { showPauseCard($("pause-card").hidden == true); return; }
    shell.page.setPaused(!shell.page.isPaused);
    syncPause();
    shell.toast.flash(shell.page.isPaused ? "Paused: the page ignores clicks and keys while you edit" : "Resumed: the page responds again");
  });
  $("pause-fix").addEventListener("click", () => {
    const agent = window.ergaAgentPanel;
    if (!agent || agent.off) {
      shell.toast.explain(agent?.off ?? "Your agent isn't here yet: try again in a moment.");
      return;
    }
    showPauseCard(false);
    agent.ask(PAUSE_FIX, null);
  });
  syncPause();
  return { syncPause, showPauseCard };
}

export type Pause = ReturnType<typeof mountPause>;
