// A feedback's context (shared/feedback-context.ts): the keys pressed last as the steps of `bun run look`, and the
// page's HTML near the caret, inside what a context keeps.

import { expect, test } from "bun:test";
import { CONTEXT_LINES, CONTEXT_MAX, KEYS_KEPT, lookSteps, type Pressed, pressedWith, sourceNear } from "../shared/feedback-context";

const key = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}): Pressed => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const typed = (text: string) => [...text].map((c) => key(c, { shiftKey: c != c.toLowerCase() }));

test("the keys are the steps of bun run look: text typed, each other key pressed, with its modifiers and its count", () => {
  const keys = [
    key("Shift"),
    ...typed("- Milk"),
    key("Enter"),
    ...typed("Eggs"),
    key("Tab"),
    key("Backspace"),
    key("Backspace"),
    key("Backspace"),
    key("Tab", { shiftKey: true }),
    key("Meta"),
    key("b", { metaKey: true }),
    key("Z", { metaKey: true, shiftKey: true }),
    key("ArrowLeft", { altKey: true }),
    ...typed("it's"),
  ];
  expect(lookSteps(keys, true)).toBe(
    `'type:- Milk' Enter type:Eggs Tab Backspace*3 Shift+Tab ControlOrMeta+b ControlOrMeta+Shift+z Alt+ArrowLeft 'type:it'\\''s'`
  );
  // Off a Mac the command key is Control, and ⌘ is another key.
  expect(lookSteps([key("b", { ctrlKey: true }), key("b", { metaKey: true })], false)).toBe("ControlOrMeta+b Meta+b");
  expect(lookSteps([key("a", { ctrlKey: true })], true)).toBe("Control+a");
  expect(lookSteps([], true)).toBe("");
});

test("text that the page takes for a key is that key; text with no key of its own is typed text; the oldest keys go", () => {
  let keys: Pressed[] = [];
  // A person's key, then the text it gave; a phone's keyboard, which names no key; a key that gave no text.
  for (const k of [key("a"), { text: "a" }, key("Unidentified"), { text: "bc" }, key("d"), key("Enter"), { text: "" }])
    keys = pressedWith(keys, k);
  expect(lookSteps(keys, true)).toBe("type:abcd Enter");
  for (let i = 0; i < KEYS_KEPT + 5; i++) keys = pressedWith(keys, key("Tab"));
  expect([keys.length, lookSteps(keys, true)]).toEqual([KEYS_KEPT, `Tab*${KEYS_KEPT}`]);
});

test("the HTML near the caret: its line with the lines around it, and where it starts; a long line is cut on both sides", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `<p>Line ${i + 1}</p>`);
  const source = lines.join("\n");
  const at = source.indexOf("Line 20") + 4;
  const near = sourceNear(source, at);
  expect(near).toEqual({
    html: lines.slice(19 - CONTEXT_LINES, 20 + CONTEXT_LINES).join("\n"),
    htmlFrom: 20 - CONTEXT_LINES,
    line: 20,
    column: 8,
  });
  // At the start and at the end: what there is.
  expect(sourceNear(source, 0)).toMatchObject({ htmlFrom: 1, line: 1, column: 1, html: lines.slice(0, CONTEXT_LINES + 1).join("\n") });
  expect(sourceNear(source, source.length + 9)).toMatchObject({ htmlFrom: 40 - CONTEXT_LINES, line: 40 });
  // A page on one line: the part around the caret only.
  const one = `<p>${"x".repeat(20_000)}HERE${"y".repeat(20_000)}</p>`;
  const cut = sourceNear(one, one.indexOf("HERE"));
  expect(cut.html.length).toBe(CONTEXT_MAX.html + 10);
  expect(cut.html).toMatch(/^\[\.\.\.\]x+HEREy+\[\.\.\.\]$/);
  expect([cut.htmlFrom, cut.line]).toEqual([1, 1]);
});
