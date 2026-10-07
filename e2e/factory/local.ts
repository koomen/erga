// A "local agent" for the factory's local-task tests (tests/factory-local.ts): `bun factory/task.ts` run in a clone
// of the factory server's repository, with an admin token (ERGA_TOKEN), as Claude Code on a laptop runs it. Each
// test makes its own token and clones; the clones are in the server's scratch folder, so they go with it.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintGitToken } from "../../dev/factory";
import { cleanEnv, ROOT } from "../env";
import { expect, type FactoryServer } from "../fixtures";

/** The machine the local agent says it runs on. */
export const MACHINE = "test-laptop";
const CLI = join(ROOT, "factory", "task.ts");

export async function localAgent(s: FactoryServer, label = "Laptop agent") {
  // An admin token, as Claude Code on a laptop has one (README, Tokens).
  const made = await (await fetch(`${s.root}/tokens/new`, { method: "POST", headers: { Origin: s.root }, body: new URLSearchParams({ label, scope: "admin" }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(made)?.[1];
  expect(token, made.slice(0, 300)).toBeTruthy();
  const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 60_000, env: cleanEnv() });
  return {
    /** Who the board says runs its tasks. */
    by: `tester, via a shared agent (${label})`,
    git,
    /** A clone of the server's repository, as a laptop has one (reading it needs a token: any task's). */
    checkout(name: string): string {
      const dir = mkdtempSync(join(s.scratch, `local-${name}-`));
      const read = mintGitToken(s.secret, { scope: "task", branch: "task/999999-read", exp: Math.floor(Date.now() / 1000) + 3600 });
      const r = spawnSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${read}`, "clone", "-q", `${s.root}/__factory/git/erga.git`, dir], { encoding: "utf8", timeout: 60_000, env: cleanEnv() });
      expect(r.status, r.stderr).toBe(0);
      for (const [k, v] of [["user.name", "Local Agent"], ["user.email", "local@example.com"]]) git(dir, "config", k, v);
      return dir;
    },
    commit(dir: string, file: string, text: string, message: string) {
      writeFileSync(join(dir, file), text);
      git(dir, "add", file);
      const r = git(dir, "commit", "-q", "-m", message);
      expect(r.status, r.stderr).toBe(0);
    },
    /** `task ...` in the checkout: its exit code and what it printed. */
    task(dir: string, ...args: string[]): { code: number; out: string } {
      const r = spawnSync("bun", [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60_000, env: cleanEnv({ ERGA_TOKEN: token, ERGA_MACHINE: MACHINE }) });
      return { code: r.status ?? 124, out: `${r.stdout}${r.stderr}` };
    },
    /** `task new ...`: the id it registered. */
    register(dir: string, ...args: string[]): number {
      const r = this.task(dir, "new", ...args);
      const id = Number(/Registered task #(\d+)/.exec(r.out)?.[1]);
      expect(r.code == 0 && id > 0, r.out).toBe(true);
      return id;
    },
  };
}
