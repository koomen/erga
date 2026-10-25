// The admin sidebar's toggle (server/admin/layout.ts): it collapses to a rail of icons and expands again, and this
// browser remembers which.

export default function adminSidebar(): void {
  const root = document.documentElement,
    toggle = document.getElementById("side-toggle")!;
  const sync = () => {
    const closed = root.classList.contains("side-closed");
    toggle.setAttribute("aria-expanded", String(!closed));
    toggle.setAttribute("aria-label", closed ? "Expand the sidebar" : "Collapse the sidebar");
    toggle.title = closed ? "Expand the sidebar" : "Collapse the sidebar";
    for (const a of document.querySelectorAll<HTMLElement>(".admin-side a")) a.title = closed ? a.textContent!.trim() : "";
  };
  toggle.addEventListener("click", () => {
    root.classList.toggle("side-closed");
    try {
      localStorage.setItem("erga:admin-sidebar", root.classList.contains("side-closed") ? "closed" : "open");
    } catch {}
    sync();
  });
  sync();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("side-ready")));
}
