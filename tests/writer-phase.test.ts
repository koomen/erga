// The pill that tells a reader who writes (client/common/writer-phase.ts): its state, apart from timers and the page.
import { expect, test } from "bun:test";
import { writerName, writerStep, writerText, type WriterPhase } from "../client/common/writer-phase.ts";

test("changes keep it at writing; the quiet after the last one says Updated now; then it goes", () => {
  let p: WriterPhase = { at: "none" };
  const first = writerStep(p, { type: "change", by: "Claude Code" });
  expect([writerText(first.phase), first.effects]).toEqual(["Claude Code is writing…", [{ wait: "quiet", n: 1 }]]);
  const second = writerStep(first.phase, { type: "change", by: "Claude Code" });
  expect(second.effects).toEqual([{ wait: "quiet", n: 2 }]);
  // The first wait's end counts for nothing: a change came after it began.
  p = writerStep(second.phase, { type: "quiet", n: 1 }).phase;
  expect(writerText(p)).toBe("Claude Code is writing…");
  const quiet = writerStep(p, { type: "quiet", n: 2 });
  expect([writerText(quiet.phase), quiet.effects]).toEqual(["Updated now", [{ wait: "done", n: 2 }]]);
  expect(writerText(writerStep(quiet.phase, { type: "done", n: 2 }).phase)).toBeNull();
  // A change while it says Updated now: writing again.
  expect(writerText(writerStep(quiet.phase, { type: "change", by: "ada" }).phase)).toBe("ada is writing…");
});

test("an agent shows by its connection's name, the person's own agent as theirs, a person as they are", () => {
  expect(writerName("koomen, via a shared agent (Claude Code (erga))")).toBe("Claude Code");
  expect(writerName("koomen, via their agent")).toBe("koomen’s agent");
  expect(writerName("koomen, via a shared agent (no label)")).toBe("koomen’s agent");
  expect(writerName("ada")).toBe("ada");
});
