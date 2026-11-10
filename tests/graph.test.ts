// dev/graph.ts: the unit tests that a change reaches, in a small tree of files.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reached, sourceFiles } from "../dev/graph";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "erga-graph-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a change reaches the tests that import the file, through other files, and the tests that name it", () => {
  const root = tree({
    "shared/a.ts": "export const a = 1;",
    "shared/b.ts": 'import { a } from "./a";\nexport const b = a;',
    "server/area/index.ts": 'export * from "../../shared/b.ts";',
    "server/alone.ts": "export const c = 3;",
    "tests/direct.test.ts": 'import { a } from "../shared/a";',
    "tests/through.test.ts": 'import type { b } from "../server/area";',
    "tests/dynamic.test.ts": 'const m = await import("../shared/b");',
    "tests/reads.test.ts": 'readFileSync(join(ROOT, "docs/rules.md"));',
    "tests/other.test.ts": 'import { c } from "../server/alone";\nimport { expect } from "bun:test";',
    "node_modules/pkg/index.ts": "",
    "worktrees/task/tests/copy.test.ts": "",
  });
  const tests = sourceFiles(root).filter((f) => f.startsWith("tests/"));
  expect(tests.sort()).toEqual([
    "tests/direct.test.ts",
    "tests/dynamic.test.ts",
    "tests/other.test.ts",
    "tests/reads.test.ts",
    "tests/through.test.ts",
  ]);
  expect([...reached(tests, ["shared/a.ts"], root)].sort()).toEqual([
    ["tests/direct.test.ts", "imports shared/a.ts"],
    ["tests/dynamic.test.ts", "imports shared/a.ts"],
    ["tests/through.test.ts", "imports shared/a.ts"],
  ]);
  expect([...reached(tests, ["docs/rules.md", "tests/other.test.ts"], root)].sort()).toEqual([
    ["tests/other.test.ts", "changed"],
    ["tests/reads.test.ts", "reads docs/rules.md"],
  ]);
  expect(reached(tests, ["server/unknown.ts"], root).size).toBe(0);
});
