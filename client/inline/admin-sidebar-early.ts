// The admin sidebar's remembered state, set before it paints (server/admin/layout.ts).

export default function adminSidebarEarly(): void {
  try {
    if (localStorage.getItem("erga:admin-sidebar") == "closed") document.documentElement.classList.add("side-closed");
  } catch {}
}
