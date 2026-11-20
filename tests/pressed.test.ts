// client/common/pressed.ts: what is drawn again waits for a press on it to end.
//
// Was a bug, in three places (the alerts card, the file tree, a live list's rows): news from the server drew the
// element again between a press and its release. The press was on the old element and the release on the new one,
// so the browser gave no click: the button did nothing. With a process for each site the tests met it often.

import { expect, test } from "bun:test";
import { presses } from "../client/common/pressed";

function setup() {
  const target = new EventTarget();
  const later: (() => void)[] = [];
  const p = presses(target, (f) => later.push(f));
  const button = { contains: (n: unknown) => n === button };
  const card = { contains: (n: unknown) => n === card || n === button };
  const other = { contains: (n: unknown) => n === other };
  const fire = (type: string, on: object, button = 0, relatedTarget: object | null = null) => {
    const e = new Event(type);
    Object.defineProperty(e, "target", { value: on });
    Object.defineProperty(e, "button", { value: button });
    Object.defineProperty(e, "relatedTarget", { value: relatedTarget });
    target.dispatchEvent(e);
  };
  return { p, later, button, card, other, fire, target };
}

test("with no press, a draw runs at once", () => {
  const { p, card } = setup();
  let n = 0;
  p.afterPress(card as unknown as Node, () => n++);
  expect(n).toBe(1);
});

test("a draw during a press on the element waits for the release, and runs after the click", () => {
  const { p, later, button, card, fire } = setup();
  let n = 0;
  const draw = () => n++;
  fire("pointerdown", button);
  expect(p.pressedIn(card as unknown as Node)).toBe(true);
  p.afterPress(card as unknown as Node, draw);
  p.afterPress(card as unknown as Node, draw);
  expect(n).toBe(0);
  fire("pointerup", button);
  // The release: the element is free again, and the draw comes later, after the browser's click.
  expect(p.pressedIn(card as unknown as Node)).toBe(false);
  expect(n).toBe(0);
  later.splice(0).forEach((f) => f());
  // Asked two times, drawn one time.
  expect(n).toBe(1);
});

test("a press elsewhere holds nothing back; a press that a drag takes, or a window that loses the focus, ends too", () => {
  const { p, later, button, card, other, fire, target } = setup();
  let n = 0;
  fire("pointerdown", other);
  p.afterPress(card as unknown as Node, () => n++);
  expect(n).toBe(1);
  fire("pointerup", other);
  fire("pointerdown", button);
  p.afterPress(card as unknown as Node, () => n++);
  fire("pointercancel", button);
  later.splice(0).forEach((f) => f());
  expect(n).toBe(2);
  for (const [end, on] of [
    ["dragend", button],
    ["blur", target],
  ] as const) {
    fire("pointerdown", button);
    expect(p.pressedIn(card as unknown as Node)).toBe(true);
    fire(end, on);
    expect(p.pressedIn(card as unknown as Node)).toBe(false);
  }
});

test("a press of another button than the main one holds nothing back: it gives no click, and its release may never come", () => {
  const { p, button, card, fire } = setup();
  let n = 0;
  fire("pointerdown", button, 2);
  expect(p.pressedIn(card as unknown as Node)).toBe(false);
  p.afterPress(card as unknown as Node, () => n++);
  expect(n).toBe(1);
});

// Was a bug: a real press moves the focus to the button, and the row that had it says blur. That ended the wait.
test("the blur of the element that had the focus, as the press takes it, does not end the press", () => {
  const { p, later, button, card, other, fire } = setup();
  let n = 0;
  fire("pointerdown", button);
  fire("blur", other);
  expect(p.pressedIn(card as unknown as Node)).toBe(true);
  p.afterPress(card as unknown as Node, () => n++);
  expect(n).toBe(0);
  fire("pointerup", button);
  later.splice(0).forEach((f) => f());
  expect(n).toBe(1);
});

// Was a bug: files from the computer over a folder of the tree, then news. The rows were drawn again, the drop went to
// the row that was gone, and no file was added.
test("a drag over the element holds a draw until the drop; a drag that leaves the window ends too, one that goes on to another element does not", () => {
  const { p, later, button, card, other, fire } = setup();
  let n = 0;
  fire("dragover", button);
  expect(p.pressedIn(card as unknown as Node)).toBe(true);
  p.afterPress(card as unknown as Node, () => n++);
  // (On to another element of the page: the drag is still on.)
  fire("dragleave", button, 0, other);
  expect(p.pressedIn(card as unknown as Node)).toBe(true);
  expect(n).toBe(0);
  fire("drop", button);
  expect(p.pressedIn(card as unknown as Node)).toBe(false);
  later.splice(0).forEach((f) => f());
  expect(n).toBe(1);
  fire("dragover", button);
  fire("dragleave", button);
  expect(p.pressedIn(card as unknown as Node)).toBe(false);
});
