// ./test.sh --changed picks its tests with tests/changed.ts: every test test.sh runs says what it covers, and a
// change picks the tests that cover it.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { coversOf, matches, select, SHARED, suiteTests, unitTests } from "./changed";

const tracked = spawnSync("git", ["ls-files"], { cwd: `${import.meta.dirname}/..`, encoding: "utf8" }).stdout.split("\n").filter(Boolean);

test("every test test.sh runs has a covers line, and each of its patterns names files that are there", () => {
  const suite = suiteTests();
  expect(suite.length).toBeGreaterThan(30);
  const missing = suite.filter((t) => !coversOf(t));
  expect(missing).toEqual([]);
  const stale = suite.flatMap((t) => coversOf(t)!.filter((p) => !tracked.some((f) => matches(p, f))).map((p) => `${t}: ${p}`));
  expect(stale).toEqual([]);
  expect(SHARED.filter((f) => !tracked.includes(f) && f != "tests/changed.ts")).toEqual([]);
});

test("a change picks the tests that cover it: by covers line, by a unit test's imports, by the test itself", () => {
  const r = select(["factory/vm/common.ts"]);
  expect(r.all).toBeNull();
  expect(r.tests).toContain("tests/factory.ts");
  expect(r.tests).toContain("tests/factory.test.ts");
  expect(r.tests).not.toContain("tests/page.ts");
  expect(r.tests).not.toContain("tests/tree.ts");
  expect(select(["src/page/tree.ts"]).tests).toContain("tests/tree.ts");
  expect(select(["templates/slides/index.html"]).tests).toContain("tests/slides.ts");
  expect(select(["tests/tree.ts"]).tests).toEqual(["tests/tree.ts"]);
  expect(select(["tests/changed.test.ts"]).tests).toEqual(["tests/changed.test.ts"]);
});

test("a change to shared infrastructure picks every test; a file no test covers is named", () => {
  const all = select(["test.sh", "front.ts"]);
  expect(all.all).toBe("test.sh");
  expect(all.tests.length).toBe(suiteTests().length + unitTests().length);
  const docs = select(["README.md"]);
  expect(docs.tests).toEqual([]);
  expect(docs.uncovered).toEqual(["README.md"]);
});
