// The config file from before an instance tracked a repository and a branch, and from before every instance was alike:
// an entry had no `repo` and no `branch`, or it named another instance whose data it ran on a copy of (`stagingOf`,
// then `copyOf`, and SNAPSHOT_FROM in its vars). The first command of this code moves such a file to today's fields
// (main.ts calls moveOldConfig before each command that reads the file), so that nobody edits it by hand: an entry
// with no repository tracks the clone's origin, where its commits came from; one with no branch tracks `staging` if
// it named another instance (a merge deployed staging's commits to it), else `main`; the names of the other instance go.
//
// This file and its one call (main.ts) are the only code about the old file: delete both when no such file is left.

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, configPath, DEFAULT_BRANCH, DEFAULT_REPO, repoName, writeConfig } from "./config";
import { sh } from "../root";

type Old = Record<string, unknown>;

const varsOf = (e: Old) => (e.vars && typeof e.vars == "object" ? (e.vars as Record<string, unknown>) : {});
/** Whether an entry names another instance, as one of before did. */
const namesAnother = (e: Old) => "stagingOf" in e || "copyOf" in e || "SNAPSHOT_FROM" in varsOf(e);
/** An entry of before: it lacks what it tracks, or it names another instance. */
const isOld = (e: Old) => !("repo" in e) || !("branch" in e) || namesAnother(e);

/** The file's content with each old entry moved, or null: no entry is old. `repo`: the clone's origin. */
export function movedConfig(file: unknown, repo: string): { instances: Old[] } | null {
  const instances = (file as { instances?: unknown } | null)?.instances;
  if (!Array.isArray(instances) || !instances.some(isOld)) return null;
  return {
    instances: instances.map((e: Old) => {
      if (!isOld(e)) return e;
      const { host, stagingOf: _s, copyOf: _c, repo: hadRepo, branch: hadBranch, ...rest } = e;
      const { SNAPSHOT_FROM: _f, ...vars } = varsOf(e);
      const branch = hadBranch ?? (namesAnother(e) ? "staging" : DEFAULT_BRANCH);
      return { host, repo: hadRepo ?? repo, branch, ...rest, ...("vars" in e ? { vars } : {}) };
    }),
  };
}

/** Moves .erga/config.json in `dir` when it is an old file, and says so. A file that is not JSON stays: readConfig names it. */
export function moveOldConfig(dir: string, say: (line: string) => void = console.error) {
  const path = configPath(dir);
  if (!existsSync(path)) return;
  let file: unknown;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  const origin = sh(["git", "remote", "get-url", "origin"], { cwd: dirname(dir) });
  const moved = movedConfig(file, origin.ok && origin.out ? repoName(origin.out) : DEFAULT_REPO);
  if (!moved) return;
  writeConfig(dir, moved as unknown as Config);
  const before = (file as { instances: Old[] }).instances;
  for (const e of moved.instances.filter((x, i) => x != before[i]))
    say(
      `NOTE  ${String(e.host)} tracks ${String(e.repo)} ${String(e.branch)} (${path}). To change it: bun erga track ${String(e.host)} --branch <branch>`
    );
}
