// The viewer's controls (Clone, Edit, who you are) fade once the page is scrolled, on a document's page
// (viewer-fade.ts) and on the homepage alike (server/home/render.ts): whole at the top of the page, faded
// (server/pages/viewer.ts: VIEW_STYLE, FADED) anywhere below it, and whole again while the pointer is within NEAR px
// of them, one of them has keyboard focus or your menu is open. On a touch screen, with no pointer to come near, a tap
// near them brings them back until the page scrolls again. It's a function of those alone: the same scroll and pointer
// give the same look, and no timer changes it.
//
// ergaFade(target, root) puts the class erga-faded on `target` while they're faded; `root` is the document or shadow
// root they're in. Its caller tells it where the page is scrolled to (scroll(y)) and where the pointer is, in the
// window's coordinates (pointer(x, y, tap)), or that it left the window (leave()).

/** How near the pointer brings the controls back, in pixels. */
const NEAR = 100;
const CONTROLS = ".erga-view-buttons, .erga-account, .erga-crumbs";

export default function ergaFade(target: Element, root: Document | ShadowRoot) {
  let y = 0,
    mouse: { x: number; y: number } | null = null,
    tap = false;
  // How far (x, y) is from the nearest control (the account's button, not its menu).
  function distance(x: number, y: number) {
    let best = Infinity;
    root.querySelectorAll(".erga-view-buttons > *, .erga-account-btn").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dx = Math.max(r.left - x, 0, x - r.right),
        dy = Math.max(r.top - y, 0, y - r.bottom);
      best = Math.min(best, Math.hypot(dx, dy));
    });
    return best;
  }
  function focused() {
    const a = root.activeElement;
    try {
      return !!(a && a.closest && a.closest(CONTROLS) && a.matches(":focus-visible"));
    } catch {
      return false;
    }
  }
  function update() {
    const whole =
      y <= 0 ||
      tap ||
      (mouse && distance(mouse.x, mouse.y) <= NEAR) ||
      focused() ||
      !!root.querySelector('.erga-account-btn[aria-expanded="true"]');
    target.classList.toggle("erga-faded", !whole);
  }
  root.addEventListener("focusin", update);
  root.addEventListener("focusout", () => {
    setTimeout(update);
  });
  // The account's menu opening or closing.
  new MutationObserver(update).observe(root, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"] });
  addEventListener("resize", update);
  update();
  return {
    scroll: (to: number) => {
      to = Math.max(0, Number(to) || 0);
      if (to != y) tap = false;
      y = to;
      update();
    },
    pointer: (x: number, py: number, isTap: boolean) => {
      if (!Number.isFinite(x) || !Number.isFinite(py)) return;
      if (isTap) tap = distance(x, py) <= NEAR;
      else mouse = { x, y: py };
      update();
    },
    leave: () => {
      mouse = null;
      update();
    },
    update,
  };
}
