// No instance's name in the code: each instance's names come from its entry in .erga/config.json (`bun erga deploy`), and
// the server learns its host from the request. The test reads every tracked source file but the tests and the docs,
// with its comments taken out (a comment may name erga.dev as an example). The HMAC label `erga-pages:` and the meta
// name `erga-pages` are not addresses (server/documents/pages-origin.ts, server/documents/view.ts).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const NAMES = /erga\.dev|erga-staging|erga-pages(?![\\"':])|koomen\/erga/g;

/** The text without its comments: // and # to the end of the line, -- in SQL, and block comments. */
const uncommented = (path: string, text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(path.endsWith(".sql") ? /(^|\s)--.*$/gm : path.endsWith(".toml") ? /(^|\s)#.*$/gm : /(^|\s)\/\/.*$/gm, "$1");

test("the names find what they are for, and skip comments and the HMAC label", () => {
  const found = (path: string, text: string) => uncommented(path, text).match(NAMES) ?? [];
  expect(found("a.ts", 'const host = "erga.dev";')).toEqual(["erga.dev"]);
  expect(found("a.ts", "worker: 'erga-staging', pages: `*.erga-pages.dev/*`")).toEqual(["erga-staging", "erga-pages"]);
  expect(found("a.ts", 'fork("koomen/erga")')).toEqual(["koomen/erga"]);
  expect(found("a.ts", '// on erga.dev\nx(); /* koomen/erga */ const u = "https://example.com"; // erga-staging')).toEqual([]);
  expect(found("a.sql", "-- on erga.dev\nSELECT 'erga.dev';")).toEqual(["erga.dev"]);
  expect(found("a.ts", 'encode(`erga-pages:${s}`); meta("erga-pages"); "meta[name=\\"erga-pages\\"]"')).toEqual([]);
});

test("no instance's name in the code", () => {
  const files = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT })
    .stdout.toString()
    .split("\0")
    .filter((f) => /\.(ts|tsx|js|mjs|json|css|sql|toml)$/.test(f) && !/^(tests|e2e)\//.test(f) && f != "bun.lock");
  expect(files.length).toBeGreaterThan(100);
  const hits = files.flatMap((f) =>
    uncommented(f, readFileSync(join(ROOT, f), "utf8"))
      .split("\n")
      .filter((line) => line.match(NAMES))
      .map((line) => `${f}: ${line.trim().slice(0, 120)}`)
  );
  expect(hits).toEqual([]);
});
