// The deployer on Cloudflare, as setup installs it: deploy/deployer/worker.ts, bundled on this machine, in the person's
// own account as the Worker <the instance's Worker>-deployer. A person installs it, with their own login: it is a part
// of the instance's shape. Its code is the one of the checkout that ran setup, until the instance's next deploy: each
// deploy gives the deployer the code of the release that it deployed (updateDeployer, below, from a machine; the
// deployer in the cloud does the same for itself: deploy/deployer/worker.ts).
//
// What the Worker gets (deploy/deployer/worker.ts says what each is for): the instance's database as the binding DB
// and its id as plain text, the account and the instance's Worker as plain text, a secret of its own (KEY), its own
// Durable Object (its store), and the instance's Worker as a service. A schedule each minute. No route, no domain, and
// its workers.dev address is off: only the instance's Worker reaches it, through its own binding DEPLOYER, which the
// next deploy of the instance gives it (deploy/deployer/worker-form.ts).
//
// No token: the install gives the deployer none. A person pastes it on the instance, which hands it to the deployer
// (deploy/deployer/token.ts). Until then the deployer looks at GitHub, and deploys nothing.
//
// Trap: a Worker of that name that this code did not make is never replaced: the account may hold other things.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { boundDatabase, hasDeployer, setSchedule } from "../deployer/cloudflare";
import { type Cloudflare, DeployError } from "../deployer/cloudflare-api";
import type { CloudflareTarget } from "../deployer/spec";
import type { Release } from "../deployer/release-format";
import { DEPLOYER_TAG, deployerForm, deployerName } from "../deployer/worker-form";
import { ROOT } from "../root";

export { hasDeployer } from "../deployer/cloudflare";
export { DEPLOYER_TAG, deployerName } from "../deployer/worker-form";
/** The deployer's secret that seals its token (deploy/deployer/token.ts). */
const KEY = "KEY";

/** deploy/deployer/worker-main.ts as one module: what the Worker runs. `version`: the release that the code is of, which the deployer says. */
export async function deployerModule(version: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(ROOT, "deploy/deployer/worker-main.ts")],
    target: "browser",
    format: "esm",
    minify: true,
    define: { ERGA_DEPLOYER_VERSION: JSON.stringify(version) },
  });
  if (!built.success || built.outputs.length != 1)
    throw new DeployError({ message: `The deployer's code did not build: ${built.logs.map(String).join("; ") || "no module"}` });
  return built.outputs[0].text();
}

/**
 * Installs the instance's deployer, or brings the one that an earlier install made to this code: its bindings and its
 * schedule too. It keeps its secret and its store, and so the token that it holds. A new deployer gets a new secret,
 * and holds no token. A deployer from before the store held the token (it has no such secret) is replaced by a new
 * one. The result: the deployer's name; `kept`: it was there, and keeps what it held; `replaced`: it was there, from
 * before, and the new one holds nothing of it (its token is gone). The instance must be there: its Worker, bound to
 * its database.
 */
export async function installDeployer(
  cf: Cloudflare,
  target: Pick<CloudflareTarget, "account" | "worker">
): Promise<{ name: string; kept: boolean; replaced: boolean }> {
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
  const keeps = !!there && (await keepsToken(cf, target));
  if (there && !keeps) await removeDeployer(cf, target);

  // A deployer that is there keeps the secret that it holds.
  // Its code is this checkout's: it says this checkout's commit, as a release names its own.
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim().slice(0, 12) || "dev";
  const form = deployerForm(
    await deployerModule(commit),
    target.account,
    target.worker,
    database,
    keeps ? undefined : randomBytes(32).toString("hex")
  );
  await cf.call("PUT", `${acc}/workers/scripts/${name}`, "upload the deployer", form);
  // No address: only the instance's binding reaches the deployer. (A new Worker's workers.dev address can be on.)
  await cf.call("POST", `${acc}/workers/scripts/${name}/subdomain`, "turn the deployer's workers.dev address off", {
    enabled: false,
    previews_enabled: false,
  });
  await setSchedule(cf, acc, name);
  return { name, kept: keeps, replaced: !!there && !keeps };
}

/**
 * A deploy from a machine, after the instance answers healthy: the instance's deployer gets the release's own code
 * (deploy/release.ts builds it into each release), with the secret, the store and the token that it holds. The
 * result: what the deploy's log says of it; null: the instance has no deployer.
 */
export async function updateDeployer(
  cf: Cloudflare,
  target: Pick<CloudflareTarget, "account" | "worker">,
  release: Pick<Release, "version" | "deployer">
): Promise<string | null> {
  if (!(await hasDeployer(cf, target))) return null;
  const name = deployerName(target.worker);
  if (!release.deployer)
    return `The deployer ${name} keeps its code: release ${release.version} is from before a release carried the deployer's code.`;
  if (!(await keepsToken(cf, target)))
    return `The deployer ${name} keeps its code: it is from before the deployer kept its own token. Run the setup command again: it replaces it.`;
  const acc = `/accounts/${target.account}`;
  const database = await boundDatabase(cf, acc, target.worker);
  if (!database) return `The deployer ${name} keeps its code: the Worker ${target.worker} has no database.`;
  await cf.call(
    "PUT",
    `${acc}/workers/scripts/${name}`,
    "upload the deployer",
    deployerForm(release.deployer, target.account, target.worker, database)
  );
  return `The deployer ${name} has the code of release ${release.version} now. It holds what it held.`;
}

/**
 * Whether the deployer that is there keeps what it holds through an install: it has its own secret, which seals the
 * token in its store. A deployer from before that (its token was a secret of the Worker) is replaced by a new one.
 */
export async function keepsToken(cf: Cloudflare, target: Pick<CloudflareTarget, "account" | "worker">): Promise<boolean> {
  const settings = await cf.call<{ bindings?: { type: string; name: string }[] }>(
    "GET",
    `/accounts/${target.account}/workers/scripts/${deployerName(target.worker)}/settings`,
    "read the deployer's settings"
  );
  return !!settings?.bindings?.some((b) => b.type == "secret_text" && b.name == KEY);
}

/**
 * Removes the instance's deployer, when Erga made it: its Worker, and with it its store and the token that it held.
 * The instance then deploys from a machine only. The result: whether one was there.
 */
export async function removeDeployer(cf: Cloudflare, target: Pick<CloudflareTarget, "account" | "worker">): Promise<boolean> {
  if (!(await hasDeployer(cf, target))) return false;
  await cf.call("DELETE", `/accounts/${target.account}/workers/scripts/${deployerName(target.worker)}?force=true`, "remove the deployer");
  return true;
}
