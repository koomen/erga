// @codemirror/view and @lezer/common, as the frame's build has them
// (client/build.ts): an inert stand-in. The frame keeps an EditorState (the
// text and its undo history) and never an EditorView or a syntax tree: the
// page editor draws the page itself (bridge.ts). But @codemirror/commands,
// and @codemirror/language which it imports, import both modules for their
// view parts and their parser (a parse worker that runs in a view, keymaps,
// themes, fold markers, node types), and so would bring all of them (170 KB)
// into frame.js. Those parts only go into a state as extensions a view would
// read; here they are empty ones, which the state ignores.
//
// Only the names those packages import: a new one fails the frame's build
// (tests/frame-view.test.ts runs their state commands over this).

/**
 * Anything a module asks of the view or the parser: a value whose every property and call is itself, an empty extension
 * in a state. Made with `new`, it is itself too (a node prop); a class that extends it makes a plain object.
 */
const inert: any = new Proxy(function () {}, {
  get: (_, key) => (key == "extension" ? [] : key == "prototype" ? Object.prototype : key == Symbol.toPrimitive ? () => "" : inert),
  apply: () => inert,
  construct: (_target, _args, made) => (made === inert ? inert : {}),
});

export const EditorView = inert,
  ViewPlugin = inert,
  Decoration = inert,
  WidgetType = inert,
  GutterMarker = inert;
export const keymap = inert,
  gutter = inert,
  showTooltip = inert,
  getTooltip = inert,
  Direction = inert;
export const NodeProp = inert,
  IterMode = inert,
  Tree = inert,
  TreeFragment = inert,
  Parser = inert,
  NodeType = inert,
  NodeSet = inert;

/** What the view does with an exception in an extension: here, the console. */
export function logException(_state: unknown, exception: unknown, context?: string): void {
  console.error(context ? `CodeMirror (${context}):` : "CodeMirror:", exception);
}
