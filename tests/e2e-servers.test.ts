// An end-to-end test file starts the dev servers it uses at its top level, as the worker imports it (e2e/helpers/
// fixtures.ts). A server that starts first inside a test counts against the test's 15 s: under load a cold start takes
// longer, and the test fails at about:blank.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
/** Files that may start their server inside the test, and why. */
const EXEMPT: Record<string, string> = {
  "e2e/bench/agent-live.e2e.ts": "it skips itself without a key, and must start nothing then",
  "e2e/bench/structural.e2e.ts": "a benchmark, not in the suite",
};

test("every e2e file that uses servers.* starts one at its top level", () => {
  const late: string[] = [];
  for (const path of new Glob("e2e/**/*.e2e.ts").scanSync(ROOT)) {
    if (EXEMPT[path]) continue;
    const src = readFileSync(join(ROOT, path), "utf8");
    if (!/\bservers\.\w+\(/.test(src)) continue;
    if (!/^(?:await |(?:const|let) [^=]+= await )/m.test(src)) late.push(path);
  }
  expect(late).toEqual([]);
});
