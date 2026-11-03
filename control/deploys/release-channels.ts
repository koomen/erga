// The release store's channels, as the branch deploys move them (control/deploys/branches.ts): edge gets each healthy
// production deploy's release, published on its own after the deploy is over (it took 129 s on 2026-11-03, and the
// control Worker's deploy of the same commit waited for it), so no deploy waits for it; stable follows the highest
// release tag whose release is in the store.

import type { BranchDeploys, ReleaseTag } from "./branches";
import type { Release } from "./release-format";
import type { DeployName } from "../../deploy/targets";
import { compareVersions } from "../source/index.ts";

const KEY = "publishing";
type Job = { name: DeployName; deployId: string; commit: string; release: Release };

export class ReleaseChannels {
  /** A healthy production deploy's release, waiting for publish (in memory only: a restart loses the publication). */
  waiting: Job | null = null;
  /** The publish that runs now, apart from any deploy. */
  busy: Promise<void> | null = null;

  constructor(private readonly d: BranchDeploys) {}

  /** The release `name` publishes now, or null (its status: publishing). */
  publishing(name: DeployName): string | null {
    return this.waiting?.name == name ? this.waiting.release.version : null;
  }

  /**
   * Publishes `job`'s release on its own (not awaited): its note goes to the deploy's log at its end, and the alarm
   * that waits for it goes on. Its record in storage tells a new object that a restart stopped it (lost).
   */
  start(job: Job): void {
    this.waiting = job;
    if (this.busy) return;
    const storage = this.d.deps.storage;
    this.busy = (async () => {
      while (this.waiting) {
        const at = this.waiting;
        await storage.put(KEY, { name: at.name, deployId: at.deployId, version: at.release.version });
        const done = await this.publish();
        if (!done) {
          this.waiting = null;
          break;
        }
        await this.d.publishNote(done.name, done.deployId, done.note);
      }
      await storage.delete?.(KEY);
    })()
      .catch((e) => console.log(`the release wasn't published: ${(e as Error).message}`))
      .finally(() => {
        this.busy = null;
        this.d.wake();
      });
  }

  /** A publish a restart stopped: its deploy's log says so (Redeploy publishes it). */
  async lost(): Promise<void> {
    const storage = this.d.deps.storage;
    const was = this.busy ? null : await storage.get<{ name: DeployName; deployId: string; version: string }>(KEY);
    if (!was) return;
    await storage.delete?.(KEY);
    await this.d.publishNote(
      was.name,
      was.deployId,
      `release ${was.version} was not published to the release store: the server restarted while it published. Redeploy publishes it.`
    );
  }

  /**
   * Publishes the waiting release to the store, on edge, with no deploy running. Nothing here throws: answers the
   * deploy and the note for its log, or null when nothing waits.
   */
  async publish(): Promise<{ name: DeployName; deployId: string; note: string } | null> {
    const job = this.waiting;
    const store = this.d.deps.releases;
    if (!job || !store) return null;
    let note: string;
    try {
      const m = await store.publish(job.release, job.commit);
      await store.addTo("edge", job.release.version);
      note = `published release ${job.release.version} to the store (${Object.keys(m.files).length} files), on edge`;
      this.d.deps.logged?.({ type: "releases" });
      // A release tag waiting for this build: stable follows.
      await this.refreshStable().catch((e) => console.log(`stable wasn't refreshed: ${(e as Error).message}`));
    } catch (e) {
      note = `not published to the release store: ${(e as Error).message}`;
    }
    if (this.waiting == job) this.waiting = null;
    return { name: job.name, deployId: job.deployId, note };
  }

  /**
   * A release was cut (a tag vX.Y.Z on a commit of main: control/source/repo.ts). stable is the newest tag whose build is
   * in the store: put there now, or when production's deploy of that commit publishes it.
   */
  async tagged(t: ReleaseTag): Promise<void> {
    const storage = this.d.deps.storage;
    const tags = ((await storage.get<ReleaseTag[]>("tags")) ?? []).filter((x) => x.tag != t.tag);
    tags.push(t);
    await storage.put("tags", tags);
    await this.refreshStable();
  }

  /** stable: the highest release tag whose release is in the store. */
  private async refreshStable(): Promise<void> {
    const store = this.d.deps.releases;
    if (!store) return;
    const tags = ((await this.d.deps.storage.get<ReleaseTag[]>("tags")) ?? []).sort((a, b) => compareVersions(b.tag, a.tag));
    for (const t of tags) {
      const version = t.commit.slice(0, 12);
      if (!(await store.manifest(version))) continue;
      const stable = await store.channel("stable");
      if (stable.latest == version && stable.releases[0]?.tag == t.tag) return;
      await store.addTo("stable", version, t.by, t.tag);
      this.d.deps.releasesChanged?.();
      return;
    }
  }
}
