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
  const fire = (type: string, on: object) => {
    const e = new Event(type);
    Object.defineProperty(e, "target", { value: on });
    target.dispatchEvent(e);
  };
  return { p, later, button, card, other, fire };
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
  const { p, later, button, card, other, fire } = setup();
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
  for (const end of ["dragend", "blur"]) {
    fire("pointerdown", button);
    expect(p.pressedIn(card as unknown as Node)).toBe(true);
    fire(end, button);
    expect(p.pressedIn(card as unknown as Node)).toBe(false);
  }
});
