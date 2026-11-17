// `bun erga promote`: main on origin moves forward to staging's head. It deploys nothing: an instance that tracks main
// gets the commit from `bun erga deploy <host>`. It stops unless the tests passed on the commit (gate.ts: its merge
// wrote the record; with none, they run now), and unless each registered instance that tracks staging on origin runs
// the commit, healthy: a commit that broke such an instance does not reach main. It holds the lock
// .erga/jobs/main.lock, and writes its job record under "main".

import { type Config, readConfig, repoName } from "./config";
import { isAncestor, pushTo, remoteHead } from "./deploy";
import type { Instance } from "./flow";
import { gateRefusal } from "./gate";
import { type From, startJob, takeLock } from "./jobs";
import { type Ask, instanceReader } from "./running";
import { type Suite, testRun, treeOf } from "./test-run";
import { ROOT, sh } from "../root";

/** Why main must not move to `sha`, from what the instances that track staging answer, or null. None: nothing to ask. */
export function promoteRefusal(sha: string, answers: Pick<Instance, "host" | "version" | "healthy" | "error">[]): string | null {
  const off = answers.filter((a) => !a.healthy || !a.version || !sha.startsWith(a.version));
  if (!off.length) return null;
  const said = (a: (typeof off)[number]) =>
    !a.version ? (a.error ?? "no answer") : !sha.startsWith(a.version) ? `runs ${a.version}` : "not healthy";
  return `${off.map((a) => `${a.host} (${said(a)})`).join(", ")} ${off.length == 1 ? "tracks" : "track"} staging, and ${off.length == 1 ? "does" : "do"} not run ${sha.slice(0, 12)}, healthy. Deploy it there first (bun erga deploy <host>), and look at it.`;
}

/** The entries that track `branch` on the clone's origin. */
const tracking = (config: Config, clone: string, branch: string) => {
  const origin = repoName(sh(["git", "remote", "get-url", "origin"], { cwd: clone }).out);
  return config.instances.filter((e) => e.branch == branch && repoName(e.repo) == origin);
};

/** Moves main forward to staging's head. The result: the commit, or null when main has it already. */
export async function promote(o: {
  dir: string;
  from?: From;
  print?: (line: string) => void;
  clone?: string;
  suite?: Suite;
  /** What each instance runs, and its health (running.ts): a fake, in the tests. */
  ask?: Ask;
}): Promise<string | null> {
  const clone = o.clone ?? ROOT;
  const command = "bun erga promote";
  const free = takeLock(o.dir, "main", command);
  const job = startJob(o.dir, { command, host: "main", from: o.from, print: o.print });
  const log = job.log;
  try {
    const sha = remoteHead(clone, "origin", "staging");
    if (!sha) throw new Error("origin has no branch staging.");
    const main = remoteHead(clone, "origin", "main");
    const f = sh(["git", "fetch", "--quiet", "origin", "staging", ...(main ? ["main"] : [])], { cwd: clone });
    if (!f.ok) throw new Error(`git fetch origin failed: ${f.err}`);
    job.note({ commit: sha });
    if (main == sha) {
      log(`main is at ${sha.slice(0, 12)} already, as staging: nothing to promote.`);
      job.end("ok");
      return null;
    }
    if (main && !isAncestor(clone, main, sha))
      throw new Error(`main (${main.slice(0, 12)}) has commits that staging (${sha.slice(0, 12)}) does not have: main moves forward only.`);
    log(`Promote staging's head ${sha.slice(0, 12)} to main${main ? ` (now ${main.slice(0, 12)})` : ""}:`);
    const run = await testRun({ dir: o.dir, clone, tree: treeOf(clone, sha)!, commit: sha, what: sha.slice(0, 12), log, suite: o.suite });
    const failed = gateRefusal(run, sha.slice(0, 12));
    if (failed) throw new Error(`${failed}\nmain stays.`);
    const ask = o.ask ?? instanceReader();
    const answers = await Promise.all(
      tracking(readConfig(o.dir), clone, "staging").map(async (e) => ({ host: e.host, ...(await ask(e)) }))
    );
    const no = promoteRefusal(sha, answers);
    if (no) throw new Error(`${no} main stays.`);
    for (const a of answers) log(`      ${a.host} runs ${a.version}, healthy.`);
    if (!answers.length) log("NOTE  No registered instance tracks staging: nothing ran this commit before main gets it.");
    pushTo({ clone, print: log }, sha, "main");
    for (const e of tracking(readConfig(o.dir), clone, "main"))
      log(`NEXT  ${e.host} tracks main. Deploy the commit to it: bun erga deploy ${e.host}`);
    job.end("ok");
    return sha;
  } catch (e) {
    job.end("failed", (e as Error).message);
    throw e;
  } finally {
    free();
  }
}
