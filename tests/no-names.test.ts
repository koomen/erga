// No instance's name in the code: each instance's names come from its entry in .erga/config.json (`bun erga deploy`), and
// the server learns its host from the request. The test reads every tracked source file but the tests and the docs
// (the pages Erga ships, assets/**/*.html, and its agents' prompts, agents/**/*.md, are sources), with its comments
// taken out (a comment may name erga.dev as an example). A name in a pattern (erga\.dev) is a name. The HMAC label
// `erga-pages:` and the meta name `erga-pages` are not addresses (server/documents/pages-origin.ts,
// server/documents/view.ts). One name is in the code: the repository that an instance tracks when its setup names none
// (deploy/cli/config.ts, DEFAULT_REPO).
//
// And no kind of instance but the two the code has (one on Cloudflare, one on AWS): no flag or value says that an
// instance is "production" or "staging", and no instance names another one. Every instance takes one path, so no code
// may ask which one it is.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const NAMES = /erga\\?\.dev|erga-staging|erga-pages(?![\\"':])|koomen\/erga/g;

/** The text without its comments: // and # to the end of the line, -- in SQL, and block comments. */
const uncommented = (path: string, text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(path.endsWith(".sql") ? /(^|\s)--.*$/gm : path.endsWith(".toml") ? /(^|\s)#.*$/gm : /(^|\s)\/\/.*$/gm, "$1");

/** A source file: code, a page Erga ships (a template), or an agent's prompt. */
const SOURCE = /\.(ts|tsx|js|mjs|json|css|sql|toml|html)$|^agents\/.*\.md$/;

/** The tracked source files (not the tests, not the docs), each with its text without comments. */
const sources = () =>
  Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT })
    .stdout.toString()
    .split("\0")
    .filter((f) => SOURCE.test(f) && !/^(tests|e2e)\//.test(f) && f != "bun.lock")
    .map((f) => ({ f, text: uncommented(f, readFileSync(join(ROOT, f), "utf8")) }));

/** The lines of the sources that `what` matches, as "file: line". */
const hitsOf = (what: RegExp, but: string[] = []) =>
  sources()
    .filter(({ f }) => !but.includes(f))
    .flatMap(({ f, text }) =>
      text
        .split("\n")
        .filter((line) => line.match(what))
        .map((line) => `${f}: ${line.trim().slice(0, 120)}`)
    );

test("the names find what they are for, and skip comments and the HMAC label", () => {
  const found = (path: string, text: string) => uncommented(path, text).match(NAMES) ?? [];
  expect(found("a.ts", 'const host = "erga.dev";')).toEqual(["erga.dev"]);
  expect(found("a.ts", "worker: 'erga-staging', pages: `*.erga-pages.dev/*`")).toEqual(["erga-staging", "erga-pages"]);
  expect(found("a.ts", 'fork("koomen/erga")')).toEqual(["koomen/erga"]);
  expect(found("a.ts", '// on erga.dev\nx(); /* koomen/erga */ const u = "https://example.com"; // erga-staging')).toEqual([]);
  expect(found("a.sql", "-- on erga.dev\nSELECT 'erga.dev';")).toEqual(["erga.dev"]);
  expect(found("a.ts", "html.replace(/https:\\/\\/erga\\.dev\\/erga\\//, shell)")).toEqual(["erga\\.dev"]);
  expect(found("a.html", '<script type="module" src="https://erga.dev/erga/steps/editor.js"></script>')).toEqual(["erga.dev"]);
  expect(found("a.ts", 'encode(`erga-pages:${s}`); meta("erga-pages"); "meta[name=\\"erga-pages\\"]"')).toEqual([]);
});

test("no instance's name in the code", () => {
  expect(sources().length).toBeGreaterThan(100);
  expect(hitsOf(NAMES)).toEqual(['deploy/cli/config.ts: export const DEFAULT_REPO = "github.com/koomen/erga";']);
});

/**
 * A flag or a value for a kind of instance, or a link from one instance to another: the settings that only two
 * instances had (DEPLOY_TARGET, SNAPSHOT_IMPORT), the names of an instance whose data another one copied (stagingOf,
 * copyOf, SNAPSHOT_FROM, SNAPSHOT_TOKEN), a server for admins only (adminsOnly), the change log's record of a push
 * past the old staging rule (stagingOverride), and "production" as a key, a value or a question. (The word in a
 * sentence for a person is not one; staging is a branch's name.)
 */
const KINDS =
  /\bDEPLOY_TARGET\b|\bSNAPSHOT_(IMPORT|FROM|TOKEN)\b|\b(stagingOf|stagingOverride|adminsOnly|isStaging|isProduction)\b|\.copyOf\b|\bcopyOf\??:|\bproduction\??\s*[:=]|[=(,:]\s*["'`]production["'`]/g;

test("no code asks which instance it is, and no instance names another: every instance takes one path", () => {
  const found = (text: string) => uncommented("a.ts", text).match(KINDS) ?? [];
  expect(found('if (env.DEPLOY_TARGET == "production") return;').length).toBe(2);
  expect(found('const t = { production: true }; vars.SNAPSHOT_IMPORT = "1"; kind = "production";').length).toBe(3);
  expect(
    found("const source = entry.copyOf ?? entry.stagingOf; if (platform.adminsOnly) vars.SNAPSHOT_FROM = env.SNAPSHOT_TOKEN;").length
  ).toBe(5);
  expect(found("if (c.stagingOverride) return line(c.stagingOverride.reason);").length).toBe(2);
  expect(
    found(
      'log("It is on production now."); // production: true\nconst branch = "staging"; if (e.branch == "staging") push(sha, "staging");'
    )
  ).toEqual([]);
  expect(hitsOf(KINDS)).toEqual([]);
});
