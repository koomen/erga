// The frame's page was refused (client/common/pass-refused.ts): `step` alone.
import { expect, test } from "bun:test";
import { type Refused, type RefusedEvent, step } from "../client/common/pass-refused";

const run = (s: Refused, ...events: RefusedEvent[]) => {
  const effects: string[] = [];
  for (const e of events) {
    const next = step(s, e);
    s = next.state;
    effects.push(...next.effects);
  }
  return { state: s, effects };
};
const refused: RefusedEvent = { type: "refused", again: false };

test("a refused pass: the viewer asks the server for the page one time, and loads it", () => {
  expect(run("ok", refused)).toEqual({ state: "asking", effects: ["ask"] });
  // (The frame says it again meanwhile: one request.)
  expect(run("ok", refused, refused, { type: "fresh" })).toEqual({ state: "ok", effects: ["ask", "load"] });
});

test("the server gives no page: the page says so; Try again asks again, and loads the page that comes", () => {
  const failed = run("ok", refused, { type: "none" });
  expect(failed).toEqual({ state: "failed", effects: ["ask", "say"] });
  expect(run(failed.state, refused).effects).toEqual([]);
  expect(run(failed.state, { type: "retry" }, { type: "fresh" })).toEqual({ state: "ok", effects: ["ask", "load"] });
});

test("the page that just loaded again is refused too: it says so, and loads nothing more by itself", () => {
  expect(run("ok", { type: "refused", again: true })).toEqual({ state: "failed", effects: ["say"] });
});
