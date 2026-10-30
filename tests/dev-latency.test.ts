// The dev server's delay on the room's sockets (dev/latency.ts): its setting. (The order of the delayed chunks is
// e2e/full/page/dev-latency.e2e.ts's: it breaks only under Node's timers, where the dev server runs.)

import { expect, test } from "bun:test";
import { latencyOf } from "../dev/latency.ts";

test("the setting is a delay or a range in ms; anything else is none", () => {
  expect(latencyOf("120")).toEqual([120, 120]);
  expect(latencyOf("60-180")).toEqual([60, 180]);
  for (const s of [undefined, "", "0", "fast", "180-60"]) expect(latencyOf(s)).toBeNull();
});
