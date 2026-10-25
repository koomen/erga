// The admin agent's remembered state, set before it paints (server/admin/layout.ts): closed if this browser left it
// so, or on a narrow window.

export default function adminAgentEarly(): void {
  try {
    if (matchMedia("(max-width: 999.98px)").matches || localStorage.getItem("erga:admin-agent") == "closed")
      document.documentElement.classList.add("agent-closed");
  } catch {}
}
