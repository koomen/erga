// Every .ts file of the repository is type-checked on purpose: one of the three projects
// (tsconfig.json, tsconfig.workers.json, tsconfig.browser.json) names it, by its folder or itself.
// A new folder or a new script at the top fails here until a project takes it.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const PROJECTS = ["tsconfig.json", "tsconfig.workers.json", "tsconfig.browser.json"];

/** A project's include and exclude (the files allow // comments on their own lines). */
function project(name: string): { include: string[]; exclude: string[] } {
  const text = readFileSync(join(ROOT, name), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const { include = [], exclude = [] } = JSON.parse(text) as { include?: string[]; exclude?: string[] };
  return { include, exclude };
}

const names = (path: string, entries: string[]) => entries.some((e) => path == e || path.startsWith(`${e}/`));

test("every .ts file is in a typecheck project", () => {
  const projects = PROJECTS.map(project);
  const files = spawnSync("git", ["ls-files", "*.ts"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const unchecked = files.filter((f) => !f.endsWith(".d.ts") && !projects.some((p) => names(f, p.include) && !names(f, p.exclude)));
  expect(unchecked).toEqual([]);
});
