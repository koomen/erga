// Why an agent's turn ended with no reply (shared/agent-log.ts, turnEnded): a comment's thread says it.

import { expect, test } from "bun:test";
import { turnEnded, type Log } from "../shared/agent-log.ts";

const log = (...items: Log["items"]): Log => ({ items, busy: false, undoable: 0 });

test("a turn's end says why there's no reply: an error, a call that waits for the person, or none", () => {
  const user = { kind: "user", text: "@erga x" } as const;
  expect(turnEnded(log({ kind: "error", text: "old." }, user, { kind: "assistant", text: "Done." }))).toBe(
    "Its turn ended with no reply here."
  );
  expect(turnEnded(log(user, { kind: "error", text: "The model is overloaded." }))).toBe("It stopped: The model is overloaded.");
  expect(turnEnded(log(user, { kind: "tool", id: "1", name: "edit", path: null, status: "asking" }))).toBe(
    "It waits for your answer in your agent panel."
  );
});
