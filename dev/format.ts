#!/usr/bin/env bun
// The formatter (Biome, biome.json), on the lines a change touches and no others:
//
//   bun dev/format.ts            check: lists each changed line that Biome would format, and fails
//   bun dev/format.ts --write    formats those lines in place (bun run format)
//
// A change is everything since the base: the merge base with ERGA_FORMAT_BASE (CI sets it), else
// with origin/staging, else with origin/main. Uncommitted edits and new files count; a moved file
// counts only for the lines the move changed. Biome formats
// each changed file; only the parts of its result that meet a changed line are kept, so the rest of
// a file stays as it is and a branch's diff stays its own. A line that Biome would only indent again
// (the code around it got wrapped) isn't a part: the parts kept take the indentation of the file's
// own lines around them. `bun run test` runs the check.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { diffArrays } from "diff";

const ROOT = resolve(import.meta.dirname, "..");
const BIOME = join(ROOT, "node_modules/.bin/biome");
const write = process.argv.includes("--write");
const CODE = /\.(ts|js)$/;

const git = (...args: string[]) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

/** The commit a change is measured from, or undefined when there's none to measure from. */
function base(): string | undefined {
  const asked = process.env.ERGA_FORMAT_BASE;
  for (const ref of [...(asked ? [asked] : []), "origin/staging", "origin/main"]) {
    const mb = git("merge-base", "HEAD", ref);
    if (mb.status == 0) return mb.stdout.trim();
  }
  return undefined;
}

// Git marks the lines a change only moved (from one file to another, or within one) in a color of their own:
// those aren't new code, so a move stays a move. `git diff` colors them by these settings, whatever the user's are.
const MOVED = "\x1b[35m";
const COLORS = ["-c", "color.diff.new=green", "-c", "color.diff.newMoved=magenta", "-c", "color.diff.newMovedAlternative=magenta"];
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

/** Each changed file, with the line numbers (1-based) of the lines it added: every line of a new file, none it only moved. */
function changes(from: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const flags = ["-U0", "--src-prefix=a/", "--dst-prefix=b/", "--find-renames", "--color=always", "--color-moved=plain"];
  const diff = git(...COLORS, "diff", ...flags, "--color-moved-ws=allow-indentation-change", from, "--");
  let set: Set<number> | undefined;
  let at = 0;
  for (const raw of diff.stdout.split("\n")) {
    const line = plain(raw);
    if (line.startsWith("+++ ")) {
      const file = line.startsWith("+++ b/") ? line.slice(6) : "";
      set = CODE.test(file) ? (out.get(file) ?? out.set(file, new Set()).get(file)) : undefined;
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) at = Number(hunk[1]);
    else if (set && line.startsWith("+")) {
      if (!raw.startsWith(MOVED)) set.add(at);
      at++;
    }
  }
  for (const file of git("ls-files", "--others", "--exclude-standard").stdout.split("\n")) {
    if (!CODE.test(file)) continue;
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n").length;
    out.set(file, new Set(Array.from({ length: lines }, (_, i) => i + 1)));
  }
  return out;
}

/** The file as Biome formats it; undefined when Biome leaves it alone (ignored) or can't parse it (the typecheck says why). */
function formatted(file: string, text: string): string | undefined {
  const r = spawnSync(BIOME, ["format", `--stdin-file-path=${file}`], { cwd: ROOT, input: text, encoding: "utf8", maxBuffer: 64 << 20 });
  return r.status == 0 && r.stdout ? r.stdout : undefined;
}

/** A stretch of the file that Biome rewrites: lines [from, to) (0-based) become `lines`. */
export type Region = { from: number; to: number; lines: string[] };

const indent = (l: string) => /^ */.exec(l)![0].length;
/** The lines, `by` spaces further in (or out, when it's less than 0). */
const shift = (lines: string[], by: number) =>
  by > 0 ? lines.map((l) => (l ? " ".repeat(by) + l : l)) : by < 0 ? lines.map((l) => l.replace(new RegExp(`^ {0,${-by}}`), "")) : lines;

/**
 * Where Biome's text differs from the file's, line by line, its indentation aside: a line Biome would only indent
 * again is the same line. Each region's new lines move by as much as the file's own lines do between the two texts,
 * measured at the last line both have that is no deeper than the region's first: so a part inside a function Biome
 * would wrap keeps its place in the file as it is, and a part Biome wraps itself is measured outside its own wrapping.
 * A line both have is a region of its own when that move would still indent it differently (a line inside a part
 * Biome wraps); only those on a changed line are kept, as for any region.
 */
export function regions(before: string[], after: string[]): Region[] {
  const out: Region[] = [];
  const same: [number, number][] = [];
  let at = 0;
  let atAfter = 0;
  let open: Region | null = null;
  /**
   * How far the file's lines move between the two texts, at the last line both have that is no deeper than `depth`;
   * undefined before there's one.
   */
  const moveAt = (depth: number) => {
    for (let k = same.length - 1; k >= 0; k--) {
      const [i, j] = same[k];
      if (before[i].trim() && indent(before[i]) <= depth) return indent(before[i]) - indent(after[j]);
    }
    return undefined;
  };
  const close = () => {
    if (!open) return;
    out.push({ ...open, lines: shift(open.lines, moveAt(open.from < before.length ? indent(before[open.from]) : 0) ?? 0) });
    open = null;
  };
  for (const part of diffArrays(before, after, { comparator: (a, b) => a.trim() == b.trim() })) {
    if (!part.added && !part.removed) {
      close();
      for (let k = 0; k < part.value.length; k++) {
        const [i, j] = [at + k, atAfter + k];
        const by = moveAt(indent(before[i]));
        const placed = by == undefined ? before[i] : shift([after[j]], by)[0];
        if (before[i].trim() && placed != before[i]) out.push({ from: i, to: i + 1, lines: [placed] });
        same.push([i, j]);
      }
      at += part.value.length;
      atAfter += part.value.length;
      continue;
    }
    open ??= { from: at, to: at, lines: [] };
    if (part.removed) at = open.to = at + part.value.length;
    else {
      open.lines.push(...part.value);
      atAfter += part.value.length;
    }
  }
  close();
  return out;
}

/** Whether a region meets a changed line: one of its lines, or, for lines it only adds, a line beside them. */
export const touches = (r: Region, changed: Set<number>) =>
  r.from == r.to
    ? changed.has(r.from) || changed.has(r.from + 1)
    : Array.from({ length: r.to - r.from }, (_, i) => r.from + i + 1).some((n) => changed.has(n));

if (import.meta.main) main();

function main() {
  const from = base();
  if (!from) {
    console.log("format: no origin/staging or origin/main to compare with (set ERGA_FORMAT_BASE), so nothing to check");
    process.exit(0);
  }
  let found = 0;
  for (const [file, changed] of changes(from)) {
    const path = join(ROOT, file);
    const text = readFileSync(path, "utf8");
    const pretty = formatted(file, text);
    if (pretty == undefined || pretty == text) continue;
    const before = text.split("\n");
    const todo = regions(before, pretty.split("\n")).filter((r) => touches(r, changed));
    if (!todo.length) continue;
    found += todo.length;
    if (write) {
      for (const r of todo.reverse()) before.splice(r.from, r.to - r.from, ...r.lines);
      writeFileSync(path, before.join("\n"));
      console.log(`format: formatted ${todo.length} part${todo.length == 1 ? "" : "s"} of ${file}`);
      continue;
    }
    for (const r of todo) {
      console.log(`\n${file}:${r.from + 1}`);
      for (const l of before.slice(r.from, r.to).slice(0, 12)) console.log(`  - ${l}`);
      for (const l of r.lines.slice(0, 12)) console.log(`  + ${l}`);
    }
  }
  if (!write && found) {
    console.log(`\nformat: ${found} changed part${found == 1 ? "" : "s"} not formatted. Run: bun run format`);
    process.exit(1);
  }
}
