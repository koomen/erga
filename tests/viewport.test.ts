// Visual-viewport keyboard tracking (client/common/viewport.ts): verifies `--vv-top`, `--kb`, and `kbOpen` across
// iOS Safari overlay, iOS Safari visualViewport pan, Android resize, and browser pinch-zoom states.

import { expect, test } from "bun:test";
import { viewportVars } from "../client/common/viewport";

test("viewportVars keeps fixed panels inside the visual viewport across overlay, panned, and resized keyboards", () => {
  // Resting full screen: no keyboard offset.
  expect(viewportVars({ innerHeight: 660, vvHeight: 660, vvOffsetTop: 0, vvScale: 1 })).toEqual({
    vvTop: 0,
    kb: 0,
    kbOpen: false,
  });
  // iOS Safari overlays a 300 px keyboard without panning offsetTop: bottom rises by 300 px.
  expect(viewportVars({ innerHeight: 660, vvHeight: 360, vvOffsetTop: 0, vvScale: 1 })).toEqual({
    vvTop: 0,
    kb: 300,
    kbOpen: true,
  });
  // iOS Safari pans offsetTop all the way down (300 px): vvTop tracks the top edge while kb drops to 0, so height stays 360 px.
  expect(viewportVars({ innerHeight: 660, vvHeight: 360, vvOffsetTop: 300, vvScale: 1 })).toEqual({
    vvTop: 300,
    kb: 0,
    kbOpen: true,
  });
  // iOS Safari partial pan (140 px): top + bottom insets sum to the 300 px keyboard obstruction.
  expect(viewportVars({ innerHeight: 660, vvHeight: 360, vvOffsetTop: 140, vvScale: 1 })).toEqual({
    vvTop: 140,
    kb: 160,
    kbOpen: true,
  });
  // Android Chrome shrinks innerHeight directly: no extra offsets needed.
  expect(viewportVars({ innerHeight: 360, vvHeight: 360, vvOffsetTop: 0, vvScale: 1 })).toEqual({
    vvTop: 0,
    kb: 0,
    kbOpen: false,
  });
  // Small Safari address-bar delta (<= 80 px) does not flip compact kbOpen mode.
  expect(viewportVars({ innerHeight: 660, vvHeight: 620, vvOffsetTop: 0, vvScale: 1 })).toEqual({
    vvTop: 0,
    kb: 40,
    kbOpen: false,
  });
  // Browser pinch-zoomed in (vvScale > 1.01): ignore visualViewport shrinkage so fixed UI doesn't jump.
  expect(viewportVars({ innerHeight: 660, vvHeight: 528, vvOffsetTop: 40, vvScale: 1.25 })).toEqual({
    vvTop: 0,
    kb: 0,
    kbOpen: false,
  });
});
