// What the page draws again waits for a press on it to end.
//
// Trap: a click is a press and a release on the same element. News from the server (a live row, the file tree, an
// alert) that draws an element again between the two takes the pressed element away: the release is on the new one,
// and the browser gives no click. The button does nothing, with no error. A person's press lasts about 100 ms, so it
// is rare, and a test's press met it often. So: what is drawn again for news asks here first.

/** A press in progress, for the listeners of `target` (the window), and what waits for its end. */
export function presses(target: Pick<EventTarget, "addEventListener">, later: (run: () => void) => void = (run) => setTimeout(run)) {
  let held: unknown = null;
  const waiting = new Set<() => void>();
  target.addEventListener("pointerdown", (e) => void (held = e.target), true);
  // The release, or another end of the press. What waited runs after the click, which the browser gives right after
  // the release.
  const end = () => {
    held = null;
    if (!waiting.size) return;
    later(() => {
      const all = [...waiting];
      waiting.clear();
      for (const run of all) run();
    });
  };
  // (A drag takes the press: some browsers say pointercancel as it starts, each says dragend. A window that loses the
  // focus may never hear the release.)
  for (const name of ["pointerup", "pointercancel", "dragend", "blur"]) target.addEventListener(name, end, true);
  const pressedIn = (el: Node) => held != null && el.contains(held as Node);
  return {
    /** Whether a press is in progress on `el` or in it. */
    pressedIn,
    /** Runs `draw` now, or, during a press in `el`, one time after its release and click. */
    afterPress(el: Node, draw: () => void) {
      if (pressedIn(el)) waiting.add(draw);
      else draw();
    },
  };
}

const page = typeof window == "undefined" ? null : presses(window);
export const pressedIn = (el: Node) => !!page?.pressedIn(el);
export const afterPress = (el: Node, draw: () => void) => (page ? page.afterPress(el, draw) : draw());
