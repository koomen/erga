// What the page draws again waits for a press on it to end, and for a drag over it.
//
// Trap: a click is a press and a release on the same element. News from the server (a live row, the file tree, an
// alert) that draws an element again between the two takes the pressed element away: the release is on the new one,
// and the browser gives no click. The button does nothing, with no error. A person's press lasts about 100 ms, so it
// is rare, and a test's press met it often. So: what is drawn again for news asks here first.
//
// Trap: a drop goes to the element that the drag was over last. Files from the computer over a folder of the file
// tree, then news that draws the rows again: that row is gone, the drop reaches nothing, and no file is added, with no
// error. So a drag over an element holds it as a press does, until the drop or until the drag leaves the window.

/** A press in progress, for the listeners of `target` (the window), and what waits for its end. */
export function presses(target: Pick<EventTarget, "addEventListener">, later: (run: () => void) => void = (run) => setTimeout(run)) {
  let held: unknown = null;
  const waiting = new Set<() => void>();
  // (The main button's press: only that one ends in a click. Another button's opens the browser's menu, which may
  // take the release.)
  target.addEventListener("pointerdown", (e) => void (held = (e as PointerEvent).button ? null : e.target), true);
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
  // A drag over an element holds it too: of files from the computer, or of a part of the page.
  target.addEventListener("dragover", (e) => void (held = e.target), true);
  // (A drag takes the press: some browsers say pointercancel as it starts. It ends with its drop, or, a drag of the
  // page's own, with dragend; one that leaves the window says dragleave with nothing it goes to.)
  for (const name of ["pointerup", "pointercancel", "dragend", "drop"]) target.addEventListener(name, end, true);
  target.addEventListener("dragleave", (e) => void ((e as DragEvent).relatedTarget == null && end()), true);
  // A window that loses the focus may never hear the release.
  // Trap: only the window's own blur. A press moves the focus to what it is on, and the element that had the focus
  // says blur too, right after the press's start: with that one, the wait ended as each real press began.
  target.addEventListener("blur", (e) => void (e.target == target && end()), true);
  const pressedIn = (el: Node) => held != null && el.contains(held as Node);
  return {
    /** Whether a press is in progress on `el` or in it, or a drag is over it. */
    pressedIn,
    /** Runs `draw` now, or, during a press in `el` (or a drag over it), one time after its release and click (its drop). */
    afterPress(el: Node, draw: () => void) {
      if (pressedIn(el)) waiting.add(draw);
      else draw();
    },
  };
}

const page = typeof window == "undefined" ? null : presses(window);
export const pressedIn = (el: Node) => !!page?.pressedIn(el);
export const afterPress = (el: Node, draw: () => void) => (page ? page.afterPress(el, draw) : draw());
