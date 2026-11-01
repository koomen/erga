// The quick actions on a phone (narrower than 760px), in the viewer and on the homepage (bars.ts) and in the editor
// (client/shell/chrome.ts) alike: the buttons' bar is your avatar alone, and a tap on it opens the quick actions out of it,
// to its left, and its menu under it (client/inline/bars.css, .quick). A card opened from them keeps them open; a tap
// anywhere else closes them. The breadcrumbs' bar makes way: it ends 8px before the buttons' bar, its end in sight
// (--nav-room). Open or closed is the class quick-open on the body (on the homepage, on its controls' host: `on`), so
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
  /** What carries the class: the body, or the homepage's controls' host. */
  on?: HTMLElement;
}) {
  const phone = matchMedia("(max-width: 759.98px)"),
    body = o.on ?? document.body;
  // (Out of sight, closed on a phone, they can't be reached by Tab either.)
  const sync = () => (o.quick.inert = phone.matches && !body.classList.contains("quick-open"));
  function toggle(force?: boolean) {
    body.classList.toggle("quick-open", typeof force == "boolean" ? force : !body.classList.contains("quick-open"));
    sync();
  }
  new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ["class"] });
  toggle(false);
  phone.addEventListener("change", () => toggle(false));
  o.me.addEventListener("click", () => toggle(o.menuOpen()));
  // (The path, not the target: in a shadow root the target is its host.)
  document.addEventListener("pointerdown", (e) => {
    if (body.classList.contains("quick-open") && !e.composedPath().some((n) => n instanceof Element && n.matches(o.keep))) toggle(false);
  });
  const navRoom = () =>
    o.nav.style.setProperty("--nav-room", `${Math.max(0, o.bar.getBoundingClientRect().left - o.nav.getBoundingClientRect().left - 8)}px`);
  new ResizeObserver(navRoom).observe(o.bar);
  addEventListener("resize", navRoom);
  return toggle;
}
