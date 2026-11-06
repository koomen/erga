// A document's room through its life (document/phase.ts): each call does one clear thing in each phase, and a
// call while the document goes never opens it again.

import { expect, test } from "bun:test";
import { next, type Phase } from "../document/phase";

type O = { room: number };
const room: O = { room: 1 };
const load = Promise.resolve<O | null>(room);
const done = Promise.resolve();

test("closed, opening, open, closing, closed: a call loads, awaits the load, uses the room, or waits for the close", () => {
  let p: Phase<O> = { is: "closed" };
  expect(next(p, { on: "use" }).do).toEqual({ do: "load" });
  p = next(p, { on: "load", load }).phase;
  expect(next(p, { on: "use" }).do).toEqual({ do: "await", load });
  // A second load can't start while one is under way.
  expect(next(p, { on: "load", load: Promise.resolve(null) }).phase).toBe(p);
  p = next(p, { on: "loaded", opened: room }).phase;
  expect(next(p, { on: "use" }).do).toEqual({ do: "use", opened: room });
  p = next(p, { on: "closing", done }).phase;
  expect(next(p, { on: "use" }).do).toEqual({ do: "wait", done });
  p = next(p, { on: "closed" }).phase;
  expect(p).toEqual({ is: "closed" });
});

test("a load that finds no document, or fails, leaves it closed: the next call tries again", () => {
  const p = next<O>({ is: "opening", load }, { on: "loaded", opened: null }).phase;
  expect(p).toEqual({ is: "closed" });
  expect(next(p, { on: "use" }).do).toEqual({ do: "load" });
});

test("destroying: a call is refused, a load that ends meanwhile doesn't open it, and the teardown gets the room", async () => {
  const open: Phase<O> = { is: "open", opened: room };
  const d = next(open, { on: "destroy" }).do!;
  expect(d.do).toBe("teardown");
  expect(await (d as { room: Promise<O | null> }).room).toBe(room);
  const opening = next<O>({ is: "opening", load }, { on: "destroy" }).do as { room: Promise<O | null> };
  expect(await opening.room).toBe(room);

  let p = next(open, { on: "destroying", done }).phase;
  expect(next(p, { on: "use" }).do).toEqual({ do: "refuse" });
  expect(next(p, { on: "loaded", opened: room }).phase).toBe(p);
  expect(next(p, { on: "load", load }).phase).toBe(p);
  expect(next(p, { on: "closed" }).phase).toBe(p);
  // A second destroy waits for the first.
  expect(next(p, { on: "destroy" }).do).toEqual({ do: "wait", done });
  p = next(p, { on: "destroyed" }).phase;
  expect(p).toEqual({ is: "closed" });
});
