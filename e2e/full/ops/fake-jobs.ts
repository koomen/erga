// The ops page (deploy/cli/ops-page.ts) with fake jobs, for e2e/full/ops/ops-page.e2e.ts: `bun fake-jobs.ts <clone>`.
// Its Merge and Deploy start no command: each writes a job record as the CLI does, then waits until the test writes
// the file `end` in the clone (its text: ok or failed), and ends the job with that result.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startJob } from "../../../deploy/cli/deploy";
import { serveOpsPage } from "../../../deploy/cli/ops-page";

const cwd = process.argv[2];
const dir = join(cwd, ".erga");
const end = join(cwd, "end");
const page = serveOpsPage({
  dir,
  cwd,
  port: 0,
  ask: async () => ({ version: null, healthy: null }),
  run: (args) => {
    const [cmd, what, third] = args;
    const job = startJob(dir, {
      command: cmd == "deploy" ? `bun erga deploy ${what} ${third}` : `bun erga merge ${what}`,
      host: cmd == "deploy" ? third : "staging",
      from: "page",
      print: () => {},
    });
    job.log("The job runs.");
    const done = (async () => {
      while (!existsSync(end)) await Bun.sleep(20);
      const result = readFileSync(end, "utf8").trim() == "ok" ? "ok" : "failed";
      rmSync(end);
      job.end(result);
      return { code: result == "ok" ? 0 : 1, out: "" };
    })();
    return { pid: process.pid, done };
  },
});
console.log(`The ops page: http://127.0.0.1:${page.server.port}/`);
