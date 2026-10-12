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
// TEXT_GUARD goes first in the page's <head> (PageEditor.injectHead), before
// the page's scripts: its listeners on the window, in the capture phase, run
// before any of theirs.

type Listener = (e: Event) => void;
type OwnWindow = Window & { __ergaOwn?: Record<string, Listener[]> };

/** Where a press is the editor's: in a text block (data-erga-id) that takes edits, not in a widget or a form field. */
const TEXT = "[data-erga-id]";
const NOT_TEXT = '.erga-locked, [data-erga-noedit], [contenteditable="false"], input, textarea, select, button';

/** What keeps the browser's own press (a link, a form field, an editable part the page made itself, a video's controls). */
const INTERACTIVE = 'a[href], button, input, textarea, select, label, summary, video, audio, iframe, [tabindex], [draggable="true"], [contenteditable]:not([contenteditable="false"])';
/** The cursors that say a drag here moves the page. */
const GRAB = "^(grab|grabbing|move|all-scroll)$";

/** The press, its moves and its release, for the mouse, a pen and a touch. */
const DOWN = ["pointerdown", "mousedown", "touchstart"];
const MOVE = ["pointermove", "mousemove", "touchmove"];
const UP = ["pointerup", "pointercancel", "mouseup", "touchend", "touchcancel"];
/** The release that ends a press: a mouse's (a pen's and a tap's come as mouse events too, last), or a touch's. */
const END = ["mouseup", "touchend", "touchcancel"];

const GUARD = `(function(TEXT,NOT_TEXT,INTERACTIVE,GRAB,DOWN,MOVE,UP,END){
var own=window.__ergaOwn={},pressed=false,opts={capture:true,passive:false},grab=new RegExp(GRAB);
function elOf(e){var t=e.target;return t&&(t.nodeType==1?t:t.parentElement)}
function onText(e){var el=elOf(e);return !!(el&&el.closest&&el.closest(TEXT))&&!el.closest(NOT_TEXT)}
function pans(e){var el=elOf(e);if(!el||!el.closest||el.closest(INTERACTIVE))return false;if(grab.test(getComputedStyle(el).cursor))return true;for(var a=el;a;a=a.parentElement)if(getComputedStyle(a).touchAction=="none")return true;return false}
function take(e){var fs=(own[e.type]||[]).slice();for(var i=0;i<fs.length;i++){try{fs[i](e)}catch(x){setTimeout(function(){throw x})}}e.stopImmediatePropagation()}
DOWN.forEach(function(type){addEventListener(type,function(e){if(e.button)return;pressed=onText(e);if(pressed)take(e);else if(type=="mousedown"&&pans(e))e.preventDefault()},opts)});
MOVE.forEach(function(type){addEventListener(type,function(e){if(pressed)take(e)},opts)});
UP.forEach(function(type){addEventListener(type,function(e){if(!pressed)return;if(END.indexOf(type)>=0)pressed=false;take(e)},opts)});
})`;

export const TEXT_GUARD = `<script data-erga>${GUARD}(${[TEXT, NOT_TEXT, INTERACTIVE, GRAB, DOWN, MOVE, UP, END].map((v) => JSON.stringify(v)).join(",")})</script>`;

/**
 * Listens on the page's document for the editor (doc.addEventListener), and also during a press on the text,
 * which TEXT_GUARD keeps from the page's own handlers. Returns what stops it.
 */
export function listenAsEditor(doc: Document, type: string, f: Listener, opts?: AddEventListenerOptions | boolean): () => void {
  doc.addEventListener(type, f, opts);
  const own = (doc.defaultView as OwnWindow | null)?.__ergaOwn;
  if (own && [...DOWN, ...MOVE, ...UP].includes(type)) (own[type] ??= []).push(f);
  return () => {
    doc.removeEventListener(type, f, opts);
    const list = own?.[type];
    if (list?.includes(f)) list.splice(list.indexOf(f), 1);
  };
}
