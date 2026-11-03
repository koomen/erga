// A pretend builder (control/builder/ is the real one), for the deploy tests and the dev server's ERGA_DEPLOY_MOCK.

import type { Builder } from "../control/deploys/branches";
import type { Release } from "../control/deploys/release-format";
import { sleep } from "../shared/time";

/**
 * A pretend builder (control/builder/ is the real one): it "builds" a commit
 * by handing back `release` stamped with the commit, saying what the real
 * one would run. `failNext` fails the next build once, and so does any commit
 * starting 0bad, or that `fails` says should; `built` lists what it built.
 */
export function mockBuilder(
  release: () => Promise<Release>,
  o: { delayMs?: number; fails?: (commit: string) => Promise<boolean> } = {}
): Builder & { built: string[]; stopped: string[]; failNext: string | null } {
  const b = {
    built: [] as string[],
    failNext: null as string | null,
    /** Builds stopped by their signal (the deploy was cancelled), by commit. */
    stopped: [] as string[],
    async build(
      { commit, branch, source }: { commit: string; branch: string; source: { cloneUrl: string; token?: string } },
      log: (line: string) => void,
      signal?: AbortSignal
    ): Promise<Release> {
      if (!source.token) throw new Error("no read token for the source");
      log(`fetching ${commit.slice(0, 12)} (${branch}) from ${source.cloneUrl}`);
      for (const step of ["bun install --frozen-lockfile", "bun run build", "bun run release"]) {
        if (o.delayMs) await sleep(o.delayMs);
        if (signal?.aborted) {
          b.stopped.push(commit);
          log("the build was stopped");
          throw signal.reason;
        }
        log(`$ ${step}`);
      }
      if (b.failNext) {
        const why = b.failNext;
        b.failNext = null;
        throw new Error(why);
      }
      // A commit starting 0bad fails to build (the dev server's mock, where failNext can't be reached).
      if (commit.startsWith("0bad") || (await o.fails?.(commit)))
        throw new Error("bun install --frozen-lockfile failed (exit 1): lockfile had changes, but lockfile is frozen");
      b.built.push(commit);
      return { ...(await release()), version: commit.slice(0, 12) };
    },
  };
  return b;
}
