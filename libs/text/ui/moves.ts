// What the editor draws over the page (your caret, other people's carets, the
// marks, the format bar) is placed where the text is, and placed again when
// the text could have moved. A scroll of the window, a resize or an edit are
// the usual causes. But a page can move its text in other ways: a board that
// pans by a drag or the wheel with a transform, a column that scrolls by
// itself, a CSS transition. This tells each one of those, for a page's
// document, to whoever draws over it.

import { listenAsEditor } from "./text-guard";

type Win = Window & typeof globalThis;
type Hub = { listeners: Set<() => void>; stop: () => void };

const hubs = new WeakMap<Document, Hub>();
/** The editor's own elements in the page (<erga-caret>, <erga-peers>, ...): their changes move no text. */
const ours = (n: Node | null) => !!n && n.nodeType == 1 && (n as Element).localName.startsWith("erga-");
/** The longest a transition or an animation is followed, a frame at a time. */
const FOLLOW_MAX = 3000;

/**
 * Calls `moved` when the page's text may have moved without a scroll of the window: an element's scroll, a change
 * to an attribute (a style, a class), a wheel or a drag (the page may pan in its handler), and on each frame of a
 * transition or an animation. It can call it many times in a frame: `moved` only queues its work.
 * Returns an unsubscribe function; when the last subscriber for `doc` unsubscribes, all observers and listeners are torn down.
 */
export function watchMoves(doc: Document, win: Win, moved: () => void): () => void {
  let hub = hubs.get(doc);
  if (hub) {
    hub.listeners.add(moved);
  } else {
    const listeners = new Set<() => void>([moved]);
    const cleanups: (() => void)[] = [];
    const tell = () => {
      for (const f of [...listeners]) if (listeners.has(f)) f();
    };

    const listen = (type: string, when: (e: Event) => boolean = () => true) =>
      cleanups.push(
        listenAsEditor(
          doc,
          type,
          (e) => {
            if (when(e)) tell();
          },
          { capture: true, passive: true }
        )
      );
    listen("scroll");
    listen("wheel");
    listen("pointermove", (e) => (e as PointerEvent).buttons != 0);
    listen("touchmove");

    const observer = new win.MutationObserver((records) => {
      if (records.some((r) => !ours(r.target))) tell();
    });
    observer.observe(doc, { attributes: true, subtree: true });
    cleanups.push(() => observer.disconnect());

    // A transition or an animation moves things a frame at a time, with no event between: follow it to its end.
    let until = 0,
      running = false,
      rafId = 0,
      stopped = false;
    const frame = () => {
      rafId = 0;
      if (stopped) {
        running = false;
        return;
      }
      tell();
      if (!stopped && performance.now() < until) rafId = win.requestAnimationFrame(frame);
      else running = false;
    };
    const follow = (e: Event) => {
      if (stopped) return;
      const target = e.target as Element;
      if (ours(target) || typeof target.getAnimations != "function") return;
      let end = 0;
      for (const a of target.getAnimations()) {
        const t = a.effect?.getComputedTiming();
        const left = Number(t?.endTime) - Number(a.currentTime ?? 0);
        if (Number.isFinite(left)) end = Math.max(end, left);
      }
      until = Math.max(until, performance.now() + Math.min(FOLLOW_MAX, end) + 50);
      if (!running) {
        running = true;
        rafId = win.requestAnimationFrame(frame);
      }
    };
    const followOpts = { capture: true, passive: true } as const;
    for (const type of ["transitionrun", "animationstart"]) {
      doc.addEventListener(type, follow, followOpts);
      cleanups.push(() => doc.removeEventListener(type, follow, followOpts));
    }
    for (const type of ["transitionend", "transitioncancel", "animationend", "animationcancel"])
      listen(type, (e) => !ours(e.target as Node));
    cleanups.push(() => {
      stopped = true;
      running = false;
      if (rafId) {
        win.cancelAnimationFrame?.(rafId);
        rafId = 0;
      }
    });

    hub = {
      listeners,
      stop: () => {
        for (const f of cleanups.splice(0)) f();
      },
    };
    hubs.set(doc, hub);
  }

  const owned = hub;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    owned.listeners.delete(moved);
    if (owned.listeners.size == 0) {
      owned.stop();
      if (hubs.get(doc) === owned) hubs.delete(doc);
    }
  };
}
