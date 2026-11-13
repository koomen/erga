#!/usr/bin/env bun
// The quick check: a loose check of a change while you work, in under 5 seconds. Not a gate: `bun run test` is.
//
//   bun run check             the change since the merge base with origin/staging, with the files no commit has
//   bun run check a.ts b.ts   as if only these files changed
//
// All at once: the formatter on the changed lines (dev/format.ts), the linter on the changed files, the typecheck of
// the three projects, and the unit tests that the changed files reach through the import graph (dev/graph.ts), with
// the tests of the repository's rules (RULES), which read every file. It runs no browser test. It ends with what it
// did not run. The unit tests stop at the time limit (LIMIT_MS): a file that did not end is named as not run.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "../deploy/root";
import { changeBase } from "./format";
import { reached, ROOT, sourceFiles } from "./graph";
import { runUnit } from "./unit";

const LIMIT_MS = 4500;
const VITE_CONFIG = ["node", "--no-experimental-webstorage", "-e", "import('vite').then((v) => v.resolveConfig({}, 'serve'))"];
/** The tests of the repository's rules: they read the files' text, not their imports, so every change reaches them. */
const RULES = [
  "agent-actions",
  "browser-imports",
  "e2e-servers",
  "file-size",
  "imports",
  "inline-code",
  "migrations",
  "no-names",
  "paths",
  "password-managers",
  "test-habits",
  "typecheck",
].map((n) => `tests/${n}.test.ts`);

const t0 = performance.now();
const since = () => Math.round(performance.now() - t0);
/** A step's command: it does not block (the steps run at once), and its answer is all that it printed. */
const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd: ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [a, b, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code == 0, out: (a + b).trim() };
};
const lines = (...args: string[]) =>
  git(...args)
    .out.split("\n")
    .filter(Boolean);

const named = process.argv.slice(2);
const base = changeBase();
const changed = named.length
  ? named
  : [...new Set([...(base ? lines("diff", "--name-only", base, "--") : []), ...lines("ls-files", "--others", "--exclude-standard")])];
console.log(
  `quick check: ${changed.length} changed file${changed.length == 1 ? "" : "s"}${named.length ? " (named)" : base ? ` since ${base.slice(0, 8)}` : ""}`
);

let ok = true;
const step = async (name: string, f: () => Promise<{ ok: boolean; out: string; note?: string }>) => {
  const r = await f();
  if (!r.ok) ok = false;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${name}${r.note ? `: ${r.note}` : ""} (${since()} ms)${r.ok || !r.out ? "" : `\n${r.out}`}`);
};

const all = sourceFiles();
const tests = all.filter((f) => /^tests\/[^/]+\.test\.ts$/.test(f));
const hit = reached(tests, changed);
for (const f of RULES) if (!hit.has(f) && tests.includes(f)) hit.set(f, "a rule of the repository");
const lintable = changed.filter((f) => /\.(ts|js|json|css)$/.test(f) && existsSync(join(ROOT, f)));
// Vite's and the Worker's configuration load only in a real server: checked when the change reaches them.
const config = reached(["vite.config.ts", "cloudflare.config.ts"], changed).size > 0;
const notRun: string[] = [];
let viteLoaded = false;

await Promise.all([
  step("format", () => run(["bun", "dev/format.ts"])),
  step("lint", async () =>
    lintable.length
      ? {
          ...(await run(["node_modules/.bin/biome", "lint", "--colors=off", "--no-errors-on-unmatched", ...lintable])),
          note: `${lintable.length} files`,
        }
      : { ok: true, out: "", note: "no file to lint" }
  ),
  step("typecheck", async () => {
    const inline = await run(["bun", "client/build.ts", "--inline"]);
    if (!inline.ok) return inline;
    // The load of Vite's configuration writes the Worker's types (.cloudflare/types): first in a new folder.
    viteLoaded = config || !existsSync(join(ROOT, ".cloudflare/types"));
    const loaded = viteLoaded ? await run(VITE_CONFIG) : { ok: true, out: "" };
    if (!loaded.ok) return loaded;
    const rs = await Promise.all(
      ["tsconfig.json", "tsconfig.workers.json", "tsconfig.browser.json"].map((p) => run(["node_modules/.bin/tsc", "-p", p]))
    );
    return {
      ok: rs.every((r) => r.ok),
      out: rs
        .map((r) => r.out)
        .filter(Boolean)
        .join("\n"),
    };
  }),
  step("unit tests", async () => {
    const r = await runUnit([...hit.keys()], { limitMs: LIMIT_MS - since() });
    if (r.unfinished.length)
      notRun.push(`${r.unfinished.length} unit test files that the time limit stopped (bun test ${r.unfinished.join(" ")})`);
    const done = hit.size - r.unfinished.length;
    return {
      ok: !r.failed.length,
      out: r.failed.map((f) => f.out).join("\n\n"),
      note: `${done} of ${tests.length} files, ${r.passed} tests`,
    };
  }),
]);

if (tests.length > hit.size) notRun.push(`${tests.length - hit.size} unit test files that the change does not reach`);
if (!viteLoaded) notRun.push("the load of Vite's configuration");
notRun.push("the browser tests");
console.log(`not run: ${notRun.join("; ")}. Before a push: bun run test`);
console.log(`quick check ${ok ? "passed" : "FAILED"} (${(since() / 1000).toFixed(1)} s)`);
process.exit(ok ? 0 : 1);
