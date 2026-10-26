// The admin agent's collapse and expand (server/admin/layout.ts): its button, the round one, Esc in the panel, ⌘J;
// remembered on a wide window. The panel's and the sidebar's toggles, Share and Copy act as the press starts
// (client/common/fast-click.ts), on every page admin-nav.js brings in too; Save, Clear, Remove and the rest keep a
// deliberate click.

import { fastClick } from "../common/fast-click";

declare global {
  interface Window {
    ergaAgent?: { show(open: boolean): void; set(open: boolean): void; open(): boolean };
  }
}

export default function adminAgent(): void {
  const root = document.documentElement,
    pane = document.getElementById("agent")!,
    fab = document.getElementById("agent-fab")!;
  const narrow = matchMedia("(max-width: 999.98px)");
  const sync = () => {
    const open = !root.classList.contains("agent-closed");
    pane.inert = !open;
    fab.setAttribute("aria-expanded", String(open));
  };
  const keep = (open: boolean) => {
    root.classList.toggle("agent-closed", !open);
    if (!narrow.matches)
      try {
        localStorage.setItem("erga:admin-agent", open ? "open" : "closed");
      } catch {}
    sync();
  };
  const show = (open: boolean) => {
    keep(open);
    // On a wide window the server keeps it too, for the admin's other browsers.
    if (!narrow.matches) window.dispatchEvent(new CustomEvent("erga:agent-toggled", { detail: { open } }));
    if (open) window.dispatchEvent(new Event("erga:agent-shown"));
    else fab.focus();
  };
  // set: as the server says the admin left it, on a wide window, without moving the focus.
  window.ergaAgent = {
    show,
    set: (open) => {
      if (!narrow.matches && open == root.classList.contains("agent-closed")) keep(open);
    },
    open: () => !root.classList.contains("agent-closed"),
  };
  document.getElementById("agent-close")!.addEventListener("click", () => show(false));
  fab.addEventListener("click", () => show(true));
  pane.addEventListener("keydown", (e) => {
    if (e.key == "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      show(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() == "j") {
      e.preventDefault();
      show(root.classList.contains("agent-closed"));
    }
  });
  sync();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("agent-ready")));
  fastClick(document, "#agent-fab, #agent-close, #side-toggle, #btn-share, button.copy");
}
