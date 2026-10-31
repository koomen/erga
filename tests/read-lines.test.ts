// read's pages of a big file (shared/text-edits.ts, readLines): as many whole lines as fit, not half of them.
import { expect, test } from "bun:test";
import { readLines } from "../shared/text-edits";

test("a 769-line page of 75K characters reads in two pages, each as full as fits", () => {
  const text = Array.from({ length: 769 }, (_, i) => `${String(i + 1).padStart(4, "0")} ${"x".repeat(92)}`).join("\n");
  const first = readLines(text, 1, 2000, 50 * 1024);
  expect(first).toEndWith("[Showing lines 1-522 of 769. Use offset=523 to continue.]");
  expect(readLines(text, 523, 2000, 50 * 1024)).toEndWith(`0769 ${"x".repeat(92)}`);
  expect(readLines(text, 1, 3, 50 * 1024)).toEndWith("[Showing lines 1-3 of 769. Use offset=4 to continue.]");
  // One line longer than the limit still comes whole.
  expect(readLines("y".repeat(100) + "\nz", 1, 10, 50)).toBe(`${"y".repeat(100)}\n\n[Showing lines 1-1 of 2. Use offset=2 to continue.]`);
});
