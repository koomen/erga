// The agent's circle and panel (server/pages/agent.ts), after them: open as the person left it (client/common/agent-panel.ts),
// but closed on a phone, before the page paints; then its button, the round one, Esc in the panel and ⌘J
// open and close it. It grows out of its circle and shrinks back into it (client/style.css, .agent).

import { restorePanel, savePanel, type Drawn } from "../common/agent-panel";

declare global {
  interface Window {
    ergaAgent?: { show(open: boolean): void; open(): boolean };
    /** On a document's page: the editor's layout put on again, for the agent open or closed (server/pages/viewer.ts). */
    ergaLayoutEarly?: () => void;
  }
}

/**
 * The panel as the tab's last page left it, drawn before this page paints: its conversation, its model and its scroll
 * place, if it was this person's. The agent's script then loads the conversation, and draws only what changed.
 */
function drawAsLeft(kept: Drawn | null) {
  try {
    if (!kept || kept.person != document.getElementById("agent")!.dataset.person) return;
    const log = document.getElementById("agent-log")!,
      model = document.getElementById("agent-model")!;
    log.innerHTML = kept.log;
    model.innerHTML = kept.model;
    if (kept.choice) model.querySelector("select")!.value = kept.choice;
    log.scrollTop = kept.bottom ? log.scrollHeight : kept.top;
  } catch {
    /* a copy from an older page */
  }
}

export default function agentToggle(): void {
  const body = document.body,
    card = document.querySelector<HTMLElement>("#agent .agent-card")!,
    fab = document.getElementById("agent-fab")!;
  const narrow = matchMedia("(max-width: 759.98px)");
  const set = (open: boolean) => {
    body.classList.toggle("agent-open", open);
    card.inert = !open;
    fab.setAttribute("aria-expanded", String(open));
  };
  const show = (open: boolean) => {
    set(open);
    if (!narrow.matches) {
      savePanel({ open });
      // The page and the bars slide over to make room, or back (the editor's layout keeps up by itself, once it runs).
      window.ergaLayoutEarly?.();
    }
    if (open) window.dispatchEvent(new Event("erga:agent-shown"));
    else fab.focus();
  };
  window.ergaAgent = { show, open: () => body.classList.contains("agent-open") };
  // Its first state, with no motion (a page that opens with it open shows it open).
  body.classList.add("no-motion");
  const kept = restorePanel();
  set(!narrow.matches && kept.open);
  // Shown from now (server/pages/agent.ts sends it hidden), and drawn before the browser paints again: never empty,
  // where the tab's last page left a conversation. (Shown first: a hidden log keeps no scroll place.)
  document.getElementById("agent")!.hidden = false;
  drawAsLeft(kept.drawn);
  requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove("no-motion")));
  // Collapsed with the mouse, focus goes back to the circle with no ring (Chrome would draw one, as focus comes from the
  // box); with the keyboard (Esc, ⌘J, Enter on the button), the ring shows. Tabbing away and back shows it again.
  document.getElementById("agent-close")!.addEventListener("click", (e) => {
    fab.classList.toggle("by-pointer", e.detail > 0);
    show(false);
  });
  fab.addEventListener("blur", () => fab.classList.remove("by-pointer"));
  fab.addEventListener("click", () => show(true));
  document.getElementById("agent")!.addEventListener("keydown", (e) => {
    if (e.key == "Escape" && !e.defaultPrevented && body.classList.contains("agent-open")) {
      e.preventDefault();
      show(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() == "j") {
      e.preventDefault();
      show(!body.classList.contains("agent-open"));
    }
  });
}
