// The shape of an instance in its Cloudflare account, as setup's steps ask and make it (pipeline.ts): its Workers, its
// database, its zones and certificates, its buckets. A person's own login does these: the deployer (deploy/deployer/)
// changes code only, and has none of them.

import { bucketName } from "../deployer/cloudflare";
import { Cloudflare, DeployError } from "../deployer/cloudflare-api";
import type { Release } from "../deployer/release-format";
import type { Target } from "./pipeline";

/** The shared pages host's Worker: every request to the app, as it came (the app tells pages requests by their host, PAGES_HOST). */
export const PAGES_PROXY = `export default { fetch: (request, env) => env.APP.fetch(request) };\n`;

/**
 * Makes each R2 bucket the release binds that the target's account doesn't
 * have yet. A credential that may not read the account's buckets (a token
 * with no R2 permission) goes on: the upload says in Cloudflare's words
 * if a bucket is missing.
 */
export async function ensureBuckets(cf: Cloudflare, acc: string, release: Release, target: Target): Promise<void> {
  for (const [name, b] of Object.entries(release.worker.env)) {
    if (b.type != "r2") continue;
    const bucket = bucketName(target.workerName, name);
    const found = await cf.call<{ buckets?: { name: string }[] }>("GET", `${acc}/r2/buckets?name_contains=${encodeURIComponent(bucket)}`, `look for the R2 bucket ${bucket}`).catch((e) => {
      if (e instanceof DeployError && (e.status == 403 || e.status == 401)) return "not allowed" as const;
      throw e;
    });
    if (found == "not allowed" || found?.buckets?.some((x) => x.name == bucket)) continue;
    await cf.call("POST", `${acc}/r2/buckets`, `make the R2 bucket ${bucket} (documents' files)`, { name: bucket });
  }
}

/**
 * The account's Workers, as the account step needs them (is the target's
 * there, and is it Erga's). A token scoped to some Workers only may not list the account's: then the
 * target's own settings answer whether it's there and Erga's.
 */
export async function listScripts(
  cf: Cloudflare,
  acc: string,
  target: Target
): Promise<{ id: string; tags?: string[]; named_handlers?: { name?: string }[] }[]> {
  try {
    const all = (await cf.call<{ id: string; tags?: string[]; named_handlers?: { name?: string }[] }[]>("GET", `${acc}/workers/scripts`, "list your Workers")) ?? [];
    // A scoped token's list may hold only the Workers it can see: the target's own settings are the answer then.
    if (all.some((s) => s.id == target.workerName)) return all;
  } catch (e) {
    if (!(e instanceof DeployError && e.status == 403)) throw e;
  }
  const settings = await cf.call<{ tags?: string[]; bindings?: { type: string; class_name?: string }[] }>("GET", `${acc}/workers/scripts/${target.workerName}/settings`, `read ${target.workerName}'s settings`, undefined, { allow404: true });
  if (!settings) return [];
  const docHost = settings.bindings?.some((b) => b.type == "durable_object_namespace" && b.class_name == "DocumentObject");
  return [{ id: target.workerName, tags: settings.tags ?? [], named_handlers: docHost ? [{ name: "DocumentObject" }] : [] }];
}

/**
 * The state of the certificate for `hostname` on its zone ("active", "pending_validation", ...), read from Cloudflare:
 * the hostname's own certificate, else one that covers it by a wildcard. Null: none names it, or the credential may not
 * read the zone's certificates. The deploy says it; nothing asks the address itself.
 */
export async function certificateOf(cf: Cloudflare, zoneId: string, hostname: string): Promise<string | null> {
  const packs = await cf
    .call<{ hosts?: string[]; status?: string }[]>(
      "GET",
      `/zones/${zoneId}/ssl/certificate_packs?status=all`,
      `read ${hostname}'s certificate`
    )
    .catch(() => null);
  const wild = `*.${hostname.split(".").slice(1).join(".")}`;
  const pack = packs?.find((p) => p.hosts?.includes(hostname)) ?? packs?.find((p) => p.hosts?.includes(wild));
  return pack?.status ?? null;
}

/** A D1 database's id by name, or null. */
export async function findDatabase(cf: Cloudflare, acc: string, name: string): Promise<string | null> {
  return ((await cf.call<{ uuid: string; name: string }[]>("GET", `${acc}/d1/database?name=${encodeURIComponent(name)}`, "list your D1 databases")) ?? []).find((d) => d.name == name)?.uuid ?? null;
}

/** A zone's id, by its name, in the account. */
export async function zoneIdOf(cf: Cloudflare, accountId: string, name: string): Promise<string> {
  const zones = (await cf.call<{ id: string; name: string }[]>("GET", `/zones?name=${encodeURIComponent(name)}&account.id=${accountId}`, `find the zone ${name}`)) ?? [];
  const zone = zones.find((z) => z.name == name);
  if (!zone) throw new DeployError({ message: `The account has no zone called ${name}: add it to Cloudflare first.` });
  return zone.id;
}
