// Cloudflare Containers, for the factory's VMs (factory/cloudflare.ts), as the
// deploy pipeline (deploy/cloudflare.ts) and the image's push
// (factory/vm/push.ts) use them: plain API calls, platform-neutral.
//
// The factory's containers use the `durable_object` scheduling policy (as
// `wrangler deploy` does it since 4.14x):
//
//   1. the image is in the account's registry (registry.cloudflare.com/<account>/erga-factory:<tag>)
//      and prepared for Containers once (POST /containers/image-preparations, polled until ready);
//   2. the Worker's version names it: `containers: [{ name, class_name: "FactoryVm", images: { factory: <ref> } }]`
//      in its upload metadata, so FactoryVm starts it with ctx.container.images.factory;
//   3. the container application, made once, ties the FactoryVm namespace to Containers: its id is the
//      namespace's id (GET/POST /containers/applications).

import { DeployError, type Cloudflare } from "./cloudflare";

export const REGISTRY = "registry.cloudflare.com";

/** The Durable Object class whose objects own the factory's containers, and the image's name on the version. */
export const FACTORY_CLASS = "FactoryVm";
export const FACTORY_IMAGE_NAME = "factory";
/** The container application's name: as wrangler names one (<worker>-<class, lowercase>). */
export const factoryAppName = (worker: string) => `${worker}-${FACTORY_CLASS.toLowerCase()}`;

/**
 * An image's full reference in the account's registry, from its name: erga-factory:<tag>@sha256:<digest>
 * (Containers takes only digest-pinned images; the tag says which build it is).
 */
export const imageRef = (accountId: string, image: string) => (image.startsWith(`${REGISTRY}/`) ? image : `${REGISTRY}/${accountId}/${image}`);

/** An image name's parts: repository, tag and digest (each may be missing). */
export function imageParts(image: string): { repo: string; tag?: string; digest?: string } {
  const [named, digest] = image.split("@");
  const slash = named.lastIndexOf("/"), colon = named.lastIndexOf(":");
  return colon > slash ? { repo: named.slice(0, colon), tag: named.slice(colon + 1), digest } : { repo: named, digest };
}

/** A short-lived password for the account's registry. */
export async function registryCredentials(cf: Cloudflare, accountId: string, permissions: ("push" | "pull")[]): Promise<{ username: string; password: string }> {
  const c = await cf.call<{ username?: string; user?: string; password: string }>("POST", `/accounts/${accountId}/containers/registries/${REGISTRY}/credentials`, "get a password for the container registry", { expiration_minutes: 15, permissions });
  if (!c?.password) throw new DeployError("Cloudflare gave no password for the container registry.");
  return { username: c.username ?? c.user ?? "v1", password: c.password };
}

/** The registry's digest for this image (by its digest if it names one, else its tag), or null if it hasn't it; over its HTTP API. */
export async function registryDigest(cf: Cloudflare, accountId: string, image: string, fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch): Promise<string | null> {
  const { repo, tag, digest } = imageParts(imageRef(accountId, image).slice(REGISTRY.length + 1));
  const { username, password } = await registryCredentials(cf, accountId, ["pull"]);
  const r = await fetcher(`https://${REGISTRY}/v2/${repo}/manifests/${digest ?? tag ?? "latest"}`, {
    method: "HEAD",
    headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}`, Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json" },
  });
  if (r.status == 404) return null;
  if (!r.ok) throw new DeployError(`The container registry answered ${r.status} for ${image}.`);
  return r.headers.get("docker-content-digest") ?? digest ?? null;
}

/** Prepares an image for Containers (polled until it's ready): needed once per image before a version can name it. */
export async function prepareImage(cf: Cloudflare, accountId: string, ref: string, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<void> {
  for (let tries = 0; ; tries++) {
    const p = await cf.call<{ status: string; reason?: string }>("POST", `/accounts/${accountId}/containers/image-preparations`, `prepare the factory's image (${ref}) for Containers`, { image: ref });
    if (p?.status == "ready") return;
    if (p?.status == "error") throw new DeployError(`Cloudflare couldn't prepare ${ref}: ${p.reason ?? "it said it failed"}.`);
    if (tries >= 450) throw new DeployError(`Preparing ${ref} took more than 15 minutes. Deploy again later.`);
    await sleep(2000);
  }
}

/** The FactoryVm namespace's id on the Worker (its settings' bindings), or null if it has none yet. */
export async function factoryNamespace(cf: Cloudflare, accountId: string, worker: string): Promise<string | null> {
  const s = await cf.call<{ bindings?: { type: string; class_name?: string; namespace_id?: string }[] }>("GET", `/accounts/${accountId}/workers/scripts/${worker}/settings`, `read ${worker}'s settings`);
  return s?.bindings?.find((b) => b.type == "durable_object_namespace" && b.class_name == FACTORY_CLASS && b.namespace_id)?.namespace_id ?? null;
}

/**
 * The container application for the Worker's FactoryVm namespace: made if it's missing, checked if it's there.
 * "made" or "there"; throws if an application of that id isn't the factory's.
 */
export async function ensureFactoryApp(cf: Cloudflare, accountId: string, worker: string, namespaceId: string): Promise<"made" | "there"> {
  const acc = `/accounts/${accountId}/containers/applications`;
  const name = factoryAppName(worker);
  const found = await cf.call<{ id: string; name: string; scheduling_policy?: string; durable_objects?: { namespace_id?: string } }>("GET", `${acc}/${namespaceId}`, "read the factory's container application", undefined, { allow404: true });
  if (found) {
    if (found.name != name || found.scheduling_policy != "durable_object" || found.durable_objects?.namespace_id != namespaceId) {
      throw new DeployError(`The container application ${namespaceId} is ${found.name} (${found.scheduling_policy}), not the factory's ${name}: it stops here.`);
    }
    return "there";
  }
  await cf.call("POST", acc, "make the factory's container application", { name, scheduling_policy: "durable_object", durable_objects: { namespace_id: namespaceId }, observability: { logs: { enabled: true } } });
  return "made";
}
