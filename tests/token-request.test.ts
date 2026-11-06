// The machine of a request for a token (server/identity/token-request.ts): each event from each state, with no IO.

import { expect, test } from "bun:test";
import { step } from "../server/identity/token-request.ts";

const waiting = { status: "waiting" as const, expired: false };
const approved = { status: "approved" as const, expired: false };

test("a waiting request is approved (mint) or denied (gone) once; a poll leaves it waiting", () => {
  expect(step(waiting, "approve")).toEqual({ to: "approved", effect: "mint" });
  expect(step(waiting, "deny")).toEqual({ to: "gone", effect: null });
  expect(step(waiting, "collect")).toBeNull();
  expect(step(waiting, "lapse")).toBeNull();
});

test("an approved request is collected once (hand over), and can't be approved or denied again", () => {
  expect(step(approved, "collect")).toEqual({ to: "gone", effect: "hand_over" });
  expect(step(approved, "approve")).toBeNull();
  expect(step(approved, "deny")).toBeNull();
  expect(step(approved, "lapse")).toBeNull();
});

test("past its time, a request goes, and an approved one's token is revoked: nobody collected it", () => {
  for (const event of ["lapse", "collect"] as const) {
    expect(step({ ...waiting, expired: true }, event)).toEqual({ to: "gone", effect: null });
    expect(step({ ...approved, expired: true }, event)).toEqual({ to: "gone", effect: "revoke" });
  }
  for (const event of ["approve", "deny"] as const) {
    expect(step({ ...waiting, expired: true }, event)).toBeNull();
    expect(step({ ...approved, expired: true }, event)).toBeNull();
  }
});
