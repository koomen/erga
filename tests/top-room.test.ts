// Where the viewer seats a page's frame, and what its bars and the agent's panel cover of a frame over the whole window
// (client/common/top-room.ts).

import { expect, test } from "bun:test";
import { insetOf, seatOf } from "../client/common/top-room";

test("a page that takes the inset itself has the whole window; one that fills the window is below the band; a scrolling page is under the bars", () => {
  expect(seatOf(false, false)).toBe("under");
  expect(seatOf(true, false)).toBe("below");
  expect(seatOf(true, true)).toBe("whole");
  expect(seatOf(false, true)).toBe("whole");
});

test("the inset is the band at the top and the agent's panel's room at its side", () => {
  expect(insetOf(56, 412, 0, 1, false)).toEqual({ top: 56, right: 0, bottom: 0, left: 412 });
  expect(insetOf(56, 0, 412, 1, false)).toEqual({ top: 56, right: 412, bottom: 0, left: 0 });
});

test("the inset is in the page's pixels at the editor's zoom, and nothing in full screen", () => {
  expect(insetOf(56, 412, 0, 2, false)).toEqual({ top: 28, right: 0, bottom: 0, left: 206 });
  expect(insetOf(56, 412, 0, 1, true)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  expect(insetOf(NaN, -4, 0, 0, false)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
});
