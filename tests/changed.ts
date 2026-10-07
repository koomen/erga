#!/usr/bin/env bun
// Which tests cover a change (./test.sh --changed uses it):
//
//   bun tests/changed.ts                  the test files that cover the files changed since staging, one a line
//   bun tests/changed.ts FILE...          the test files that cover these files
//
// What changed: the files that differ from where this branch left staging (TEST_BASE, else origin/staging, else
// staging, else main), committed or not, and new files git doesn't ignore.
//
// What covers what:
//   - a test that test.sh runs (tests/x.ts: each starts servers of its own, so its imports say little) names what it
//     covers in a header line, `// covers: front.ts src/page/tree.ts templates/`: a file, a folder (ending in /) or
//     a glob. It covers those, itself, and the files under tests/ it imports;
//   - a unit test (tests/*.test.ts) covers everything it imports, through the repository;
//   - a change to shared infrastructure (SHARED: the test harness, the build, the server's core) needs every test.
// stderr says what changed, what was picked and why, and the changed files no test covers.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");

/** Changes that need the whole suite. */
export const SHARED = [
  "test.sh", "site.sh", "build.sh", "package.json", "bun.lock", ".bun-version", "tsconfig.json", "worker/tsconfig.json",
  "vite.config.ts", "cloudflare.config.ts", "dev.ts", "dev/plugin.ts", "worker/index.ts", "worker/env.ts", "worker/platform.ts",
  "tests/host.ts", "tests/cdp.ts", "tests/cores.ts", "tests/suite/harness.ts", "tests/changed.ts",
];

/** The test files test.sh runs (its `run` lines), in its order, each once. */
export function suiteTests(root = ROOT): string[] {
  const out: string[] = [];
  for (const line of readFileSync(join(root, "test.sh"), "utf8").split("\n")) {
    const m = /^run \d+ \S+ bun (tests\/\S+\.ts)/.exec(line);
    if (m && !m[1].endsWith(".test.ts") && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export const unitTests = (root = ROOT) => readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => `tests/${f}`);

/** A test's `// covers:` patterns (null: it has no such line). */
export function coversOf(file: string, root = ROOT): string[] | null {
  const m = /^\/\/ covers: (.+)$/m.exec(readFileSync(join(root, file), "utf8"));
  return m ? m[1].trim().split(/\s+/) : null;
}

export function matches(pattern: string, file: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (pattern.includes("*")) return new Bun.Glob(pattern).match(file);
  return file == pattern;
}

/** The repository's files that `file` imports, and those they import (only under `within`, when given). */
export function importsOf(file: string, root = ROOT, within?: string): Set<string> {
  const seen = new Set<string>();
  const walk = (f: string) => {
    let src: string;
    try { src = readFileSync(join(root, f), "utf8"); } catch { return; }
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const dep = resolveImport(join(dirname(f), m[1]), root);
      if (!dep || seen.has(dep) || (within && !dep.startsWith(within))) continue;
      seen.add(dep);
      if (/\.(ts|js|mjs)$/.test(dep)) walk(dep);
    }
  };
  walk(file);
  return seen;
}

function resolveImport(path: string, root: string): string | null {
  for (const p of [path, `${path}.ts`, `${path}.js`, join(path, "index.ts")]) if (existsSync(join(root, p)) && !p.endsWith("/")) return relative(root, join(root, p)) || null;
  return null;
}

/** The files changed since this branch left the base, committed or not, and new ones. */
export function changedFiles(root = ROOT): { base: string; files: string[] } {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  const ref = [process.env.TEST_BASE, "origin/staging", "staging", "main"].find((r) => r && git("rev-parse", "--verify", "-q", `${r}^{commit}`).status == 0);
  if (!ref) throw new Error("No base to compare with: set TEST_BASE (a branch or commit).");
  const base = git("merge-base", ref, "HEAD").stdout.trim() || ref;
  const lines = (r: ReturnType<typeof git>) => r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const files = [...new Set([...lines(git("diff", "--name-only", base)), ...lines(git("ls-files", "--others", "--exclude-standard"))])].sort();
  return { base: ref, files };
}

/** The tests that cover `files`, in test.sh's order (then the unit tests), and why. */
export function select(files: string[], root = ROOT): { tests: string[]; all: string | null; uncovered: string[]; why: Map<string, string> } {
  const suite = suiteTests(root), units = unitTests(root);
  const shared = files.find((f) => SHARED.includes(f));
  if (shared) return { tests: [...suite, ...units], all: shared, uncovered: [], why: new Map() };
  const why = new Map<string, string>(), covered = new Set<string>();
  const pick = (test: string, covers: (f: string) => boolean) => {
    for (const f of files) if (covers(f)) { covered.add(f); if (!why.has(test)) why.set(test, f); }
  };
  for (const t of suite) {
    const patterns = coversOf(t, root) ?? [], own = importsOf(t, root, "tests/");
    pick(t, (f) => f == t || own.has(f) || patterns.some((p) => matches(p, f)));
  }
  for (const t of units) {
    const deps = importsOf(t, root);
    pick(t, (f) => f == t || deps.has(f));
  }
  return { tests: [...suite, ...units].filter((t) => why.has(t)), all: null, uncovered: files.filter((f) => !covered.has(f)), why };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const { base, files } = args.length ? { base: null, files: args } : changedFiles();
  const r = select(files);
  const say = (s: string) => process.stderr.write(s + "\n");
  say(`${files.length} file${files.length == 1 ? "" : "s"} changed${base ? ` since ${base}` : ""}${files.length ? `: ${files.slice(0, 12).join(" ")}${files.length > 12 ? " ..." : ""}` : ""}`);
  if (r.all) say(`${r.all} is shared infrastructure: every test`);
  else for (const t of r.tests) say(`  ${t}  (${r.why.get(t)})`);
  if (r.uncovered.length) say(`no test covers: ${r.uncovered.join(" ")}`);
  for (const t of r.tests) console.log(t);
}
