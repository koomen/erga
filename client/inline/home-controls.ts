// The homepage's controls (server/home/render.ts, homeHeader), in the script after their host: it moves the host out of
// the page's <body> (so nothing the page does to its body moves it), gives the band the page's background, and runs
// the account menu, the New document picker, the fade and the tooltips.

import { imgFallback } from "../common/img-fallback";
import { newDocPicker } from "../common/new-doc";
import ergaFade from "../common/fade";

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
  if (acc && btn && menu) {
    const show = (open: boolean) => {
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    };
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
  // The controls fade once the page is scrolled, as on any document's page: on the host, whose own opacity
  // the page can't touch; the band stays as it is.
  const fade = ergaFade(host, root);
  const scrolled = () => fade.scroll(scrollY);
  addEventListener("scroll", scrolled, { passive: true });
  scrolled();
  document.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType == "mouse") fade.pointer(e.clientX, e.clientY, false);
    },
    { capture: true, passive: true }
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType != "mouse") fade.pointer(e.clientX, e.clientY, true);
    },
    { capture: true, passive: true }
  );
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) fade.leave();
  });
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
