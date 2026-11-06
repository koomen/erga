// `bun erga merge <branch> [-m text]`, and the ops page's Merge button (deploy/cli/ops-page.ts runs this command): the
// branch onto staging as one commit, in a worktree of its own, then its tests, a deploy to each staging instance, and the
// push of staging. It holds the lock .erga/jobs/staging.lock, and writes its job record (deploy.ts, startJob) on the
// first staging instance, so the ops page shows its output as it comes.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./config";
import { deployStaging, recordPass, startJob, takeLock } from "./deploy";
import { mergeRefusal, messageRefusal, squashMessage } from "./flow";
import { commitsOf, conflictsOf, fetchOrigin, git, headOf, sh } from "./observe";

/** Merges `branch` onto staging. The result: the commit on staging. An error says what stopped it, and what to do next. */
export async function mergeBranch(o: { dir: string; branch: string; message?: string; print?: (line: string) => void }): Promise<string> {
  const name = o.branch;
  const command = `bun erga merge ${name}`;
  const free = takeLock(o.dir, "staging", command);
  const host = readConfig(o.dir).instances.find((e) => e.stagingOf)?.host ?? "staging";
  const job = startJob(o.dir, { command, host, print: o.print });
  const log = job.log;
  const stop = (what: string, next?: string): never => {
    throw new Error(next ? `${what} ${next}` : what);
  };
  let dir = "";
  try {
    const f = fetchOrigin();
    if (!f.ok) stop(`git fetch failed: ${f.err}`);
    const exists = !!headOf(`origin/${name}`);
    const ahead = exists ? Number(git("rev-list", "--count", `origin/staging..origin/${name}`).out) : 0;
    const conflicts = exists && ahead ? conflictsOf("origin/staging", `origin/${name}`) : [];
    const no = mergeRefusal({ branch: name, exists, ahead, conflicts });
    if (no) stop(no);
    const text = squashMessage(commitsOf("--no-merges", `origin/staging..origin/${name}`), o.message);
    const long = messageRefusal(text.split("\n\n")[0]);
    if (long) stop(long, `Write one: bun erga merge ${name} -m "<ten words at most>"`);
    log(`Merge ${name} (${ahead} commit${ahead == 1 ? "" : "s"}) onto staging ${headOf("origin/staging")?.slice(0, 12)} as one commit:`);
    log(`      ${text.split("\n")[0]}`);

    // A worktree of its own, so this checkout stays as it is.
    dir = mkdtempSync(join(tmpdir(), "erga-merge-"));
    const file = `${dir}.log`;
    const add = git("worktree", "add", "--quiet", "--detach", dir, "origin/staging");
    if (!add.ok) {
      dir = "";
      stop(`git worktree add failed: ${add.err}`);
    }
    const at = (cmd: string[], x: { input?: string } = {}) => sh(cmd, { cwd: dir, ...x });
    const sq = at(["git", "merge", "--squash", `origin/${name}`]);
    if (!sq.ok) stop(`git merge --squash failed: ${sq.err || sq.out}`, `Rebase ${name} on origin/staging, push it, and merge again.`);
    const c = at(["git", "commit", "--quiet", "-F", "-"], { input: text });
    if (!c.ok) stop(`git commit failed: ${c.err || c.out}`);
    const sha = at(["git", "rev-parse", "HEAD"]).out;
    job.note({ commit: sha });
    log("      bun install --frozen-lockfile ...");
    const i = at(["bun", "install", "--frozen-lockfile"]);
    if (!i.ok) stop(`bun install failed: ${i.err.slice(-600)}`);
    log(`      bun run test ... (the log: ${file})`);
    const t = at(["bun", "run", "test"]);
    writeFileSync(file, `${t.out}\n${t.err}`);
    if (!/^all passing/m.test(t.out)) {
      for (const l of t.out.split("\n").slice(-30)) log(l);
      stop(
        `bun run test did not end with "all passing" on the merged commit. The log: ${file}`,
        `Fix it on ${name}, push it, and merge again.`
      );
    }
    log("PASS  bun run test: all passing.");
    recordPass(o.dir, sha, t.out);
    const hosts = await deployStaging({ dir: o.dir, sha, command, print: log }).catch((e: Error) =>
      stop(e.message, `Fix it, then run bun erga merge ${name} again.`)
    );
    for (const h of hosts) log(`PASS  ${h} runs ${sha.slice(0, 12)}, healthy.`);
    log(`PASS  Merged ${name} as ${sha.slice(0, 12)}: ${text.split("\n")[0]}`);
    const d = git("push", "--quiet", "origin", "--delete", name);
    if (d.ok) log(`PASS  The branch ${name} is deleted on GitHub.`);
    else log(`NOTE  The branch ${name} is still on GitHub: ${d.err}`);
    if (git("rev-parse", "--verify", "--quiet", `refs/heads/${name}`).ok)
      log(`NOTE  The local branch ${name} is still here. Delete it when you are done with it: git branch -D ${name}`);
    job.end("ok");
    return sha;
  } catch (e) {
    job.end("failed", (e as Error).message);
    throw e;
  } finally {
    if (dir) git("worktree", "remove", "--force", dir);
    free();
  }
}
