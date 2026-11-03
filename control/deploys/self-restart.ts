// The deploys' object restarts into the control Worker's new code after the control Worker deploys itself.
//
// Cloudflare gives a busy Durable Object the new code only when it resets it, up to minutes after the upload: an open
// Ops page or a running deploy keeps it busy. On 2026-11-03 a staging deploy in that window ran the old pipeline and
// failed. So when the control Worker's deploy is over and recorded, the object restarts itself (Deps.restart:
// ctx.abort), as soon as no deploy runs and no release publishes. A deploy that comes in between waits for the restart,
// and its target says so. The new object runs the new code, picks up what waits, and restarts no more: the version
// its code runs (Deps.runs, its ERGA_VERSION) is the one deployed.

import type { BranchDeploys } from "./branches";

const KEY = "restart";

export class SelfRestart {
  constructor(private readonly d: BranchDeploys) {}

  /** The control Worker deployed `version`: kept, so the restart comes even after a restart of another cause. */
  async deployed(version: string): Promise<void> {
    if (this.d.deps.restart) await this.d.deps.storage.put(KEY, version);
  }

  /** The release this object must restart into before it starts another deploy, or null. */
  async due(): Promise<string | null> {
    const version = await this.d.deps.storage.get<string>(KEY);
    if (!version || !this.d.deps.restart) return null;
    if (this.d.deps.runs == version) {
      await this.d.deps.storage.delete?.(KEY);
      return null;
    }
    return version;
  }

  /** Restarts now if one is due (call it with nothing running): true if it did. The alarm comes again for what waits. */
  async now(): Promise<boolean> {
    const version = await this.due();
    if (!version) return false;
    await this.d.deps.storage.delete?.(KEY);
    await this.d.deps.schedule(0);
    console.log(`the control Worker runs release ${version}: the deploys restart into its code`);
    this.d.deps.restart!(`the control Worker deployed release ${version}`);
    return true;
  }
}
