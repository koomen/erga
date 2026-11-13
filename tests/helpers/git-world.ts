// A git world for the tests of `bun erga`: a bare origin with a `staging` branch, a clone of it, and commits.

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs a command in `cwd`; the result: its output. A command that fails throws its error text. */
export const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** Writes `file` in the folder `at` and commits all changes, with `text` as content and as message; the result: the commit. */
export const commit = (at: string, file: string, text: string) => {
  writeFileSync(join(at, file), text);
  sh(at, "git", "add", "-A");
  sh(at, "git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", text);
  return sh(at, "git", "rev-parse", "HEAD");
};

/** A bare origin and a clone of it on `staging`, with one commit (a.txt), `base`, that the origin has. `name` starts the folder's name. */
export function gitWorld(name: string) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), name)));
  const [origin, clone] = [join(top, "origin.git"), join(top, "clone")];
  sh(top, "git", "init", "--quiet", "--bare", "-b", "staging", origin);
  sh(top, "git", "clone", "--quiet", origin, clone);
  sh(clone, "git", "switch", "--quiet", "-c", "staging");
  const base = commit(clone, "a.txt", "one");
  sh(clone, "git", "push", "--quiet", "origin", "staging");
  return { top, origin, clone, base };
}
