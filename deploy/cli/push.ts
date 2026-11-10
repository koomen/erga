// `bun erga push`: the one command before a push. It formats the lines the branch changed, builds the inline code's
// file again, runs the tests, and pushes the branch to GitHub only when they end with "all passing". The commit it
// pushes is the commit it tested: a change that no commit has stops it before the tests. A push deploys nothing.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchRefusal, failureOf } from "./flow";
import { sh } from "./observe";

/** Runs one step's command in the checkout: whether it passed, and all it printed. */
export type Run = (cmd: string[]) => { ok: boolean; out: string };

const FORMAT = ["bun", "dev/format.ts", "--write"];
const BUILD = ["bun", "client/build.ts", "--inline"];
const TESTS = ["bun", "e2e/run.ts"];

/** Pushes the branch of the checkout at `root`. The result: the commit pushed. An error says what stopped it, and what to do next. */
export function pushBranch(o: { root: string; log: (line: string) => void; run?: Run }): string {
  const at = (cmd: string[]) => sh(cmd, { cwd: o.root });
  // Both of its outputs as one, in the order they came: the tests' steps print to the two.
  const run: Run = o.run ?? ((cmd) => at(["sh", "-c", 'exec "$@" 2>&1', "sh", ...cmd]));
  const stop = (what: string, next?: string): never => {
    throw new Error(next ? `${what} ${next}` : what);
  };
  const head = at(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = head.ok ? head.out : null;
  const no = branchRefusal(branch);
  if (no) stop(no);

  for (const [name, cmd] of [
    ["format", FORMAT],
    ["build", BUILD],
  ] as const) {
    const r = run(cmd);
    if (r.out) for (const l of r.out.split("\n")) o.log(`      ${l}`);
    if (!r.ok) stop(`${cmd.join(" ")} failed.`, "Fix what it names, then: bun erga push");
    o.log(`PASS  ${name}: ${cmd.join(" ")}`);
  }

  // The tests run on the files; the push sends the commit. They must be the same.
  const loose = at(["git", "status", "--porcelain"]).out;
  if (loose) {
    for (const l of loose.split("\n")) o.log(`      ${l}`);
    stop("These files have changes that no commit has, so the tests would not test the commit.", "Commit them, then: bun erga push");
  }
  const sha = at(["git", "rev-parse", "HEAD"]).out;

  const file = join(tmpdir(), `erga-push-${branch!.replace(/[^\w.-]/g, "_")}.log`);
  o.log(`      bun run test ... (the log: ${file})`);
  const t = run(TESTS);
  writeFileSync(file, `${t.out}\n`);
  if (!/^all passing/m.test(t.out)) {
    for (const l of failureOf(t.out)) o.log(l);
    stop(`bun run test did not end with "all passing". Nothing is pushed. The log: ${file}`, "Fix it, commit, then: bun erga push");
  }
  o.log(`PASS  tests: ${/^all passing.*$/m.exec(t.out)![0]}`);

  // With the lease, an amended or rebased branch replaces its own earlier push, and nothing that this checkout has not seen.
  const p = at(["git", "push", "--quiet", "--force-with-lease", "origin", `${sha}:refs/heads/${branch}`]);
  if (!p.ok) stop(`git push failed: ${p.err || p.out}`);
  o.log(`PASS  Pushed ${branch} at ${sha.slice(0, 12)} to GitHub. A push deploys nothing.`);
  return sha;
}
