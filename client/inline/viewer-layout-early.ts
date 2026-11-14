// The editor's layout as this browser keeps it, put on the page as its body starts (opened with ?edit,
// viewer-editing-body.ts), so the first frame already has the document where it stays: the agent open or not
// (client/shell/main.ts, settings.agent), its side and width (client/agent/layout.ts: KEY, geometry, and mountLayout's variables;
// tests/layout.test.ts checks the two agree), and the document's zoom (client/shell/main.ts, ZOOM_KEY), which the frame takes
// (client/styles/editor.css, html.erga-zoomed).

import { clampZoom } from "../common/zoom";

type Item = "agent" | "doc";

export default function viewerLayoutEarly(): void {
  try {
    const root = document.documentElement,
      body = document.body;
    const get = (k: string) => {
      try {
        return JSON.parse(localStorage.getItem(k) || "null");
      } catch {
        return null;
      }
    };
    const s = get("erga:settings:v1"),
      l = get("erga:layout:v1"),
      items: Item[] = ["agent", "doc"];
    const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi),
      px = (n: number) => Math.round(n) + "px";
    const order: Item[] = l && Array.isArray(l.order) && l.order.length == 2 && items.every((i) => l.order.includes(i)) ? l.order : items;
    const kept = l && typeof l.agentWidth == "number" && Number.isFinite(l.agentWidth) ? clamp(Math.round(l.agentWidth), 300, 760) : 380;
    const right = order.indexOf("agent") > order.indexOf("doc");
    // (Before the app's stylesheet is in, which defines --safe-l and --safe-r: the same values.)
    const probe = document.createElement("div");
    probe.style.cssText =
      "position: fixed; visibility: hidden; padding-left: var(--safe-l, env(safe-area-inset-left, 0px)); padding-right: var(--safe-r, env(safe-area-inset-right, 0px))";
    body.append(probe);
    const cs = getComputedStyle(probe),
      sl = parseFloat(cs.paddingLeft) || 0,
      sr = parseFloat(cs.paddingRight) || 0,
      W = root.clientWidth || innerWidth;
    probe.remove();
    const narrow = W < 760;
    // (On a phone the agent starts closed: open, it covers the page.)
    const open = !(s && s.agent === false) && !narrow;
    const w = narrow ? Math.max(0, Math.min(kept, W - 32)) : clamp(kept, 300, Math.max(300, Math.min(760, W - sl - sr - 360 - 32)));
    // The agent's box, 16px from the window's edge on its side; open (and not on a phone), the document beside it.
    const agentX = right ? W - sr - 16 - w : sl + 16;
    const frameL = open && !right ? agentX + w + 16 : sl,
      frameR = open && right ? W - agentX + 16 : sr;
    const fab = right ? agentX + w - 44 : agentX;
    const vars: Record<string, number> = {
      "--agent-x": agentX,
      "--agent-w": w,
      "--fab-x": fab,
      "--frame-l": frameL,
      "--frame-r": frameR,
      "--cb-l": Math.max(frameL + 22, !open && !right ? fab + 44 + 14 : 0),
      "--cb-r": Math.max(frameR + 22, !open && right ? W - fab + 14 : 0),
    };
    for (const k in vars) root.style.setProperty(k, px(vars[k]));
    body.classList.toggle("agent-open", open);
    body.classList.toggle("agent-right", right);
    body.classList.toggle("layout-narrow", narrow);
  } catch {}
  try {
    // (Within the zoom's limits, whatever the browser kept.)
    const z = clampZoom(
      Number(localStorage.getItem("erga:zoom:v1:" + document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')!.content) || 1)
    );
    if (z != 1) {
      document.documentElement.style.setProperty("--erga-zoom", String(z));
      document.documentElement.classList.add("erga-zoomed");
    }
  } catch {}
}
