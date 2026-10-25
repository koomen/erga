// The admin agent's side and width as this browser keeps them (client/layout.ts: PANE_KEY, paneWidth;
// tests/layout.test.ts checks the two agree), put on the workspace as it's parsed, before it paints: mountPaneLayout
// finds them so. It runs in a script inside the workspace (server/admin/layout.ts).

export default function adminPaneEarly(): void {
  try {
    const w = document.currentScript!.parentElement!,
      l = JSON.parse(localStorage.getItem("erga:factory-layout:v1") || "null");
    if (l && l.side == "right") w.classList.add("agent-right");
    if (l && typeof l.width == "number" && Number.isFinite(l.width))
      w.style.setProperty(
        "--agent-w",
        Math.min(Math.max(Math.round(l.width), 300), Math.max(300, Math.min(760, w.clientWidth - 20 - 480))) + "px"
      );
  } catch {}
}
