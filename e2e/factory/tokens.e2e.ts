// What a VM's token and a task's git token reach (tests/factory.ts, 6).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintGitToken } from "../../dev/factory";
import { cleanEnv } from "../env";
import { expect, test } from "../fixtures";
import { factory, servers } from "./factory";

await servers.factory();

test("a made-up VM token is refused; a task's git token clones but can't push staging; with no token, no repository", async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const brief = await fetch(`${s.root}/api/factory/tasks/1/brief`, { headers: { Authorization: "Bearer fct.1.9999999999." + "0".repeat(64) } });
  expect(brief.status).toBe(403);
  const clone = mkdtempSync(join(tmpdir(), "factory-clone-"));
  try {
    const token = mintGitToken(s.secret, { scope: "task", branch: "task/999-a-task", exp: Math.floor(Date.now() / 1000) + 600 });
    const git = (...args: string[]) => spawnSync("git", ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args], { cwd: clone, encoding: "utf8", env: cleanEnv(), timeout: 30_000 });
    expect(git("clone", "-q", `${s.root}/__factory/git/erga.git`, ".").status).toBe(0);
    writeFileSync(join(clone, "not-for-staging.txt"), "no\n");
    git("add", "-A");
    git("commit", "-qm", "Not for staging");
    const toStaging = git("push", "origin", "HEAD:refs/heads/staging");
    expect(toStaging.status).not.toBe(0);
    expect(toStaging.stderr).toContain("403");
    const noToken = spawnSync("git", ["ls-remote", `${s.root}/__factory/git/erga.git`], { encoding: "utf8", env: cleanEnv(), timeout: 30_000 });
    expect(noToken.status).not.toBe(0);
  } finally { rmSync(clone, { recursive: true, force: true }); }
});
