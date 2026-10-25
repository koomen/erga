// The text guard (client/text-guard.ts says what it does), while the editor is on the page (data-erga-editing):
// first in a document's page (server/pages/reader.ts), so its listeners on the window, in the capture phase, run before
// any of the page's. (Indexed loops and forEach, as the page's own script may change other ways to go through a list.)

import { GUARD_DOWN, GUARD_END, GUARD_GRAB, GUARD_INTERACTIVE, GUARD_MOVE, GUARD_NOT_TEXT, GUARD_TEXT, GUARD_UP } from "../../shared/page";

type GuardWindow = Window & { __ergaOwn?: Record<string, ((e: Event) => void)[]> };

export default function pageTextGuard(): void {
  const own: Record<string, ((e: Event) => void)[]> = ((window as GuardWindow).__ergaOwn = {});
  const opts = { capture: true, passive: false },
    grab = new RegExp(GUARD_GRAB),
    root = document.documentElement;
  let pressed = false;
  function on() {
    return root.hasAttribute("data-erga-editing");
  }
  function elOf(e: Event) {
    const t = e.target as Node | null;
    return t && (t.nodeType == 1 ? (t as Element) : t.parentElement);
  }
  function onText(e: Event) {
    const el = elOf(e);
    return !!(el && el.closest && el.closest(GUARD_TEXT)) && !el!.closest(GUARD_NOT_TEXT);
  }
  function pans(e: Event) {
    const el = elOf(e);
    if (!el || !el.closest || el.closest(GUARD_INTERACTIVE)) return false;
    if (grab.test(getComputedStyle(el).cursor)) return true;
    for (let a: Element | null = el; a; a = a.parentElement) if (getComputedStyle(a).touchAction == "none") return true;
    return false;
  }
  function take(e: Event) {
    const fs = (own[e.type] || []).slice();
    for (let i = 0; i < fs.length; i++) {
      try {
        fs[i](e);
      } catch (x) {
        setTimeout(() => {
          throw x;
        });
      }
    }
    e.stopImmediatePropagation();
  }
  GUARD_DOWN.forEach((type) => {
    addEventListener(
      type,
      (e) => {
        if ((e as MouseEvent).button || !on()) {
          pressed = false;
          return;
        }
        pressed = onText(e);
        if (pressed) take(e);
        else if (type == "mousedown" && pans(e)) e.preventDefault();
      },
      opts
    );
  });
  GUARD_MOVE.forEach((type) => {
    addEventListener(
      type,
      (e) => {
        if (pressed) take(e);
      },
      opts
    );
  });
  GUARD_UP.forEach((type) => {
    addEventListener(
      type,
      (e) => {
        if (!pressed) return;
        if (GUARD_END.indexOf(type) >= 0) pressed = false;
        take(e);
      },
      opts
    );
  });
}
