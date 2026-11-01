// The agent's circle and panel (server/pages/agent.ts), after them: open as the person left it (erga:settings:v1, as in
// the editor), but closed on a phone, before the page paints; then its button, the round one, Esc in the panel and ⌘J
// open and close it. It grows out of its circle and shrinks back into it (client/style.css, .agent).

declare global {
  interface Window {
    ergaAgent?: { show(open: boolean): void; open(): boolean };
  }
}

export default function agentToggle(): void {
  const body = document.body,
    card = document.querySelector<HTMLElement>("#agent .agent-card")!,
    fab = document.getElementById("agent-fab")!;
  const narrow = matchMedia("(max-width: 759.98px)");
  const settings = (): Record<string, unknown> => {
    try {
      return JSON.parse(localStorage.getItem("erga:settings:v1") || "{}") ?? {};
    } catch {
      return {};
    }
  };
  const set = (open: boolean) => {
    body.classList.toggle("agent-open", open);
    card.inert = !open;
    fab.setAttribute("aria-expanded", String(open));
  };
  const show = (open: boolean) => {
    set(open);
    if (!narrow.matches)
      try {
        localStorage.setItem("erga:settings:v1", JSON.stringify({ ...settings(), agent: open }));
      } catch {}
    if (open) window.dispatchEvent(new Event("erga:agent-shown"));
    else fab.focus();
  };
  window.ergaAgent = { show, open: () => body.classList.contains("agent-open") };
  // Its first state, with no motion (a page that opens with it open shows it open).
  body.classList.add("no-motion");
  set(!narrow.matches && settings().agent !== false);
  requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove("no-motion")));
  document.getElementById("agent-close")!.addEventListener("click", () => show(false));
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
