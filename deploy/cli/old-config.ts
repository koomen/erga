// The config file from before an instance tracked a repository and a branch: an entry had no `repo` and no `branch`,
// and an instance on a copy of another's data named it as `stagingOf`. The first command of this code moves such a
// file to today's fields (main.ts calls moveOldConfig before each command that reads the file), so that nobody edits it
// by hand: each
// entry tracks the clone's origin, where its commits came from; `stagingOf` becomes `copyOf`, and that entry tracks
// `staging`, the branch whose commits a merge deployed to it; every other entry tracks `main`.
//
// This file and its one call (main.ts) are the only code about the old file: delete both when no such file is left.

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Config, configPath, DEFAULT_BRANCH, DEFAULT_REPO, repoName, writeConfig } from "./config";
import { sh } from "../root";

type Old = Record<string, unknown>;

/**
 * The source of an old entry that lost `stagingOf`: the host of its SNAPSHOT_FROM. A command of the older code that
 * writes the file after its move drops every field it does not know, and the entry's vars still say where its data
 * came from (each deploy of such an entry sent SNAPSHOT_FROM, and the entry keeps the server's vars).
 */
function sourceOf(e: Old): string | null {
  const from = (e.vars as Record<string, unknown> | undefined)?.SNAPSHOT_FROM;
  try {
    return typeof from == "string" && from ? new URL(from).host : null;
  } catch {
    return null;
  }
}

/** The file's content with each old entry moved, or null: no entry is old. `repo`: the clone's origin. */
export function movedConfig(file: unknown, repo: string): { instances: Old[] } | null {
  const instances = (file as { instances?: unknown } | null)?.instances;
  if (!Array.isArray(instances)) return null;
  const old = (e: Old) => !("repo" in e) || !("branch" in e) || "stagingOf" in e;
  if (!instances.some(old)) return null;
  return {
    instances: instances.map((e: Old) => {
      if (!old(e)) return e;
      const { host, stagingOf, ...rest } = e;
      const source = typeof stagingOf == "string" ? stagingOf : sourceOf(e);
      return { host, repo, branch: source ? "staging" : DEFAULT_BRANCH, ...(source ? { copyOf: source } : {}), ...rest };
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
  for (const e of moved.instances)
    say(
      `NOTE  ${String(e.host)} tracks ${String(e.repo)} ${String(e.branch)} now${e.copyOf ? `, on a copy of ${String(e.copyOf)}'s data` : ""} (${path}). To change it: bun erga track ${String(e.host)} --branch <branch>`
    );
}
