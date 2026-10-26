// The format check on changed lines (dev/format.ts): a change inside code that Biome would wrap and indent again
// asks for its own lines only, at the file's indentation, never for the code around it; and it never drops code.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { apply, parts, regions, touches } from "../dev/format.ts";

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

/** The text as Biome formats it (biome.json). */
const biomeOf = (text: string) => {
  const root = join(import.meta.dirname, "..");
  const r = spawnSync(join(root, "node_modules/.bin/biome"), ["format", "--stdin-file-path=a.ts"], {
    cwd: root,
    input: text,
    encoding: "utf8",
  });
  return r.status == 0 ? r.stdout : undefined;
};

// The share_document tool, as a format run on 2026-10-25 found it: the login line changed. Biome wraps the login and
// the role lines both, and a line diff pairs the file's "})," of Type.Object with Biome's "})," of login's
// Type.String. The region of the changed line then ends at login, and the role line comes back only in the next
// region, which no changed line meets.
const tool = [
  "export const tool = {",
  "  parameters: Type.Object({",
  "    document: DOCUMENT,",
  `    login: Type.String({ description: "Whose role to set: a GitHub login, or \\"*\\" for anyone with the link (only while the server lets users share content publicly)" }),`,
  '    role: Type.Union([Type.Literal("editor"), Type.Literal("viewer"), Type.Literal("none")], { description: "editor, viewer, or none to stop sharing it with them" }),',
  "  }),",
  "  run: async (args) => {",
  "    return args.role;",
  "  },",
  "};",
  "",
];

test("a change Biome rewrites together with the lines beside it: no code is dropped", () => {
  const pretty = biomeOf(tool.join("\n"))!;
  const todo = parts(tool, pretty.split("\n"), new Set([4]), biomeOf);
  expect(todo).toBeDefined();
  const lines = apply(tool, todo!);
  expect(lines.join("\n")).toContain("role: Type.Union(");
  expect(biomeOf(lines.join("\n"))).toBe(pretty);
});

test("the regions of the changed line alone would drop the role line (the reason for the check)", () => {
  const after = biomeOf(tool.join("\n"))!.split("\n");
  const alone = apply(
    tool,
    regions(tool, after).filter((r) => touches(r, new Set([4])))
  );
  expect(alone.join("\n")).not.toContain("role:");
});

test("when no part of Biome's text keeps the code, nothing is written", () => {
  // A format that never agrees: as if each way of writing the parts changed the code.
  expect(parts(tool, biomeOf(tool.join("\n"))!.split("\n"), new Set([4]), () => "")).toBeUndefined();
});
