// The New document picker (server/pages/templates.ts, newDocMenu): opens and closes it, once for each page or shadow
// root with a picker in it. Any + button in it opens it, under the button, including ones added later (the editor's,
// client/editor.html). Escape, a click elsewhere, or leaving the window closes it; arrow keys move in it.

export function newDocPicker(root: Document | ShadowRoot): void {
  const menu = root.querySelector<HTMLElement>(".erga-new-menu");
  if (!menu) return;
  let btn: HTMLElement | null = null;
  // (Only those it shows: Clone shows only in the editor.)
  const items = () => [...menu.querySelectorAll("a")].filter((a) => a.getClientRects().length);
  // The app's typeface, on a page that hasn't it (the viewer, the homepage, signed out): its rules (the menu names them) fetched
  // as the pointer or focus comes to a + button. A page with them has them as #erga-fonts (server/pages/assets.ts).
  const font = () => {
    if (document.getElementById("erga-fonts") || !menu.dataset.fonts) return;
    document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: menu.dataset.fonts, id: "erga-fonts" }));
  };
  for (const type of ["pointerover", "focusin"])
    root.addEventListener(type, (e) => {
      const t = e.target as Element;
      if (t.closest && t.closest(".erga-new-btn")) font();
    });
  const show = (b: HTMLElement | null) => {
    if (b) font();
    if (btn) btn.setAttribute("aria-expanded", "false");
    btn = b;
    menu.hidden = !b;
    if (!b) return;
    b.setAttribute("aria-expanded", "true");
    const r = b.getBoundingClientRect(),
      w = menu.offsetWidth;
    menu.style.top = r.bottom + 8 + "px";
    menu.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.right - w)) + "px";
  };
  root.addEventListener("click", (e) => {
    const t = e.target as Element,
      b = t.closest && t.closest<HTMLElement>(".erga-new-btn");
    if (!b) return;
    e.preventDefault();
    if (btn == b) {
      show(null);
      return;
    }
    show(b);
    items()[0]?.focus({ preventScroll: true });
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!btn) return;
      const path = e.composedPath();
      if (!path.includes(menu) && !path.includes(btn)) show(null);
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (!btn) return;
    if (e.key == "Escape") {
      const b = btn;
      show(null);
      b.focus();
      return;
    }
    if (e.key != "ArrowDown" && e.key != "ArrowUp") return;
    e.preventDefault();
    const all = items(),
      at = all.indexOf(root.activeElement as HTMLAnchorElement);
    all[(at + (e.key == "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
  });
  menu.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a")) show(null);
  });
  addEventListener("blur", () => show(null));
  addEventListener("resize", () => show(null));
  addEventListener("hashchange", () => show(null));
}
