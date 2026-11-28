// The quick actions on a phone (narrower than 760px), in the viewer and on a published site (bars.ts) and in the editor
// (client/shell/chrome.ts) alike: the buttons' bar is your avatar alone, and a tap on it opens the quick actions out of it,
// to its left, and its menu under it (client/inline/bars.css, .quick). A card opened from them keeps them open; a tap
// anywhere else closes them. The breadcrumbs' bar makes way: it ends 8px before the buttons' bar, its end in sight
// (--nav-room). Open or closed is the class quick-open on the body (on a published site, on its controls' host: `on`), so
// the viewer's bars and the editor's agree.

export function mountQuick(o: {
  /** The quick actions (.quick), in the buttons' bar. */
  quick: HTMLElement;
  /** Your avatar's slot (.me-slot): a tap on it opens or closes them. */
  me: HTMLElement;
  /** The breadcrumbs' bar and the buttons' bar. */
  nav: HTMLElement;
  bar: HTMLElement;
  /** After the avatar's own click: whether its menu is open now, if it has one. */
  menuOpen(): boolean | undefined;
  /** What a tap may land on and keep them open: the bar and the cards out of it. */
  keep: string;
  /** What carries the class: the body, or a published site's controls' host. */
  on?: HTMLElement;
  /** The others' stack left of the bar (the editor's #people), if there is one. */
  stack?: HTMLElement;
}) {
  const phone = matchMedia("(max-width: 759.98px)"),
    body = o.on ?? document.body;
  // (Out of sight, closed on a phone, they can't be reached by Tab either.)
  const sync = () => (o.quick.inert = phone.matches && !body.classList.contains("quick-open"));
  function toggle(force?: boolean) {
    body.classList.toggle("quick-open", typeof force == "boolean" ? force : !body.classList.contains("quick-open"));
    sync();
  }
  toggle(false);
  phone.addEventListener("change", () => toggle(false));
  o.me.addEventListener("click", () => toggle(o.menuOpen()));
  // (The path, not the target: in a shadow root the target is its host.)
  document.addEventListener("pointerdown", (e) => {
    if (body.classList.contains("quick-open") && !e.composedPath().some((n) => n instanceof Element && n.matches(o.keep))) toggle(false);
  });
  // (Open, the quick actions hide the stack: client/styles/editor.css. Coalesced via rAF so toggling `.tight` never
  // triggers a synchronous ResizeObserver loop in WebKit.)
  let raf = 0;
  const update = () => {
    // Once the editor's mountQuick is active (with #people stack), yield to it rather than fighting over --nav-room/.tight.
    if (!o.stack && body.classList.contains("erga-editing") && body.classList.contains("erga-editor-ready")) return;
    const quickOpen = body.classList.contains("quick-open");
    const room = Math.max(0, barEdge(o.bar, quickOpen ? undefined : o.stack) - o.nav.getBoundingClientRect().left - 8);
    o.nav.style.setProperty("--nav-room", `${room}px`);
    if (quickOpen) return;
    const back = o.nav.querySelector<HTMLElement>(".erga-crumb, .nav-back");
    if (!phone.matches || !back || back.hidden) return void o.nav.classList.remove("tight");
    const tight = o.nav.classList.contains("tight");
    if (!tight) {
      const sep = back.nextElementSibling as HTMLElement | null;
      const bw = back.offsetWidth + (sep?.classList.contains("erga-sep") ? sep.offsetWidth : 0);
      if (bw > 0) o.nav.dataset.backW = String(bw);
    }
    const backWidth = Number(o.nav.dataset.backW) || 0;
    let parts = 16 + (tight ? backWidth : 0);
    for (const el of o.nav.children) {
      const h = el as HTMLElement;
      parts += h.offsetWidth;
      const span = h.matches(".erga-here, .nav-title") ? h.querySelector<HTMLElement>("span") : null;
      if (span && span.scrollWidth > span.offsetWidth) parts += span.scrollWidth - span.offsetWidth;
    }
    o.nav.classList.toggle("tight", parts > room || (!tight && o.nav.scrollWidth > o.nav.clientWidth + 1));
  };
  const navRoom = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      update();
    });
  };
  new MutationObserver(() => {
    sync();
    navRoom();
  }).observe(body, { attributes: true, attributeFilter: ["class"] });
  new ResizeObserver(navRoom).observe(o.bar);
  new ResizeObserver(navRoom).observe(o.nav);
  if (o.stack) new ResizeObserver(navRoom).observe(o.stack);
  addEventListener("resize", navRoom);
  o.nav.addEventListener("transitionend", navRoom);
  phone.addEventListener("change", navRoom);
  update();
  return toggle;
}

/**
 * Where the buttons' bar starts, with what is left of it: the save mark, where it shows (client/inline/bars.css: 24px
 * wide, and it touches the bar), and then the others' stack at its width at rest (people.ts, data-w), 8px on, and 10px from the
 * breadcrumbs (2, and the 8 each caller leaves). The stack spread by a hover goes over the breadcrumbs for a moment,
 * and they don't move for it.
 */
export function barEdge(bar: HTMLElement, stack?: HTMLElement | null): number {
  const w = Number(stack?.dataset.w) || 0,
    mark = bar.querySelector<HTMLElement>(".save-state")?.offsetWidth ? 24 : 0;
  return bar.getBoundingClientRect().left - mark - (w ? w + (mark ? 10 : 12) : 0);
}
