// The deployer on Cloudflare, as setup installs it: deploy/deployer/worker.ts, bundled on this machine, in the person's
// own account as the Worker <the instance's Worker>-deployer. A person installs it, with their own login: it is a part
// of the instance's shape. The deployer's own token is for the instance's Worker only, so the deployer can't change
// itself: its code is the one of the checkout that ran setup, until setup runs again.
//
// What the Worker gets (deploy/deployer/worker.ts says what each is for): the instance's database as the binding DB
// and its id as plain text, the account and the instance's Worker as plain text, the token as a secret, its own
// Durable Object (its store), and the instance's Worker as a service. A schedule each minute. No address: no route, no
// domain, and its workers.dev address is off.
//
// Trap: a Worker of that name that this code did not make is never replaced: the account may hold other things.

import { join } from "node:path";
import * as Effect from "effect/Effect";
import { boundDatabase, d1Sql, setSchedule } from "../deployer/cloudflare";
import { Cloudflare, DeployError, type Fetch } from "../deployer/cloudflare-api";
import { writeAuto } from "../deployer/control";
import type { CloudflareTarget } from "../deployer/spec";
import { ROOT } from "../root";

/** The tag of the Workers that this code made: an install replaces only those. */
export const DEPLOYER_TAG = "erga-deployer";
/** The Workers runtime's date for the deployer's code. */
const COMPATIBILITY_DATE = "2026-09-01";
const MODULE = "worker.js";
/** The class of the deployer's store (deploy/deployer/worker.ts). */
const STORE = "DeployerState";

/** The name of an instance's deployer. */
export const deployerName = (worker: string) => `${worker}-deployer`;

/** deploy/deployer/worker-main.ts as one module: what the Worker runs. */
export async function deployerModule(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(ROOT, "deploy/deployer/worker-main.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!built.success || built.outputs.length != 1)
    throw new DeployError({ message: `The deployer's code did not build: ${built.logs.map(String).join("; ") || "no module"}` });
  return built.outputs[0].text();
}

/**
 * Installs the instance's deployer, or replaces the one that an earlier install made: its code, its bindings, its
 * token, its schedule. `token`: the deployer's own token (for the instance's Worker only), which the person made; null:
 * the deployer that is there keeps the token that it holds, and gets this code (its store stays too). The result: the
 * deployer's name. The instance must be there: its Worker, bound to its database.
 */
export async function installDeployer(
  cf: Cloudflare,
  target: Pick<CloudflareTarget, "account" | "worker">,
  token: string | null
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
  if (token == null && !there)
    throw new DeployError({ message: `${target.worker} has no deployer to update: install it first, with a token (--deploys cloud).` });

  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({
      main_module: MODULE,
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [
        { type: "d1", name: "DB", database_id: database, id: database },
        { type: "plain_text", name: "DATABASE", text: database },
        { type: "plain_text", name: "ACCOUNT", text: target.account },
        { type: "plain_text", name: "WORKER", text: target.worker },
        // With no new token, the Worker keeps the secret that it holds (keep_bindings, below).
        ...(token == null ? [] : [{ type: "secret_text", name: "CLOUDFLARE_API_TOKEN", text: token }]),
        { type: "durable_object_namespace", name: "STATE", class_name: STORE },
        { type: "service", name: "INSTANCE", service: target.worker },
      ],
      ...(token == null ? { keep_bindings: ["secret_text"] } : {}),
      // The deployer's own store, as a declarative export (as the instance's Durable Objects: cloudflare.ts).
      exports: { [STORE]: { type: "durable-object", storage: "sqlite" } },
      // Each run says one line: Cloudflare keeps the lines, for a person who looks at the deployer.
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

/** Whether the account has the instance's deployer, as an install of Erga's made it. */
export async function hasDeployer(cf: Cloudflare, target: Pick<CloudflareTarget, "account" | "worker">): Promise<boolean> {
  const scripts =
    (await cf.call<{ id: string; tags?: string[] }[]>("GET", `/accounts/${target.account}/workers/scripts`, "list your Workers")) ?? [];
  return !!scripts.find((s) => s.id == deployerName(target.worker))?.tags?.includes(DEPLOYER_TAG);
}

/**
 * Removes the instance's deployer, when Erga made it: its Worker, and with it the token that it held. The instance
 * then deploys from a machine only. The result: whether one was there.
 */
export async function removeDeployer(cf: Cloudflare, target: Pick<CloudflareTarget, "account" | "worker">): Promise<boolean> {
  if (!(await hasDeployer(cf, target))) return false;
  await cf.call("DELETE", `/accounts/${target.account}/workers/scripts/${deployerName(target.worker)}?force=true`, "remove the deployer");
  return true;
}

// ------------------------------------------------------------------ the deployer's token

/** What Erga found out about a token that a person made for the deployer. */
export interface TokenCheck {
  /** Why the token is refused: it is not for the instance's Worker, or it is for more than that. Empty: it is taken. */
  refused: string[];
  /** What Erga could not confirm about the token. Never a refusal: the person reads it. */
  unconfirmed: string[];
}

/** Cloudflare's status for one read with the token: 200, its refusal's status, or 0 for no answer. */
const statusOf = (cf: Cloudflare, path: string, what: string): Promise<number> =>
  cf.call("GET", path, what).then(
    () => 200,
    (e) => (e instanceof DeployError ? e.status : 0)
  );

/**
 * Checks a token for the deployer, with reads only: it must read the instance's Worker, and two reads that it must not
 * be able to make must fail (the account's D1 databases; another Worker of the account, which `own`, the person's own
 * login, finds). A token that can do more than the deployer needs is refused: it would stay in the cloud.
 *
 * Trap: this proves little. A token can't read its own permissions, and a check makes no change. So what the token
 * may write, and each permission that no read here tries, stays unconfirmed, and the result says so.
 */
export async function checkToken(
  net: Fetch,
  own: Cloudflare,
  target: Pick<CloudflareTarget, "account" | "worker">,
  token: string
): Promise<TokenCheck> {
  const acc = `/accounts/${target.account}`;
  const cf = new Cloudflare(token, net);
  const refused: string[] = [];
  const unconfirmed: string[] = [];
  const unclear = (what: string, status: number) =>
    unconfirmed.push(`${what}: Cloudflare gave no clear answer (${status ? `it answered ${status}` : "no answer"}).`);

  const reads = await statusOf(cf, `${acc}/workers/scripts/${target.worker}/settings`, `read ${target.worker}'s settings`);
  if (reads == 401) refused.push("Cloudflare does not know this token: it is not whole, it expired, or it is not a token of this account.");
  else if (reads == 403) refused.push(`The token can't read the Worker ${target.worker}. Give it that Worker, with the role Editor.`);
  else if (reads != 200) unclear(`Whether the token can read the Worker ${target.worker}`, reads);
  if (refused.length) return { refused, unconfirmed };

  const databases = await statusOf(cf, `${acc}/d1/database?per_page=1`, "list the account's D1 databases");
  if (databases == 200)
    refused.push("The token can read the account's D1 databases. The deployer needs no permission for D1: make a token without it.");
  // 401 too is a no: Cloudflare knows the token (the read above), and answers 401 for D1 to a token for one Worker
  // (recorded 2026-11-20, with a real one).
  else if (databases != 403 && databases != 401) unclear("Whether the token can read the account's D1 databases", databases);

  const others = ((await own.call<{ id: string }[]>("GET", `${acc}/workers/scripts`, "list your Workers")) ?? []).filter(
    (s) => s.id != target.worker
  );
  const other = others.find((s) => s.id == deployerName(target.worker)) ?? others[0];
  if (!other) unconfirmed.push(`That the token is for the Worker ${target.worker} only: the account has no other Worker to try it on.`);
  else {
    const reaches = await statusOf(cf, `${acc}/workers/scripts/${other.id}/settings`, `read ${other.id}'s settings`);
    if (reaches == 200) refused.push(`The token can read another Worker (${other.id}). Make a token for the Worker ${target.worker} only.`);
    else if (reaches != 403 && reaches != 404) unclear(`Whether the token can read another Worker (${other.id})`, reaches);
  }

  unconfirmed.push(
    `That the token may deploy to ${target.worker} (the role Editor): Erga changes nothing to try it. The first deploy from the cloud shows it.`,
    "That the token has no other permission than those tried here (D1, another Worker): Cloudflare shows a token's permissions on its own page only."
  );
  return { refused, unconfirmed };
}

/**
 * Cloud deploys for an instance, with the token that a person made for its deployer: the token is checked, the
 * deployer is installed with it, and auto-deploy is on. A token that the check refuses changes nothing: the error says
 * each reason. The result: what the check could not confirm, for the person to read.
 */
export async function installWithToken(
  net: Fetch,
  own: Cloudflare,
  target: Pick<CloudflareTarget, "account" | "worker">,
  token: string
): Promise<string[]> {
  const checked = await checkToken(net, own, target, token);
  if (checked.refused.length) throw new DeployError({ message: checked.refused.join("\n") });
  await installDeployer(own, target, token);
  await Effect.runPromise(writeAuto(d1Sql(own, target), "releases")).catch((e) => {
    throw new DeployError({
      message: `The deployer is installed, but auto-deploy is not on: ${e._tag == "NoTable" ? "the instance's database has no table for it yet (deploy the instance again, then set up again)" : e.message}`,
    });
  });
  return checked.unconfirmed;
}
