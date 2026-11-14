// Three habits that tests must not pick up again, each checked in the tests' own text:
//
// - a fixed pause (`await sleep(150)`): it is slow when the code is fast and fails when the machine is busy. Wait for a
//   state: a loop with a condition (`until`, `expect.poll`). A pause of 0 ms (a tick) and a loop's own pause don't count.
// - `toMatchObject` with `expect.any(...)`: Bun 1.4.2 writes the matcher into the object it checks, and a later read
//   of that field gets `{}`. Check the fields with `toEqual` on a list.
// - a press at a place (`page.mouse.click(x, y)`, `mouse.down()`) on an element whose place was read before: on a busy
//   machine the element has moved by then, and the press lands beside it. Press the element: `pressOn` or `clickOn`
//   (e2e/helpers/press.ts). The ones listed press a place on purpose (text, a point of the page, a press held down).
//
// The files that have one today are listed with their count. A listed file may not get more, and no other file may
// get one. When you take one out, lower its number.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const PAUSE =
  /\bawait (?:Bun\.)?sleep\(\s*([\d_]+)\s*\)|\bawait new Promise(?:<\w+>)?\(\((\w+)\) => setTimeout\(\2, ([\d_]+)\)\)|\.waitForTimeout\(/g;

/** The fixed pauses of a test file's text: not a pause of 0 ms, and not one on a loop's own line. */
export function pauses(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (/\b(for|while) \(/.test(line)) continue;
    for (const m of line.matchAll(PAUSE)) if (Number((m[1] ?? m[3] ?? "1").replaceAll("_", "")) > 0) n++;
  }
  return n;
}

/** The `toMatchObject(...)` calls of the text that hold an `expect.any(`. */
export function matcherBugs(text: string): number {
  let n = 0;
  for (let at = text.indexOf(".toMatchObject("); at >= 0; at = text.indexOf(".toMatchObject(", at + 1)) {
    let depth = 0;
    let end = at + ".toMatchObject".length;
    do {
      if (text[end] == "(") depth++;
      else if (text[end] == ")") depth--;
      end++;
    } while (depth > 0 && end < text.length);
    if (text.slice(at, end).includes("expect.any(")) n++;
  }
  return n;
}

/** The presses at a place of a test file's text. */
export const presses = (text: string): number => text.match(/\bmouse\.(click|down)\(/g)?.length ?? 0;

const PRESSES: Record<string, number> = {
  "e2e/access/tokens.e2e.ts": 1,
  "e2e/agent/samples.ts": 1,
  "e2e/agent/tools.e2e.ts": 1,
  "e2e/comments/comments.ts": 1,
  "e2e/documents/list.e2e.ts": 1,
  "e2e/documents/tree.e2e.ts": 5,
  "e2e/editor/format.e2e.ts": 1,
  // (A button on a file's badge, in a shadow root of the page's frame: pressOn reaches the tab's own document.)
  "e2e/editor/steady-helpers.ts": 1,
  "e2e/editor/steady.e2e.ts": 1,
  "e2e/helpers/editor.ts": 2,
  "e2e/helpers/press.ts": 2,
  "e2e/homepage/homepage.e2e.ts": 1,
  "e2e/page-model/page-model.e2e.ts": 1,
  "e2e/shell/open.e2e.ts": 1,
  "e2e/shell/panels.e2e.ts": 1,
  "e2e/templates/templates.e2e.ts": 4,
  "e2e/templates/templates.ts": 2,
  "e2e/versions/versions.e2e.ts": 1,
  "e2e/viewer/reader.e2e.ts": 3,
};
const PAUSES: Record<string, number> = {
  "e2e/helpers/editor.ts": 1,
  "e2e/helpers/fixtures.ts": 1,
  "e2e/helpers/server.ts": 2,
  "tests/agent-turn.test.ts": 2,
  "tests/document.test.ts": 1,
  "tests/shared-helpers.test.ts": 1,
};
const MATCHERS: Record<string, number> = {
  "tests/comments.test.ts": 1,
};

const files = () =>
  Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "tests", "e2e"], { cwd: ROOT })
    .stdout.toString()
    .trim()
    .split("\n")
    .filter((f) => /\.ts$/.test(f) && !f.startsWith("e2e/fixtures/") && !f.startsWith("e2e/bench/") && f != "tests/test-habits.test.ts");

function over(count: (text: string) => number, listed: Record<string, number>): string[] {
  const wrong: string[] = [];
  for (const f of files()) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    const n = count(text);
    if (n > (listed[f] ?? 0)) wrong.push(`${f}: ${n}, and its limit is ${listed[f] ?? 0}`);
  }
  return wrong;
}

test("the counters see a fixed pause and the matcher bug, and not a loop's pause or a tick", () => {
  expect(
    pauses("await sleep(150);\n  await Bun.sleep(20);\nawait new Promise((r) => setTimeout(r, 50));\nawait page.waitForTimeout(100);")
  ).toBe(4);
  expect(
    pauses("for (let i = 0; i < 9 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));\nawait sleep(0);\nawait until(() => ok());")
  ).toBe(0);
  expect(matcherBugs("expect(a).toMatchObject({ id: expect.any(String) });\nexpect(a).toMatchObject({ n: fn(1) });")).toBe(1);
});

test("no test gets a new fixed pause: wait for a state", () => {
  expect(over(pauses, PAUSES)).toEqual([]);
});

test("no test gets a new press at a place: press the element (e2e/helpers/press.ts)", () => {
  expect(presses("await page.mouse.click(r.x, r.y);\nawait mouse.down();\nawait pressOn(page, sel);")).toBe(2);
  expect(over(presses, PRESSES)).toEqual([]);
});

test("no test gets a new toMatchObject with expect.any: use toEqual on a list", () => {
  expect(over(matcherBugs, MATCHERS)).toEqual([]);
});
