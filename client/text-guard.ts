// A press on the page's text is the editor's: it puts the caret there, and a
// drag from it selects. But a page can take the same press for itself: a board
// that pans by a drag, a slide that turns on a press. Then a drag on the text
// pans the board, and no one can select. So in the editor, the page's own
// handlers don't see a press that starts on editable text, nor its moves and
// its release; the browser still selects, and the editor's own listeners
// (listenAsEditor) still get them. A press anywhere else, a hover, a click and
// the wheel reach the page as before.
//
// The other way round: a press on a part of the page that says a drag moves
// the page (a grab or move cursor, or touch-action: none, as a board that pans
// has) starts no selection there. The browser would otherwise select from the
// text nearest the press, and the pan would then drag that text under the
// pointer: the caret jumps away and other text gets selected. The page still
// gets the press and pans; the caret stays where it was.
//
// TEXT_GUARD (shared/page.ts) goes first in the page's <head>, before the
// page's scripts (the pages origin puts it there for whoever may edit): its
// listeners on the window, in the capture phase, run before any of theirs. It
// guards only while the editor is on the page (data-erga-editing).

import { GUARD_DOWN, GUARD_MOVE, GUARD_UP } from "../shared/page";

type Listener = (e: Event) => void;
type OwnWindow = Window & { __ergaOwn?: Record<string, Listener[]> };

/**
 * Listens on the page's document for the editor (doc.addEventListener), and also during a press on the text,
 * which TEXT_GUARD keeps from the page's own handlers. Returns what stops it.
 */
export function listenAsEditor(doc: Document, type: string, f: Listener, opts?: AddEventListenerOptions | boolean): () => void {
  doc.addEventListener(type, f, opts);
  const own = (doc.defaultView as OwnWindow | null)?.__ergaOwn;
  if (own && [...GUARD_DOWN, ...GUARD_MOVE, ...GUARD_UP].includes(type)) (own[type] ??= []).push(f);
  return () => {
    doc.removeEventListener(type, f, opts);
    const list = own?.[type];
    if (list?.includes(f)) list.splice(list.indexOf(f), 1);
  };
}
