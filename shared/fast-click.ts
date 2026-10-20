// Buttons that act as the press starts, not as it ends: a click fires on
// pointerdown for a mouse or a pen (the primary button, no modifier key), and
// on pointerup for a finger that didn't move (a finger that moves is a scroll).
// That takes the 80-150 ms between press and release out of every click.
// The browser's own click, which follows, is dropped, so nothing acts twice.
// The keyboard (Enter, Space: a click whose detail is 0) acts as before.
//
// It's for buttons whose action is cheap to undo or harmless: a menu, a
// panel, a toggle. Never for a drag handle, a link that leaves the page, or a
// destructive action, which keep a deliberate click.
//
// One source for both kinds of page: the server's pages put the text in an
// inline script (fastClickScript), the editor's modules call fastClick. The
// function refers to nothing outside itself.

const SOURCE = `function (root, selector) {
  var doc = root.ownerDocument || root, win = doc.defaultView;
  if (!win) return;
  // press: a finger down on a button, until it lifts or moves. armed: a click went out on this press; until: the browser's
  // own click that follows it is dropped until then. keep: the action moved the focus, which the mousedown would take back.
  var press = null, firing = false, armed = false, until = 0, keep = false;
  function pick(e) {
    var t = e.target, el = t && t.closest ? t.closest(selector) : null;
    return el && root.contains(el) && !el.matches(":disabled") ? el : null;
  }
  function fire(el, e) {
    var before = doc.activeElement;
    firing = true;
    try {
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: win, detail: 1, button: 0,
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY }));
    } finally { firing = false; }
    armed = true;
    keep = doc.activeElement != before;
  }
  win.addEventListener("pointerdown", function () { press = null; armed = false; until = 0; keep = false; }, true);
  root.addEventListener("pointerdown", function (e) {
    if (e.button != 0 || !e.isPrimary || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var el = pick(e);
    if (!el) return;
    if (e.pointerType == "touch") press = { el: el, id: e.pointerId, x: e.clientX, y: e.clientY };
    else fire(el, e);
  }, true);
  win.addEventListener("pointermove", function (e) {
    if (press && e.pointerId == press.id && Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) > 10) press = null;
  }, { capture: true, passive: true });
  win.addEventListener("pointerup", function (e) {
    if (press && e.pointerId == press.id) {
      var p = press, at = doc.elementFromPoint(e.clientX, e.clientY);
      press = null;
      if (p.el.isConnected && at && p.el.contains(at)) fire(p.el, e);
    }
    if (armed) { armed = false; until = win.performance.now() + 1000; }
  }, true);
  win.addEventListener("pointercancel", function () { press = null; armed = false; until = 0; }, true);
  // The press's mousedown would focus the button, away from what the action focused (a menu's first item, a field).
  win.addEventListener("mousedown", function (e) { if (keep) { keep = false; e.preventDefault(); } }, true);
  win.addEventListener("click", function (e) {
    if (firing || e.detail == 0 || !until) return;
    var late = win.performance.now() > until;
    until = 0;
    if (late) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}`;

/** A document, an element or a shadow root (typed loosely: the server has no DOM types). */
type Root = object;

/** For an inline script: makes `root`'s buttons that match `selector` act on press (`root` is a JS expression). */
export const fastClickScript = (root: string, selector: string) =>
  `(window.ergaFastClick = window.ergaFastClick || ${SOURCE})(${root}, ${JSON.stringify(selector)});`;

let made: ((root: Root, selector: string) => void) | null = null;
/** Makes `root`'s buttons that match `selector` act on press. In a browser only. */
export function fastClick(root: Root, selector: string): void {
  made ??= new Function(`return (${SOURCE})`)() as (root: Root, selector: string) => void;
  made(root, selector);
}
