// The homepage's controls (server/home/render.ts, homeHeader), in the script after their host: it moves the host out of
// the page's <body> (so nothing the page does to its body moves it), gives the band and the bars the page's background
// and its tone, and runs the account menu, the New document picker, the bars' buttons (client/common/bars.ts) and the
// tooltips.

import { mountBars } from "../common/bars";
import { imgFallback } from "../common/img-fallback";
import { newDocPicker } from "../common/new-doc";
import { installQuickSearch, quickLink } from "../common/quick-search";

export default function homeControls(): void {
  const host = document.currentScript!.previousElementSibling as HTMLElement;
  let root = host.shadowRoot;
  // A browser without declarative shadow roots: made here instead.
  if (!root) {
    const t = host.querySelector("template");
    if (!t) return;
    root = host.attachShadow({ mode: "open" });
    root.append(t.content);
    t.remove();
  }
  imgFallback(root);
  document.documentElement.append(host);
  const bar = () => host.style.setProperty("--erga-scrollbar", Math.max(0, innerWidth - document.documentElement.clientWidth) + "px");
  bar();
  addEventListener("resize", bar);
  addEventListener("load", bar);
  if (window.ResizeObserver) new ResizeObserver(bar).observe(document.documentElement);
  // The band takes the page's background: its root's, else its body's (which the root shows), else the canvas's.
  const clear = (c: string) => !c || c == "transparent" || /^rgba\(.*,\s*0\)$/.test(c);
  const band = () => {
    let c = "";
    for (const el of [document.documentElement, document.body]) {
      const b = el && getComputedStyle(el).backgroundColor;
      if (!clear(b)) {
        c = b;
        break;
      }
    }
    host.style.setProperty("--erga-band", c || "Canvas");
    // The bars' tone, as on a document's page (viewer-band-head.ts, main.ts): dark glass on a dark page, tinted on a white one.
    const rgb = c.match(/[\d.]+/g)?.map(Number);
    const lum =
      rgb && rgb.length >= 3
        ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
        : matchMedia("(prefers-color-scheme: dark)").matches
          ? 0
          : 1;
    host.classList.toggle("page-dark", lum < 0.45);
    host.classList.toggle("page-light", lum >= 0.45);
    host.classList.toggle("page-white", lum > 0.95);
  };
  band();
  addEventListener("load", band);
  new MutationObserver(band).observe(document.documentElement, { attributes: true, subtree: false });
  if (document.body) new MutationObserver(band).observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", band);
  // Who you are (server/pages/account-menu.ts's corner): its menu opens and closes as everywhere else on the site.
  const acc = root.querySelector(".erga-account"),
    btn = acc && acc.querySelector("button"),
    menu = acc && acc.querySelector<HTMLElement>(".erga-account-menu");
  // ⌘K, for someone signed in (client/common/quick-search.ts).
  if ((acc as HTMLElement | null)?.dataset.ergaAccount == "in") installQuickSearch();
  if (acc && btn && menu) {
    const show = (open: boolean) => {
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    };
    quickLink(menu.querySelector(".erga-account-go"), () => show(false));
    btn.addEventListener("click", () => {
      show(!!menu.hidden);
      if (!menu.hidden) menu.querySelector("a")?.focus({ preventScroll: true });
    });
    document.addEventListener("pointerdown", (e) => {
      if (!e.composedPath().includes(acc)) show(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key == "Escape" && !menu.hidden) {
        show(false);
        btn.focus();
      }
    });
    addEventListener("blur", () => show(false));
  }
  // New document's picker.
  newDocPicker(root);
  // The bars' buttons: the quick actions on a phone, and Share with an agent.
  mountBars(root, host);
  // Tooltips follow the pointer while it's on a control.
  root.addEventListener(
    "pointermove",
    (ev) => {
      const e = ev as PointerEvent;
      const el = e.pointerType == "mouse" && (e.target as Element).closest?.<HTMLElement>("[data-tip]");
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--tip-x", e.clientX - r.left - 6 + "px");
      el.style.setProperty("--tip-y", e.clientY - r.top + 30 + "px");
    },
    { passive: true }
  );
}
