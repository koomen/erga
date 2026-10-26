// GitHub: an admin connects a repository there (Connect GitHub on the Ops
// page: github.ts, the App), and the two sync (syncGithub): after each move
// here, staging, main and the release tags go to GitHub; after each push
// there (the App's webhook), what GitHub has comes in, the same way upstream
// does: staging fast-forwards, or gets a merge commit, or the merge waits on
// github-merge/<commit> with its conflicts (control/source/conflicts.ts);
// main moves only to a commit of staging.

import { ZERO } from "./git.ts";
import { fetchPack, lsRefs, receiveAdvert, receivePack, RemoteError, type RefUpdate, type Remote } from "./remote.ts";
import { GithubError, githubRemote as asRemote, type GithubLink, type PushEvent } from "./github.ts";
import { BRANCHES, GITHUB_MERGE_BRANCH, GITHUB_TRACK, REF, SourceError, TAGS, type Branch } from "./refs.ts";
import { isReleaseTag } from "./releases.ts";
import type { MergeConflict } from "./conflicts.ts";
import type { Actor, SourceRepo } from "./repo.ts";
import { byLine, SYSTEM, VIA } from "../../shared/attribution.ts";
import { plural } from "../../shared/time.ts";

/** GitHub, as the Ops page shows it: the repository connected (or none), the sync's state, and how its last run went. */
export interface GithubStatus {
  connected: boolean;
  link: GithubLink | null;
  /** off (not connected), idle, syncing. */
  state: "off" | "idle" | "syncing";
  /** When the last sync went through whole (ms), and for whom ("ada, via their admin agent"; "bo, via a push on GitHub"). */
  lastSyncAt: number | null;
  lastSyncBy: string | null;
  /** What stopped the last sync (part of it may have gone through), or null. */
  error: string | null;
  /** What GitHub's branches pointed to after the last sync. */
  refs?: Partial<Record<Branch, string>>;
}
/** The sync's record, kept: the status without the link and the state. */
type SyncRecord = Pick<GithubStatus, "lastSyncAt" | "lastSyncBy" | "error" | "refs">;

export class GithubSync {
  private syncing: Promise<GithubStatus> | null = null;
  private syncAgain = false;
  /** Whom the next sync with GitHub is for (byLine): whoever moved a branch, pushed on GitHub, or asked for it; and the actor of a merge it makes. */
  private syncBy = SYSTEM;
  private syncWho: Actor | null = null;
  /** The installation token in use (githubRemote). */
  private githubToken: { installationId: number; token: string; expiresAt: number } | null = null;

  constructor(private repo: SourceRepo) {}

  /** The repository on GitHub Erga is connected to (Connect GitHub on the Ops page), or null. */
  githubLink(): GithubLink | null {
    return this.repo.state<GithubLink>("github-link");
  }

  /** What the Ops page shows of GitHub: the link, the sync's state, and how its last run went. */
  githubStatus(): GithubStatus {
    const link = this.githubLink();
    const saved = this.repo.state<SyncRecord>("github") ?? { lastSyncAt: null, lastSyncBy: null, error: null };
    return { connected: !!link, link, state: !link ? "off" : this.syncing ? "syncing" : "idle", lastSyncAt: saved.lastSyncAt, lastSyncBy: saved.lastSyncBy ?? null, error: saved.error, ...(saved.refs ? { refs: saved.refs } : {}) };
  }

  /** Connected: the link kept, and a first sync (staging, main and the releases go there; what GitHub has comes in). */
  async connectGithub(link: GithubLink, by: string): Promise<GithubStatus> {
    this.repo.setState("github-link", link);
    this.repo.setState("github", { lastSyncAt: null, lastSyncBy: null, error: null } satisfies SyncRecord);
    this.githubToken = null;
    this.repo.deps.changed();
    return this.syncGithub(by, { login: SYSTEM, name: "Erga" });
  }

  /** Disconnected: the link forgotten, the App uninstalled from the account (where it can be), a waiting merge from GitHub dropped. */
  async disconnectGithub(): Promise<void> {
    const link = this.githubLink();
    if (!link) return;
    await this.repo.deps.githubUninstall?.(link.installationId).catch(() => {});
    this.repo.setState("github-link", null);
    this.repo.setState("github", { lastSyncAt: null, lastSyncBy: null, error: null } satisfies SyncRecord);
    this.githubToken = null;
    if (this.repo.state<MergeConflict>("conflict")?.kind == "github") await this.repo.conflicts.abandonUpdate();
    this.repo.deps.changed();
  }

  /** The linked repository as a Git remote, with an installation token (minted through the App; kept while it has ten minutes left). */
  private async githubRemote(link: GithubLink): Promise<Remote> {
    if (!this.repo.deps.githubToken)
      throw new SourceError("This server can't reach GitHub as the App (no key to mint installation tokens).", 503);
    if (
      !this.githubToken ||
      this.githubToken.installationId != link.installationId ||
      this.githubToken.expiresAt - this.repo.now() < 10 * 60_000
    ) {
      const t = await this.repo.deps.githubToken(link.installationId);
      this.githubToken = { installationId: link.installationId, ...t };
    }
    return asRemote(link.repo.cloneUrl, this.githubToken.token);
  }

  /**
   * A push event from the webhook: a sync, when it is the linked repository's (null: not ours). A push of ours echoed
   * back (GitHub's branch is where the last sync left it), or of something that isn't staging or main, syncs nothing.
   * `sender`: who pushed on GitHub.
   */
  githubPushed(event: PushEvent): Promise<GithubStatus> | null {
    const link = this.githubLink();
    if (!link || event.repository?.id != link.repo.id) return null;
    const branch = event.ref?.startsWith("refs/heads/") ? event.ref.slice("refs/heads/".length) : null;
    const saved = this.repo.state<SyncRecord>("github");
    if (!branch || !(BRANCHES as readonly string[]).includes(branch) || (saved?.refs?.[branch as Branch] == event.after && !saved?.error)) return Promise.resolve(this.githubStatus());
    const sender = event.sender?.login || event.pusher?.name || "someone";
    return this.syncGithub(byLine(sender, VIA.github), { login: sender, name: sender, via: VIA.github });
  }

  /**
   * Brings GitHub and this repository together: after each move here (in the background), after each push there
   * (the webhook), and on Sync now. What GitHub has that this repository doesn't comes in first (staging fast-forwards,
   * or a merge commit is made here; main only to a commit of staging), then staging, main and the release tags go
   * to GitHub. A failure is recorded, never blocks anything. `by`: for whom (byLine); `who`: the actor of a merge made here.
   */
  syncGithub(by: string = SYSTEM, who?: Actor): Promise<GithubStatus> {
    this.syncBy = by;
    if (who) this.syncWho = who;
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = (async () => {
      let status = this.githubStatus();
      do {
        this.syncAgain = false;
        this.repo.deps.changed();
        status = await this.syncOnce();
      } while (this.syncAgain);
      return status;
    })().finally(() => {
      this.syncing = null;
      this.syncWho = null;
      this.repo.deps.changed();
    });
    return this.syncing;
  }

  private async syncOnce(): Promise<GithubStatus> {
    const link = this.githubLink();
    if (!link) return this.githubStatus();
    const saved = this.repo.state<SyncRecord>("github") ?? { lastSyncAt: null, lastSyncBy: null, error: null };
    const record: SyncRecord = { lastSyncAt: saved.lastSyncAt, lastSyncBy: saved.lastSyncBy ?? null, error: null, ...(saved.refs ? { refs: saved.refs } : {}) };
    const by = this.syncBy, who = this.syncWho ?? { login: SYSTEM, name: "Erga" };
    const problems: string[] = [];
    try {
      const gh = await this.githubRemote(link);
      const remote = await this.repo.deps.artifacts();
      await this.repo.locked(async () => {
        const [{ refs }, { refs: tagRefs }, advert] = await Promise.all([lsRefs(remote), lsRefs(remote, TAGS), receiveAdvert(gh)]);
        await this.repo.sync(
          remote,
          BRANCHES.map((b) => refs.get(REF(b))).filter((s): s is string => !!s)
        );
        // In: what GitHub's branches have that ours don't. A branch there still where the last sync left it has nothing
        // new, whatever moved here since (a rewrite of staging here goes out as it is, as a push here allowed it).
        for (const b of BRANCHES) {
          const ours = refs.get(REF(b)) ?? null,
            theirs = advert.refs.get(REF(b)) ?? null;
          if (
            !theirs ||
            theirs == ours ||
            theirs == saved.refs?.[b] ||
            (ours && this.repo.known(theirs) && this.repo.isAncestor(theirs, ours))
          )
            continue;
          const r = await this.takeFromGithub(remote, gh, b, ours, theirs, refs, who);
          if ("problem" in r) problems.push(r.problem);
          else refs.set(REF(b), r.head);
        }
        // Out: our branches and release tags, where GitHub is behind (or has nothing).
        const updates: RefUpdate[] = [];
        for (const [ref, sha] of tagRefs) if (isReleaseTag(ref.slice(TAGS.length)) && !advert.refs.has(ref)) updates.push({ ref, old: ZERO, new: sha });
        for (const b of BRANCHES) {
          const ours = refs.get(REF(b)), theirs = advert.refs.get(REF(b)) ?? ZERO;
          if (!ours || ours == theirs) continue;
          // GitHub's head isn't behind ours, nor where we left it: the take above said why, and a push would drop its commits.
          if (theirs != ZERO && theirs != saved.refs?.[b] && !(this.repo.known(theirs) && this.repo.isAncestor(theirs, ours))) continue;
          updates.push({ ref: REF(b), old: theirs, new: ours });
        }
        if (updates.length) {
          const haves = [...advert.refs.values()].filter((s) => this.repo.known(s));
          const pack = await fetchPack(remote, { wants: updates.map((u) => u.new), haves });
          const r = await receivePack(gh, updates, pack);
          if (r.unpack != "ok") problems.push(`GitHub couldn't take the objects: ${r.unpack}`);
          else for (const u of updates) { const said = r.refs.get(u.ref) ?? "no answer"; if (said != "ok") problems.push(`GitHub refused ${u.ref.slice(11)}: ${said}`); }
        }
        // Where the sync left GitHub's branches: what it pushed, or GitHub's head when ours has it (taken in, or the same). A
        // head it refused (GitHub's main off staging) isn't ours to call synced: the last value stays, and the next pass
        // looks at it again.
        record.refs = Object.fromEntries(
          BRANCHES.map((b) => {
            const pushed = updates.find((u) => u.ref == REF(b))?.new,
              ours = refs.get(REF(b)),
              theirs = advert.refs.get(REF(b));
            return [
              b,
              pushed ?? (theirs && ours && this.repo.known(theirs) && this.repo.isAncestor(theirs, ours) ? theirs : saved.refs?.[b]),
            ];
          }).filter(([, s]) => s)
        );
      });
    } catch (e) {
      problems.push(e instanceof RemoteError || e instanceof SourceError || e instanceof GithubError ? e.message : `the sync failed: ${(e as Error).message}`);
    }
    if (!problems.length) {
      record.lastSyncAt = this.repo.now();
      record.lastSyncBy = by;
    }
    record.error = problems.length ? problems.join(". ").replace(/\.\.$/, ".") + (problems.join("").endsWith(".") ? "" : ".") : null;
    this.repo.setState("github", record);
    return this.githubStatus();
  }

  /**
   * GitHub's `branch` moved past ours (`theirs` isn't behind `ours`): its objects come in under a tracking branch, and
   * then staging fast-forwards, or merges (a merge commit here, or the conflict on its branch); main moves only to a
   * commit of staging. The new head, or why not. Inside the lock.
   */
  private async takeFromGithub(remote: Remote, gh: Remote, branch: Branch, ours: string | null, theirs: string, refs: Map<string, string>, who: Actor): Promise<{ head: string } | { problem: string }> {
    const track = `${GITHUB_TRACK}${branch}`;
    const tracked = refs.get(track) ?? null;
    if (tracked != theirs) {
      const haves = [...new Set([tracked, ours, ...this.repo.heads()].filter((s): s is string => !!s && this.repo.known(s)))];
      const pack = await fetchPack(gh, { wants: [theirs], haves });
      const r = await receivePack(remote, [{ ref: track, old: tracked ?? ZERO, new: theirs }], pack);
      const said = r.unpack != "ok" ? r.unpack : r.refs.get(track) ?? "no answer";
      if (said != "ok") return { problem: `Artifacts didn't take GitHub's ${branch} (${said})` };
      refs.set(track, theirs);
    }
    await this.repo.sync(remote, [theirs]);
    const short = theirs.slice(0, 7);
    if (!this.repo.known(theirs)) return { problem: `GitHub's ${branch} (${short}) couldn't be read` };
    if (branch == "main") {
      const staging = refs.get(REF("staging"));
      if (!staging || !this.repo.isAncestor(theirs, staging))
        return {
          problem: `GitHub's main is at ${short}, which isn't a commit of staging. main only follows staging: push it to staging first (or move GitHub's main back)`,
        };
      if (ours && !this.repo.isAncestor(ours, theirs))
        return { problem: `GitHub's main is at ${short}, which isn't forward of main here (${ours.slice(0, 7)}): move GitHub's main back` };
      await this.repo.moveBranch(remote, "main", ours, theirs, null, who, "github");
      return { head: theirs };
    }
    if (!ours || this.repo.isAncestor(ours, theirs)) {
      await this.repo.moveBranch(remote, "staging", ours, theirs, null, who, "github");
      return { head: theirs };
    }
    // Both moved: a merge commit here, or the merge with its conflicts on a branch, for an admin.
    const waiting = this.repo.state<MergeConflict>("conflict");
    if (waiting)
      return {
        problem: `GitHub's staging (${short}) and staging here have each moved, and a merge already waits on conflicts (${waiting.branch}): resolve or drop it first`,
      };
    const merged = await this.repo.conflicts.threeWay(remote, {
      ours,
      theirs,
      base: this.repo.conflicts.mergeBase(ours, theirs),
      who,
      labels: { ours: "staging", theirs: `github/staging` },
      kind: "github",
      version: theirs.slice(0, 12),
      branch: `${GITHUB_MERGE_BRANCH}${theirs.slice(0, 12)}`,
      message: `Merge GitHub's staging (${short})`,
    });
    if (merged.result == "merged") return { head: merged.commit };
    const n = merged.conflict.files.length;
    return {
      problem: `GitHub's staging (${short}) conflicts with staging here in ${plural(n, "file")}: the merge waits on ${merged.conflict.branch}`,
    };
  }
}
