// The deployer on Cloudflare, as setup installs it: deploy/deployer/worker.ts, bundled on this machine, in the person's
// own account as the Worker <the instance's Worker>-deployer. A person installs it, with their own login: it is a part
// of the instance's shape. The deployer's own token is for the instance's Worker only, so the deployer can't change
// itself.
//
// What the Worker gets (deploy/deployer/worker.ts says what each is for): the instance's database as the binding DB,
// the account and the instance's Worker as plain text, and the token as a secret. A schedule each minute. No address:
// no route, no domain, and its workers.dev address is off.
//
// Trap: a Worker of that name that this code did not make is never replaced: the account may hold other things.

import { join } from "node:path";
import { boundDatabase, setSchedule } from "../deployer/cloudflare";
import { type Cloudflare, DeployError } from "../deployer/cloudflare-api";
import type { CloudflareTarget } from "../deployer/spec";
import { ROOT } from "../root";

/** The tag of the Workers that this code made: an install replaces only those. */
export const DEPLOYER_TAG = "erga-deployer";
/** The Workers runtime's date for the deployer's code. */
const COMPATIBILITY_DATE = "2026-09-01";
const MODULE = "worker.js";

/** The name of an instance's deployer. */
export const deployerName = (worker: string) => `${worker}-deployer`;

/** deploy/deployer/worker.ts as one module, with Effect in it: what the Worker runs. */
export async function deployerModule(): Promise<string> {
  const built = await Bun.build({ entrypoints: [join(ROOT, "deploy/deployer/worker.ts")], target: "browser", format: "esm", minify: true });
  if (!built.success || built.outputs.length != 1)
    throw new DeployError({ message: `The deployer's code did not build: ${built.logs.map(String).join("; ") || "no module"}` });
  return built.outputs[0].text();
}

/**
 * Installs the instance's deployer, or replaces the one that an earlier install made: its code, its bindings, its
 * token, its schedule. `token`: the deployer's own token (for the instance's Worker only), which the person made. The
 * result: the deployer's name. The instance must be there: its Worker, bound to its database.
 */
export async function installDeployer(
  cf: Cloudflare,
  target: Pick<CloudflareTarget, "account" | "worker">,
  token: string
): Promise<string> {
  const acc = `/accounts/${target.account}`;
  const name = deployerName(target.worker);
  if (name.length > 63)
    throw new DeployError({
      message: `The Worker's name ${target.worker} is too long for a deployer beside it: ${name} has more than 63 characters.`,
    });
  const database = await boundDatabase(cf, acc, target.worker);
  if (!database)
    throw new DeployError({
      message: `The Worker ${target.worker} is not there, or it has no database. Deploy the instance first: its deployer binds its database.`,
    });
  const scripts = (await cf.call<{ id: string; tags?: string[] }[]>("GET", `${acc}/workers/scripts`, "list your Workers")) ?? [];
  const there = scripts.find((s) => s.id == name);
  if (there && !there.tags?.includes(DEPLOYER_TAG))
    throw new DeployError({
      message: `Your account has a Worker ${name} that Erga did not make. Erga does not replace it: rename it or delete it, then set up again.`,
    });

  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: MODULE,
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [
        { type: "d1", name: "DB", database_id: database, id: database },
        { type: "plain_text", name: "ACCOUNT", text: target.account },
        { type: "plain_text", name: "WORKER", text: target.worker },
        { type: "secret_text", name: "CLOUDFLARE_API_TOKEN", text: token },
      ],
      // Each look says one line: Cloudflare keeps the lines, for a person who looks at the deployer.
      observability: { enabled: true, logs: { enabled: true, invocation_logs: true } },
      tags: [DEPLOYER_TAG],
    })
  );
  form.append(MODULE, new File([await deployerModule()], MODULE, { type: "application/javascript+module" }));
  await cf.call("PUT", `${acc}/workers/scripts/${name}`, "upload the deployer", form);
  // No address: nothing calls the deployer. (A new Worker's workers.dev address can be on.)
  await cf.call("POST", `${acc}/workers/scripts/${name}/subdomain`, "turn the deployer's workers.dev address off", {
    enabled: false,
    previews_enabled: false,
  });
  await setSchedule(cf, acc, name);
  return name;
}
