// The format check on changed lines (dev/format.ts): a change inside code that Biome would wrap and indent again
// asks for its own lines only, at the file's indentation, never for the code around it.

import { expect, test } from "bun:test";
import { regions, touches } from "../dev/format.ts";

/** The file's lines after the format check's --write, for the changed lines (1-based). */
function written(before: string[], after: string[], changed: number[]) {
  const lines = [...before];
  for (const r of regions(before, after)
    .filter((r) => touches(r, new Set(changed)))
    .reverse())
    lines.splice(r.from, r.to - r.from, ...r.lines);
  return lines;
}

// A test whose first line is too long: Biome wraps it, so it indents the whole body by 2.
const file = [
  'test("a name long enough to wrap", { opts: true }, async () => {',
  "  const a = 1;",
  '  await until(async () => { const log = await get(); return log.ok; }, 5000, "it is ok");',
  "  const b = 2;",
  "});",
];
const biome = [
  "test(",
  '  "a name long enough to wrap",',
  "  { opts: true },",
  "  async () => {",
  "    const a = 1;",
  "    await until(",
  "      async () => {",
  "        const log = await get();",
  "        return log.ok;",
  "      },",
  "      5000,",
  '      "it is ok"',
  "    );",
  "    const b = 2;",
  "  }",
  ");",
];

test("a changed line inside code Biome would wrap: only that line is formatted, at the file's own indentation", () => {
  expect(written(file, biome, [3])).toEqual([
    file[0],
    "  const a = 1;",
    "  await until(",
    "    async () => {",
    "      const log = await get();",
    "      return log.ok;",
    "    },",
    "    5000,",
    '    "it is ok"',
    "  );",
    "  const b = 2;",
    "});",
  ]);
});

test("a line Biome would only indent again, unchanged, isn't asked for; nor is the wrapped line nobody changed", () => {
  expect(written(file, biome, [2, 4])).toEqual(file);
  expect(regions(file, biome).filter((r) => touches(r, new Set([2, 4])))).toEqual([]);
});

test("the line that is too long is formatted once it changes", () => {
  expect(written(file, biome, [1]).slice(0, 4)).toEqual([
    "test(",
    '  "a name long enough to wrap",',
    "  { opts: true },",
    "  async () => {",
  ]);
});
