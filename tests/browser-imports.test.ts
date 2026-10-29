// The browser's bundles (client/build.ts's entries, and the chunks they import later) import a few modules
// outside client/: shared/ and the document's content, pages, merge and
// API types. Those must stay free of server and Cloudflare code: this test
// follows every value import from the entries and fails on one that reaches
// server/, cloudflare/, agents/, agents/document/, deploy/ or dev/, or a file of
// document/ the browser isn't meant to have. Type-only imports are erased by
// the bundler, so they may come from anywhere. A second test fails on a value
// import of effect from any file the browser has: the server's code uses
// Effect, the browser never does (its bundles stay small).

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { expect, test } from "bun:test";
import { ENTRIES as BUILT } from "../client/build.ts";

const ROOT = resolve(import.meta.dir, "..");
const ENTRIES = Object.values(BUILT);
/** Outside client/ and shared/, the files the browser may have. */
const ALLOWED = new Set(["document/content.ts", "document/pages.ts", "document/merge.ts"]);

/** The specifiers of a file's value imports (`import type` and `export type` left out), and of its import()s; with `bare`, the packages' too. */
function valueImports(source: string, bare = false): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
  for (const m of source.matchAll(re)) {
    const spec = m[4] ?? m[5] ?? m[6];
    if (!spec || (!bare && !spec.startsWith("."))) continue;
    if (m[2]) continue;
    out.push(spec);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}/index.ts`]) if (existsSync(c) && !c.endsWith("/")) return c;
  return null;
}

/** Every file the browser's bundles reach from their entries, and who imported it first. */
function reached(): Map<string, string> {
  const seen = new Map<string, string>();
  const queue: [string, string][] = ENTRIES.map((e) => [resolve(ROOT, e), "an entry"]);
  while (queue.length) {
    const [file, by] = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, by);
    for (const spec of valueImports(readFileSync(file, "utf8"))) {
      const target = resolveImport(file, spec);
      if (!target) throw new Error(`${relative(ROOT, file)}: can't resolve "${spec}"`);
      if (!target.endsWith(".ts")) continue;
      queue.push([target, relative(ROOT, file)]);
    }
  }
  return seen;
}

test("the browser's bundles import nothing of the server, Cloudflare, the agents, the deploy or the dev server", () => {
  const outside = [...reached()]
    .map(([f, by]) => [relative(ROOT, f), by] as const)
    .filter(([f]) => !f.startsWith("client/") && !f.startsWith("shared/"));
  const wrong = outside.filter(([f]) => !ALLOWED.has(f));
  expect(wrong.map(([f, by]) => `${f} (imported by ${by})`)).toEqual([]);
  // What the browser has of document/: the list above, so a new one is a decision.
  expect(outside.map(([f]) => f).sort()).toEqual([...ALLOWED].sort());
});

test("the browser's bundles never import effect", () => {
  // client/'s files too: the inline scripts (build.ts --inline) aren't entries.
  const files = new Set([...reached().keys(), ...new Bun.Glob("client/**/*.ts").scanSync({ cwd: ROOT, absolute: true })]);
  const wrong = [...files].flatMap((f) =>
    valueImports(readFileSync(f, "utf8"), true)
      .filter((s) => s == "effect" || s.startsWith("effect/") || s.startsWith("@effect/"))
      .map((s) => `${relative(ROOT, f)}: ${s}`)
  );
  expect(wrong).toEqual([]);
});
