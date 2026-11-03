// Every source file stays under 48 KB (aim for 32), because an agent's read
// tool stops near 50 KB: a larger file is read in parts, and its middle goes
// unread (AGENTS.md, rule 9). The files over the cap today are listed with
// their size. The list only shrinks: a listed file may not grow, and one that
// is under the cap again must leave it. Fixtures, assets and generated files
// don't count.

import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const CAP = 48 * 1024;

/** Made by a build, not read or edited by hand. */
const GENERATED = ["server/pages/inline-code.ts"];

/** The files over the cap, and their size in bytes when listed. Split one when you next touch it. */
const OVER: Record<string, number> = {
  "document/document.ts": 83687,
  "dev/mock-cloudflare.ts": 61295,
  "client/pages/pages-tree.ts": 57709,
};

/** The repo's tracked source files. */
function files(): string[] {
  const out = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT }).stdout.toString().trim().split("\n");
  return out.filter(
    (f) => /\.(ts|tsx|js|mjs|css|html|sql)$/.test(f) && !f.startsWith("e2e/fixtures/") && !f.startsWith("assets/") && !GENERATED.includes(f)
  );
}

test("every source file is under 48 KB, or listed and not growing", () => {
  const wrong: string[] = [];
  const all = files();
  for (const f of all) {
    let size: number;
    try {
      size = statSync(join(ROOT, f)).size;
    } catch {
      continue; // deleted in the working tree
    }
    const listed = OVER[f];
    if (listed == null && size > CAP) wrong.push(`${f} is ${size} bytes, over the cap of ${CAP}: split it along a real seam`);
    if (listed != null && size <= CAP) wrong.push(`${f} is ${size} bytes, under the cap now: take it off the list`);
    if (listed != null && size > listed) wrong.push(`${f} grew to ${size} bytes, over its listed ${listed}: split it, or make it smaller`);
  }
  for (const f of Object.keys(OVER)) if (!all.includes(f)) wrong.push(`${f} is listed but isn't in the repo: take it off the list`);
  expect(wrong).toEqual([]);
});
