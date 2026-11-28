// The breadcrumbs' room on a phone (narrower than 760px), in the viewer and on a published site (bars.ts) and in the
// editor (client/shell/chrome.ts) alike: the quick actions are always open, and the breadcrumbs' bar ends 8px before
// the buttons' bar (--nav-room). When the full breadcrumbs won't fit, `.tight` drops `Documents ›` so the document
// title gets the room (client/inline/bars.css).

export function mountQuick(o: {
  /** The breadcrumbs' bar and the buttons' bar. */
  nav: HTMLElement;
  bar: HTMLElement;
  /** What carries the editing classes: the body, or a published site's controls' host. */
  on?: HTMLElement;
  /** The others' stack left of the bar (the editor's #people), if there is one. */
  stack?: HTMLElement;
}) {
  const phone = matchMedia("(max-width: 759.98px)"),
    body = o.on ?? document.body;
  // (On a phone the others' stack is hidden: client/styles/editor.css. Coalesced via rAF so toggling `.tight` never
  // triggers a synchronous ResizeObserver loop in WebKit.)
  let raf = 0;
  const update = () => {
    // Once the editor's mountQuick is active (with #people stack), yield to it rather than fighting over --nav-room/.tight.
    if (!o.stack && body.classList.contains("erga-editing") && body.classList.contains("erga-editor-ready")) return;
    const room = Math.max(0, barEdge(o.bar, phone.matches ? undefined : o.stack) - o.nav.getBoundingClientRect().left - 8);
    o.nav.style.setProperty("--nav-room", `${room}px`);
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
  new MutationObserver(navRoom).observe(body, { attributes: true, attributeFilter: ["class"] });
  new ResizeObserver(navRoom).observe(o.bar);
  new ResizeObserver(navRoom).observe(o.nav);
  if (o.stack) new ResizeObserver(navRoom).observe(o.stack);
  addEventListener("resize", navRoom);
  o.nav.addEventListener("transitionend", navRoom);
  phone.addEventListener("change", navRoom);
  update();
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
