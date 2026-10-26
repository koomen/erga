// Every repo path a comment or a doc names exists: a file that moves takes its
// mentions with it. A path is a word that starts with one of the repo's
// folders and ends in a file's extension or a "/" (server/app.ts, client/shell/).
// Code is not checked (its strings are often data, not paths); only comments,
// and the whole of each Markdown file. The migrations keep their words: a
// deployed server has applied them (AGENTS.md, rule 3).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const FOLDERS = ["agents", "server", "cloudflare", "deploy", "control", "client", "shared", "document", "dev", "tests", "e2e", "docs"];
const PATH = new RegExp(`(?<![\\w./@:-])(?:${FOLDERS.join("|")})/[A-Za-z0-9_./-]*`, "g");

/** The repo's tracked text files that can name a path. */
function files(): string[] {
  const out = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT }).stdout.toString().trim().split("\n");
  return out.filter((f) => /\.(ts|js|css|html|jsonc|md)$/.test(f) && !f.startsWith("e2e/fixtures/") && !f.startsWith("assets/"));
}

/** A line's comment, or the whole line in a Markdown file. */
function comment(file: string, line: string): string {
  if (file.endsWith(".md")) return line;
  const t = line.trimStart();
  if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("<!--")) return line;
  const at = [line.indexOf(" // "), line.indexOf("/*"), line.indexOf("<!--")].filter((i) => i >= 0);
  return at.length ? line.slice(Math.min(...at)) : "";
}

test("every repo path a comment or a doc names exists", () => {
  const wrong: string[] = [];
  for (const f of files()) {
    readFileSync(join(ROOT, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const m of comment(f, line).matchAll(PATH)) {
        const p = m[0].replace(/[.,]+$/, "");
        if (!/\.[a-z]+$/.test(p) && !p.endsWith("/")) continue;
        if (!existsSync(join(ROOT, p))) wrong.push(`${f}:${i + 1} names ${p}`);
      }
      });
  }
  expect(wrong).toEqual([]);
});
