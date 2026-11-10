// The Worker, built one time for every test server of a run. A test server is `vite preview` on this build
// (dev/start.ts, ERGA_PREVIEW_ROOT): it starts in 0.7 s and takes 1 s of CPU. A dev server (`vite dev`) starts in 3 s
// and takes 5 s of CPU, for each of the 8 workers, as the run starts. The build is the development build
// (cloudflare.config.ts, ERGA_TEST_BUILD): the same Worker, with each server's settings from its own .dev.vars.
//
// The build writes .cloudflare/output in the checkout, where `bun deploy/release.ts` writes too. So it holds a lock
// for the second it takes, and moves the result to a folder of its own: the folder that this returns.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, ROOT } from "./env";

export function buildWorker(): string {
  const lock = join(ROOT, ".cloudflare/test-build.lock");
  mkdirSync(join(ROOT, ".cloudflare"), { recursive: true });
  for (const end = Date.now() + 120_000; ; ) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // Another run builds now. A lock older than a minute is a killed run's.
      const age = (() => {
        try {
          return Date.now() - statSync(lock).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if (age > 60_000 || Date.now() > end) rmSync(lock, { recursive: true, force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const out = join(ROOT, ".cloudflare/output");
    rmSync(out, { recursive: true, force: true });
    const r = spawnSync("node", ["--no-experimental-webstorage", "node_modules/vite/bin/vite.js", "build", "--mode", "development"], {
      cwd: ROOT,
      env: cleanEnv({ ERGA_TEST_BUILD: "1", ERGA_BUILT: "1" }),
      encoding: "utf8",
      timeout: 180_000,
    });
    if (r.status != 0)
      throw new Error(`the Worker's build for the tests failed (${r.error?.message ?? `exit ${r.status}`}):\n${r.stdout}\n${r.stderr}`);
    // A killed run's build stays behind: a build older than two hours goes.
    for (const name of readdirSync(tmpdir()))
      if (name.startsWith("erga-test-build-"))
        try {
          if (Date.now() - statSync(join(tmpdir(), name)).mtimeMs > 2 * 3600_000)
            rmSync(join(tmpdir(), name), { recursive: true, force: true });
        } catch {}
    const root = mkdtempSync(join(tmpdir(), "erga-test-build-"));
    mkdirSync(join(root, ".cloudflare"));
    try {
      renameSync(out, join(root, ".cloudflare/output"));
    } catch {
      // Another disk: a copy.
      cpSync(out, join(root, ".cloudflare/output"), { recursive: true });
      rmSync(out, { recursive: true, force: true });
    }
    return root;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
