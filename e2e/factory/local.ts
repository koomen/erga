// A "local agent" for the factory's local-task tests: `bun factory/task.ts` run in a clone
// of the factory server's repository, with an admin token (ERGA_TOKEN), as Claude Code on a laptop runs it. Each
// test makes its own token and clones; the clones are in the server's scratch folder, so they go with it.
//
// Every command runs without blocking the test's process (not spawnSync): blocked for seconds, it can't see the
// dev server close an idle keep-alive connection, and its next fetch on that connection fails (ECONNRESET).

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintGitToken } from "../../dev/factory";
import { cleanEnv, ROOT } from "../env";
import { expect, type FactoryServer } from "../fixtures";

/** The machine the local agent says it runs on. */
export const MACHINE = "test-laptop";
const CLI = join(ROOT, "factory", "task.ts");

/** A command's exit code (124: killed after `ms`) and what it printed. */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; ms?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => { stdout += c; });
    p.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => p.kill("SIGKILL"), opts.ms ?? 60_000);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 124, stdout, stderr }); });
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(e) }); });
  });
}

export async function localAgent(s: FactoryServer, label = "Laptop agent") {
  // An admin token, as Claude Code on a laptop has one.
  const made = await (await fetch(`${s.root}/tokens/new`, { method: "POST", headers: { Origin: s.root }, body: new URLSearchParams({ label, scope: "admin" }) })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(made)?.[1];
  expect(token, made.slice(0, 300)).toBeTruthy();
  const git = (dir: string, ...args: string[]) => run("git", ["-C", dir, ...args]);
  const agent = {
    /** Who the board says runs its tasks. */
    by: `tester, via a shared agent (${label})`,
    git,
    /** A clone of the server's repository, as a laptop has one (reading it needs a token: any task's). */
    async checkout(name: string): Promise<string> {
      const dir = mkdtempSync(join(s.scratch, `local-${name}-`));
      const read = mintGitToken(s.secret, { scope: "task", branch: "task/999999-read", exp: Math.floor(Date.now() / 1000) + 3600 });
      const r = await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${read}`, "clone", "-q", `${s.root}/__factory/git/erga.git`, dir]);
      expect(r.code, r.stderr).toBe(0);
      for (const [k, v] of [["user.name", "Local Agent"], ["user.email", "local@example.com"]]) await git(dir, "config", k, v);
      return dir;
    },
    async commit(dir: string, file: string, text: string, message: string) {
      writeFileSync(join(dir, file), text);
      await git(dir, "add", file);
      const r = await git(dir, "commit", "-q", "-m", message);
      expect(r.code, r.stderr).toBe(0);
    },
    /** `task ...` in the checkout: its exit code and what it printed. */
    async task(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
      const r = await run("bun", [CLI, ...args], { cwd: dir, env: cleanEnv({ ERGA_TOKEN: token, ERGA_MACHINE: MACHINE }) });
      return { code: r.code, out: `${r.stdout}${r.stderr}` };
    },
    /** `task new ...`: the id it registered. */
    async register(dir: string, ...args: string[]): Promise<number> {
      const r = await agent.task(dir, "new", ...args);
      const id = Number(/Registered task #(\d+)/.exec(r.out)?.[1]);
      expect(r.code == 0 && id > 0, r.out).toBe(true);
      return id;
    },
  };
  return agent;
}
