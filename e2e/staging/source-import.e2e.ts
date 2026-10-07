// Seeding Erga's repository ("Seed, clone, push, pull"): source/import.ts through the Git endpoint, to
// main and staging, once. On a server of its own: a shared one's repository may be seeded already.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { cleanEnv, ROOT } from "../env";
import { expect, test } from "../fixtures";
import { admin, clone, commit, must } from "./staging";

test("source/import.ts seeds main and staging through the endpoint, and only once; a clone brings the history", { timeout: 60_000 /* a dev server of its own: a few seconds, more on a loaded machine */ }, async ({ tab }) => {
  const s = await tab.own({ env: { ERGA_DEPLOY_MOCK: "1", ERGA_DEPLOY_TARGET: "staging" } }), a = await admin(s);
  const src = mkdtempSync(join(s.scratch, "src-"));
  must(src, "init", "-q", "-b", "main");
  commit(src, "README.md", "# Erga\n", "First");
  commit(src, "app.ts", "export const x = 1;\n", "Second");
  const run = () => spawnSync("bun", [join(ROOT, "source/import.ts"), s.root, "--from", src], { encoding: "utf8", env: cleanEnv({ ERGA_TOKEN: a.token }), timeout: 60_000 });
  const first = run();
  expect(first.status, first.stdout + first.stderr).toBe(0);
  expect(first.stdout).toContain("Done: main and staging");
  const again = run();
  expect(again.status).not.toBe(0);
  expect(again.stderr).toContain("already has a main");
  expect(must(clone(s, a.token), "log", "--format=%s").split("\n")).toEqual(["Second", "First"]);
});
