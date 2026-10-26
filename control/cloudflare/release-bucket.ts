// The release store (control/deploys/releases.ts) as this Worker has it: the control
// Worker's bucket (RELEASES, control/wrangler.jsonc); in local development,
// over the mock Cloudflare, one in memory that the deploys' object and the
// routes that serve it share. The app Workers on erga.dev have none.
import { memoryBlobs, r2Blobs, ReleaseStore } from "../deploys/releases";
import type { Env } from "../../cloudflare/env";

/** Local development's release store (ERGA_DEPLOY_MOCK): in memory, one per isolate. */
export const DEV_BLOBS = memoryBlobs();

/** The release store this Worker has, or null. */
export const releaseStoreOf = (env: Pick<Env, "RELEASES" | "ERGA_DEPLOY_MOCK">): ReleaseStore | null =>
  env.RELEASES ? new ReleaseStore(r2Blobs(env.RELEASES)) : env.ERGA_DEPLOY_MOCK == "1" ? new ReleaseStore(DEV_BLOBS) : null;
