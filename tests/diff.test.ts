// shared/diff.ts: the diffs the package `diff` made before (checked against it on 5000 random texts).

import { expect, test } from "bun:test";
import { diffLists, diffWords, unifiedPatch } from "../shared/diff";

test("a unified patch, as diff -u writes it", () => {
  expect(unifiedPatch("a/x", "b/x", "a\nb\nc\nd\n", "a\nB\nc\nd")).toBe(
    "--- a/x\n+++ b/x\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n-d\n+d\n\\ No newline at end of file\n"
  );
  expect(unifiedPatch("/dev/null", "b/x", "", "new\n")).toBe("--- /dev/null\n+++ b/x\n@@ -0,0 +1,1 @@\n+new\n");
  // Changes far apart are hunks of their own.
  const far = (s: string) => ["1", s, ...Array.from({ length: 10 }, (_, i) => `${i}`), s].join("\n");
  expect(unifiedPatch("a", "b", far("x"), far("y"), 1).match(/^@@/gm)).toHaveLength(2);
});

test("a word diff keeps the spaces, and removals come before additions", () => {
  expect(diffWords("the quick fox", "the quack  fox")).toEqual([
    { value: "the " },
    { value: "quick ", removed: true },
    { value: "quack  ", added: true },
    { value: "fox" },
  ]);
});

test("a diff of more edits than allowed gives up", () => {
  expect(
    diffLists(
      [...Array(50).keys()],
      [...Array(50).keys()].map((n) => -n - 1),
      { maxEdits: 20 }
    )
  ).toBeUndefined();
  expect(diffLists([" a", "b"], ["a", "c"], { equal: (x, y) => x.trim() == y.trim() })).toEqual([
    { value: [" a"] },
    { value: ["b"], removed: true },
    { value: ["c"], added: true },
  ]);
});
