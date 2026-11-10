// The import graph of the repository's .ts files, for the quick check (dev/check.ts): the unit tests that a change
// reaches. A test is reached when it changed, when a file that it imports (through any number of imports) changed, or
// when its text names a changed file's path (a test that reads a file: AGENTS.md, a migration).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "worktrees"]);

/** Every .ts file of the repository, as repo paths. */
export function sourceFiles(root = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) out.push(relative(root, p));
    }
  };
  walk(root);
  return out;
}

/** The repository's files that `file` (a repo path) imports: static, dynamic and type-only; a package's are left out. */
export function importsOf(file: string, text: string, root = ROOT): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^\s*(?:import|export)\s+[^;]*?from\s+|^\s*import\s+|\bimport\s*\(\s*)["'](\.[^"']+)["']/gm)) {
    const at = resolve(root, dirname(file), m[1]);
    const found = [at, `${at}.ts`, join(at, "index.ts")].find((p) => existsSync(p) && statSync(p).isFile());
    if (found) out.push(relative(root, found));
  }
  return out;
}

/** The tests (of `tests`, repo paths) that the changed files reach, each with the reason. */
export function reached(tests: string[], changed: string[], root = ROOT): Map<string, string> {
  const read = (f: string) => {
    try {
      return readFileSync(join(root, f), "utf8");
    } catch {
      return "";
    }
  };
  const edges = new Map<string, string[]>();
  const imports = (f: string) => edges.get(f) ?? edges.set(f, f.endsWith(".ts") ? importsOf(f, read(f), root) : []).get(f)!;
  const set = new Set(changed);
  const out = new Map<string, string>();
  for (const test of tests) {
    if (set.has(test)) {
      out.set(test, "changed");
      continue;
    }
    const seen = new Set([test]);
    const queue = [test];
    let why = "";
    for (let f = queue.pop(); f && !why; f = queue.pop())
      for (const to of imports(f)) {
        if (set.has(to)) {
          why = `imports ${to}`;
          break;
        }
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    if (!why) {
      const text = read(test);
      why = changed.find((c) => text.includes(c)) ?? "";
      if (why) why = `reads ${why}`;
    }
    if (why) out.set(test, why);
  }
  return out;
}
