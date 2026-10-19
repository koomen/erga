// @codemirror/view, as the frame's build has it (client/build.ts): an inert
// stand-in. The frame keeps an EditorState (the text and its undo history)
// and never an EditorView: the page editor draws the page itself (bridge.ts).
// But @codemirror/commands, and @codemirror/language which it imports,
// import the view's module for their view parts (a parse worker that runs in
// a view, keymaps, themes, fold markers), and so would bring all of it
// (150 KB) into frame.js. Those parts only go into a state as extensions a
// view would read; here they are empty ones, which the state ignores.
//
// Only the names those packages import: a new one fails the frame's build
// (tests/frame-view.test.ts runs their state commands over this).

/** Anything a module asks of the view: a value whose every property and call is itself, an empty extension in a state. */
const inert: any = new Proxy(function () {}, {
  get: (_, key) => (key == "extension" ? [] : key == "prototype" ? Object.prototype : key == Symbol.toPrimitive ? () => "" : inert),
  apply: () => inert,
  construct: () => ({}),
});

export const EditorView = inert, ViewPlugin = inert, Decoration = inert, WidgetType = inert, GutterMarker = inert;
export const keymap = inert, gutter = inert, showTooltip = inert, getTooltip = inert, Direction = inert;

/** What the view does with an exception in an extension: here, the console. */
export function logException(_state: unknown, exception: unknown, context?: string): void {
  console.error(context ? `CodeMirror (${context}):` : "CodeMirror:", exception);
}
