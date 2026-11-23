// `bun erga setup` on an instance that runs with an admin, for a test (tests/erga-setup.test.ts), against the mock
// Cloudflare (ERGA_DEPLOY_MOCK=1: one mock for the process): one process runs the real command several times, one run
// after the other.
//
//   bun tests/helpers/cloudflare-move.ts '<JSON: each run's arguments, after the host and --host cloudflare>'
//
// The instance (move.example.com, the Worker move-example-com) is as setup made it: GitHub or Google sign-in, the
// documents' pages on the shared workers.dev address. It has three accounts: koomen (an admin), ada and bo.
//
// The command's .erga folder is beside the clone that GIT_DIR names (deploy/cli/config.ts, ergaDir). After each run's
// lines comes one line, MARK and JSON: what the entry and the account have then.

import { type CloudflareEntry, entryOf, readConfig } from "../../deploy/cli/config";
import { boundDatabase } from "../../deploy/deployer/cloudflare";
import { setupMain } from "../../deploy/own/cli";
import { cloudflare } from "../../deploy/own/facts";
import { accountsOf, firstDeploy, queryOf } from "../../deploy/own/first";
import { noAnswers } from "../../deploy/own/plan";
import { DIR } from "../../deploy/own/store";
import { FLEET_ACCOUNT } from "../../dev/mock-cloudflare";
import { prepareRelease, ROOT } from "./deploys.ts";
import { writePass } from "./pass.ts";

export const MARK = "CLOUDFLARE-MOVE-RAN ";
export const HOST = "move.example.com";
export const WORKER = "move-example-com";

if (import.meta.main) {
  // GIT_DIR chose the .erga folder (DIR, read at import). The commits and the release are this checkout's.
  delete process.env.GIT_DIR;
  const c = await cloudflare();
  if ("why" in c) throw new Error(c.why);
  const acc = `/accounts/${FLEET_ACCOUNT}`;
  await prepareRelease();
  writePass(DIR, Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim());
  const zones = (
    (await c.cf.call<{ name: string }[]>("GET", `/zones?account.id=${FLEET_ACCOUNT}&per_page=50`, "list the domains")) ?? []
  ).map((z) => z.name);
  const subdomain = (await c.cf.call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read the subdomain"))?.subdomain ?? null;
  await firstDeploy({
    dir: DIR,
    answers: { ...noAnswers(HOST), where: "cloudflare", account: FLEET_ACCOUNT, deploys: "local" },
    seen: { zones, subdomain, held: [] },
    net: c.net,
    token: c.token,
    print: () => {},
  });
  const db = await boundDatabase(c.cf, acc, WORKER);
  for (const [login, role] of [
    ["koomen", "admin"],
    ["ada", "user"],
    ["bo", "user"],
  ])
    await c.cf.call("POST", `${acc}/d1/database/${db}/query`, "an account", {
      sql: "INSERT INTO users (login, name, role, created) VALUES (?1, ?2, ?3, ?4)",
      params: [login, login, role, 1],
    });

  for (const run of JSON.parse(process.argv[2]) as string[][]) {
    await setupMain([HOST, "--host", "cloudflare", ...run]);
    const entry = entryOf(readConfig(DIR), HOST) as CloudflareEntry;
    const scripts = (await c.cf.call<{ id: string }[]>("GET", `${acc}/workers/scripts`, "list the Workers")) ?? [];
    const settings = await c.cf.call<{ bindings?: { name: string; text?: string }[] }>(
      "GET",
      `${acc}/workers/scripts/${WORKER}/settings`,
      "read the instance's Worker"
    );
    const text = (name: string) => settings?.bindings?.find((b) => b.name == name)?.text ?? null;
    const { accounts } = await accountsOf(await queryOf(c.cf, acc, WORKER, "read the accounts"));
    console.log(
      `${MARK}${JSON.stringify({
        entry: { pages: entry.pages, sso: entry.vars.SSO ?? null, subdomain: entry.subdomain ?? null, repo: entry.repo },
        sso: text("SSO"),
        pagesDomain: text("PAGES_DOMAIN"),
        pagesHost: text("PAGES_HOST"),
        pagesWorker: scripts.some((s) => s.id == `${WORKER}-pages`),
        keeps: accounts.filter((x) => x.keeps).map((x) => `${x.login}=${x.keeps}`),
      })}`
    );
  }
}
