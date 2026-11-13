// The repository's folder, for every tool of deploy/ and dev/; a command run in it (git, most often); and what a
// command prints.

import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");

/** A command's result: its exit, and what it printed. It runs in the repository's folder, unless `cwd` names another. */
export function sh(cmd: string[], o: { cwd?: string; input?: string; env?: Record<string, string | undefined> } = {}) {
  const r = Bun.spawnSync(cmd, {
    cwd: o.cwd ?? ROOT,
    stdin: o.input != null ? new TextEncoder().encode(o.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: o.env ?? process.env,
  });
  return { ok: r.exitCode == 0, code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
/** git in the repository's folder. In another folder: sh(["git", ...], { cwd }). */
export const git = (...args: string[]) => sh(["git", ...args]);

export const say = (s = "") => console.log(s);
export const pass = (s: string) => say(`PASS  ${s}`);
/** Says what failed and what to do next, and ends the command. */
export const fail = (s: string, next?: string): never => {
  say(`FAIL  ${s}`);
  if (next) say(`NEXT  ${next}`);
  process.exit(1);
};
