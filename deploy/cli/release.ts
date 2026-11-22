// `bun erga release [vX.Y.Z|major|minor|patch] [--dry-run]`: tags origin/main with the next semver version and creates
// a GitHub Release with notes from the commits since the last tag. Only runs when Pete asks. Refuses to tag a main
// commit whose tests have not passed (the gate: .erga/tests/<tree>.json, or a fresh run when not --dry-run), and one
// that an instance which deploys every commit of main (its auto-deploy mode is commits: the staging instance) does
// not run, healthy: a commit that broke such an instance is not released. An instance that deploys only the releases
// is not asked.

import type { AutoMode } from "../deployer/tags";
import { type Entry, readConfig, repoName } from "./config";
import { nextVersion, latestTag, releaseNotes, releaseRefusal, runRefusal } from "./flow";
import { gateRefusal, testOf } from "./gate";
import { autoOn, reachOf, sqlOf } from "./instance";
import { commitsIn, fetchOrigin, headOf, repoOf, tagsOf } from "./observe";
import { type Ask, instanceReader } from "./running";
import { readRuns, type Suite, testRun, treeOf } from "./test-run";
import { ROOT, sh } from "../root";

export interface ReleaseOptions {
  /** .erga/ in the main clone (test records). */
  dir: string;
  /** Version bump or explicit vX.Y.Z (default: patch). */
  asked?: string;
  /** Preview version, notes and gate check without creating a tag or GitHub release. */
  dry?: boolean;
  /** The clone to inspect (default: this checkout). */
  clone?: string;
  /** Repository owner/name (default: origin's GitHub repo). */
  repo?: string;
  /** Skip git fetch origin (used by tests with local bare remotes already fetched). */
  noFetch?: boolean;
  /** Test suite override for tests. */
  suite?: Suite;
  /** Output logger. */
  log?: (line: string) => void;
  /** What each instance runs, and its health (running.ts): a fake, in the tests. */
  ask?: Ask;
  /** An instance's auto-deploy mode, from its own database (instance.ts, autoOn): a fake, in the tests. */
  modeOf?: (e: Entry) => Promise<AutoMode | null>;
  /** Override for `gh release create`, for tests. */
  create?: (o: { version: string; repo: string; sha: string; notes: string }) => string;
}

export interface ReleaseResult {
  version: string;
  sha: string;
  notes: string;
  url: string | null;
}

/** Cuts a numbered release on origin/main after verifying tests passed on that commit's tree. */
export async function runRelease(o: ReleaseOptions): Promise<ReleaseResult> {
  const clone = o.clone ?? ROOT;
  const log = o.log ?? console.log;
  const repo = o.repo ?? repoOf(clone);
  if (!repo) throw new Error("This checkout's origin is not a GitHub repository.");
  if (!o.noFetch) fetchOrigin(clone);
  const M = headOf("origin/main", clone);
  if (!M) throw new Error("There is no origin/main.");
  const tags = tagsOf(clone);
  const last = latestTag(tags.map((t) => t.name));
  const commits = commitsIn(clone, "--no-merges", ...(last ? [`${last}..origin/main`] : ["-n", "50", "origin/main"]));
  const no = releaseRefusal({ mainTagged: tags.find((t) => t.sha == M)?.name ?? null, commits: commits.length });
  if (no) throw new Error(no);
  const v = nextVersion(last, o.asked);
  if ("problem" in v) throw new Error(v.problem);
  const tree = treeOf(clone, M);
  if (!tree) throw new Error(`Cannot read the git tree of origin/main (${M.slice(0, 12)}).`);

  // Each instance that deploys every commit of main, on the clone's origin, ran this commit first.
  const origin = repoName(sh(["git", "remote", "get-url", "origin"], { cwd: clone }).out);
  const tracking = readConfig(o.dir).instances.filter((e) => e.branch == "main" && repoName(e.repo) == origin);
  const modeOf = o.modeOf ?? (async (e: Entry) => autoOn(await sqlOf(e, await reachOf(e))));
  const modes = await Promise.all(tracking.map(modeOf));
  const every = tracking.filter((_, i) => modes[i] == "commits");
  const ask = every.length ? (o.ask ?? instanceReader()) : null;
  const answers = await Promise.all(every.map(async (e) => ({ host: e.host, ...(await ask!(e)) })));
  const off = runRefusal(M, answers);
  if (off) throw new Error(`${off}\nNot released.`);
  for (const a of answers) log(`      ${a.host} runs ${a.version}, healthy.`);
  if (!answers.length) log("NOTE  No registered instance deploys every commit of main: nothing ran this commit before its release.");

  // Gate: refuse to tag an untested or failing main commit.
  if (o.dry) {
    const t = testOf({ name: "main", tree }, readRuns(o.dir));
    if (t.at == "failed") throw new Error(`${gateRefusal(t.run, M.slice(0, 12))}\nNot released.`);
    if (t.at != "passed") throw new Error(`Tests have not passed on main (${M.slice(0, 12)}) yet. Run bun erga test origin/main first.`);
  } else {
    const run = await testRun({ dir: o.dir, clone, tree, commit: M, what: M.slice(0, 12), log, suite: o.suite });
    const failed = gateRefusal(run, M.slice(0, 12));
    if (failed) throw new Error(`${failed}\nNot released.`);
  }

  const notes = releaseNotes(last, commits);
  log(`Release ${v.version} at main ${M.slice(0, 12)} (${commits.length} commits since ${last ?? "the start"}).`);
  log("");
  log(notes);
  if (o.dry) {
    log("NOTE  A dry run: nothing is made. Without --dry-run, this makes the tag and the GitHub release.");
    return { version: v.version, sha: M, notes, url: null };
  }
  const url = o.create
    ? o.create({ version: v.version, repo, sha: M, notes })
    : (() => {
        const r = sh(["gh", "release", "create", v.version, "-R", repo, "--target", M, "--title", v.version, "--notes-file", "-"], {
          cwd: clone,
          input: notes,
        });
        if (!r.ok) throw new Error(`gh release create failed: ${r.err}`);
        return r.out;
      })();
  if (!o.noFetch) fetchOrigin(clone);
  return { version: v.version, sha: M, notes, url };
}
