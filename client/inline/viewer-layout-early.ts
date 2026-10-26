// The editor's layout as this browser keeps it, put on the page as its body starts (opened with ?edit,
// viewer-editing-body.ts), so the first frame already has the document where it stays: the agent open or not
// (client/shell/main.ts, settings.agent), its side and width (client/agent/layout.ts: KEY, geometry, and mountLayout's variables;
// tests/layout.test.ts checks the two agree), and the document's zoom (client/shell/main.ts, ZOOM_KEY), which the frame takes
// (client/editor.html, html.erga-zoomed). The steps list isn't known yet: it takes no room.

type Panel = "agent" | "doc" | "picker";

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
      items: Panel[] = ["agent", "doc", "picker"];
    const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi),
      px = (n: number) => Math.round(n) + "px";
    const order: Panel[] = l && Array.isArray(l.order) && l.order.length == 3 && items.every((i) => l.order.includes(i)) ? l.order : items;
    const kept = l && typeof l.agentWidth == "number" && Number.isFinite(l.agentWidth) ? clamp(Math.round(l.agentWidth), 300, 760) : 380;
    const open = !(s && s.agent === false),
      right = order.indexOf("agent") > order.indexOf("doc");
    const probe = document.createElement("div");
    probe.style.cssText = "position: fixed; visibility: hidden; padding-left: var(--safe-l, 0px); padding-right: var(--safe-r, 0px)";
    body.append(probe);
    const cs = getComputedStyle(probe),
      sl = parseFloat(cs.paddingLeft) || 0,
      sr = parseFloat(cs.paddingRight) || 0,
      W = root.clientWidth || innerWidth;
    probe.remove();
    const narrow = W < 760;
    const w = narrow ? Math.max(0, Math.min(kept, W - 32)) : clamp(kept, 300, Math.max(300, Math.min(760, W - sl - sr - 360 - 32)));
    // Each panel's box: those before the document from the left edge, those after it from the right, each 16px from the next.
    const box = { agent: 0, picker: 0 },
      wide = { agent: w, picker: 220 },
      d = order.indexOf("doc");
    let x = sl + 16,
      frameL = sl,
      frameR = sr;
    for (const p of order.slice(0, d) as ("agent" | "picker")[]) {
      box[p] = x;
      if (p == "agent" && open) {
        x += w + 16;
        frameL = x;
      }
    }
    x = W - sr - 16;
    for (const p of order.slice(d + 1).reverse() as ("agent" | "picker")[]) {
      box[p] = x - wide[p];
      if (p == "agent" && open) {
        x -= w + 16;
        frameR = W - x;
      }
    }
    // Narrower, the agent covers the page at its side, and the steps float over it: the page keeps the whole width.
    if (narrow) {
      frameL = sl;
      frameR = sr;
      for (const p of ["agent", "picker"] as const) box[p] = order.indexOf(p) < d ? sl + 16 : W - sr - 16 - wide[p];
    }
    const fab = right ? box.agent + w - 44 : box.agent;
    const vars: Record<string, number> = {
      "--agent-x": box.agent,
      "--agent-w": w,
      "--fab-x": fab,
      "--frame-l": frameL,
      "--frame-r": frameR,
      "--picker-x": box.picker,
      "--picker-w": 220,
      "--cb-l": Math.max(frameL + 22, !open && !right ? fab + 44 + 14 : 0),
      "--cb-r": Math.max(frameR + 22, !open && right ? W - fab + 14 : 0),
    };
    for (const k in vars) root.style.setProperty(k, px(vars[k]));
    body.classList.toggle("agent-open", open);
    body.classList.toggle("agent-right", right);
    body.classList.toggle("layout-narrow", narrow);
  } catch {}
  try {
    const z = Number(
      localStorage.getItem("erga:zoom:v1:" + document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')!.content) || 1
    );
    if (Number.isFinite(z) && z > 0 && z != 1) {
      document.documentElement.style.setProperty("--erga-zoom", String(z));
      document.documentElement.classList.add("erga-zoomed");
    }
  } catch {}
}
