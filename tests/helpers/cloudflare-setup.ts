// `bun erga setup` on Cloudflare for a test (tests/erga-setup.test.ts), against the mock Cloudflare
// (ERGA_DEPLOY_MOCK=1: one mock for the process): one process runs the real command several times, one run after the
// other, on one account.
//
//   bun tests/helpers/cloudflare-setup.ts '<JSON: each run's arguments, after the host>'
//
// A run ["old-deployer"] is no run of the command: it puts a deployer from before the deployer kept its own token in
// the account (its token is a secret of its Worker), as an older setup left it.
//
// The command's .erga folder is beside the clone that GIT_DIR names (deploy/cli/config.ts, ergaDir). After each run's
// lines comes one line, MARK and JSON: what the account has then, read through Cloudflare's API as setup reads it.
//
// The account has one instance that runs (next.example.com, the Worker erga-next), with an admin. It has no deployer
// at the start, and its auto-deploy is on for each commit: what a machine's auto-deploy reads (bun erga track).

import * as Effect from "effect/Effect";
import { type Entry, writeConfig } from "../../deploy/cli/config";
import { deployInstance } from "../../deploy/cli/deploy";
import { boundDatabase, d1Sql } from "../../deploy/deployer/cloudflare";
import { readControl, writeAuto } from "../../deploy/deployer/control";
import { setupMain } from "../../deploy/own/cli";
import { cloudflare } from "../../deploy/own/facts";
import { DIR } from "../../deploy/own/store";
import { DEPLOYER_TAG, deployerName } from "../../deploy/pipeline/deployer";
import { targetFacts } from "../../deploy/pipeline/pipeline";
import { FLEET_ACCOUNT, type mockCloudflare } from "../../dev/mock-cloudflare";
import { bootstrap, next, prepareRelease, ROOT } from "./deploys.ts";
import { writePass } from "./pass.ts";

export const MARK = "CLOUDFLARE-SETUP-RAN ";
export const HOST = "next.example.com";

if (import.meta.main) {
  // GIT_DIR chose the .erga folder (DIR, read at import). The commits and the release are this checkout's.
  delete process.env.GIT_DIR;
  const c = await cloudflare();
  if ("why" in c) throw new Error(c.why);
  const target = { account: FLEET_ACCOUNT, worker: "erga-next" };
  const acc = `/accounts/${FLEET_ACCOUNT}`;
  const sql = d1Sql(c.cf, target);
  await prepareRelease();
  await bootstrap({ fetch: c.net } as ReturnType<typeof mockCloudflare>);
  const entry: Entry = { host: HOST, repo: "github.com/koomen/erga", branch: "main", ...targetFacts(next()) };
  writeConfig(DIR, { instances: [entry] });
  writePass(DIR, Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim());
  await deployInstance({ dir: DIR, host: HOST, commit: "HEAD", net: c.net, print: () => {} });
  await c.cf.call("POST", `${acc}/d1/database/${await boundDatabase(c.cf, acc, target.worker)}/query`, "the admin", {
    sql: "INSERT INTO users (login, name, role, created) VALUES (?1, ?2, ?3, ?4)",
    params: ["ada", "Ada", "admin", 1],
  });
  await Effect.runPromise(writeAuto(sql, "commits"));

  for (const run of JSON.parse(process.argv[2]) as string[][]) {
    if (run[0] == "old-deployer") {
      const form = new FormData();
      form.set(
        "metadata",
        JSON.stringify({
          main_module: "worker.js",
          compatibility_date: "2026-09-01",
          bindings: [{ type: "secret_text", name: "CLOUDFLARE_API_TOKEN", text: "a-token-from-before" }],
          tags: [DEPLOYER_TAG],
        })
      );
      form.append("worker.js", new File(["export default {}"], "worker.js", { type: "application/javascript+module" }));
      await c.cf.call("PUT", `${acc}/workers/scripts/${deployerName(target.worker)}`, "upload a deployer from before", form);
      continue;
    }
    await setupMain([HOST, "--host", "cloudflare", ...run]);
    const scripts = (await c.cf.call<{ id: string }[]>("GET", `${acc}/workers/scripts`, "list the Workers")) ?? [];
    const settings = await c.cf.call<{ bindings?: { name: string; service?: string }[] }>(
      "GET",
      `${acc}/workers/scripts/${target.worker}/settings`,
      "read the instance's Worker"
    );
    console.log(
      `${MARK}${JSON.stringify({
        deployer: scripts.some((s) => s.id == deployerName(target.worker)),
        bound: settings?.bindings?.find((b) => b.name == "DEPLOYER")?.service ?? null,
        auto: (await Effect.runPromise(readControl(sql)))?.autoMode ?? null,
      })}`
    );
  }
}
