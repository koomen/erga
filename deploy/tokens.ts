// The Cloudflare API tokens Erga's own servers deploy with (each Worker's
// CLOUDFLARE_DEPLOY_TOKEN secret): made by deploy/setup.ts through the API,
// as narrow as Cloudflare allows, checked, then stored on the Worker.
//
//   staging's     Editor on erga-staging only
//   production's  Editor on erga and erga-staging (it may deploy both)
//
// and, for both, the same few account and zone permissions:
//
//   D1 Write                        the account's databases (Cloudflare has no per-database scope)
//   Zone Read, Workers Routes Read,
//   DNS Read                        erga.dev and erga-pages.dev only: read, never write
//
// What each permission is for (deploy/cloudflare.ts, runPipeline):
//
//   - Editor on a Worker ("Individual Workers Editor", the Specified Workers
//     scope): upload its versions and deploy them, its secrets (kept with
//     keep_bindings), its static assets, its settings; its Durable Objects
//     inherit it. It can't make or delete a Worker: the first deploy, from a
//     machine with the setup's own credential, makes it.
//   - D1 Write: staging's database is deleted and made afresh from
//     production's export on every deploy, and both apply migrations/.
//   - Read on the zones: find the zones by name, and check that the app's
//     custom domain, the pages' route and their DNS record are there and
//     point at this Worker. The setup's first deploy makes them; a deploy
//     after that changes none of them, so no deploy token can move erga.dev,
//     a route or a DNS record.
//   - No Artifacts permission: a server reads and writes Erga's source through
//     its Artifacts binding (worker/artifacts.ts), and the factory pushes
//     through the server's Git endpoint, so no API token is needed for it.
//   - No account read, no Workers Scripts on the account, nothing on the
//     builder (a service binding needs no permission on the Worker it binds).
//
// The rules are in deploy/targets.json (`deploys`): production's server may
// deploy staging and production, staging's may deploy staging only.

import { DeployError, zoneIdOf, type Cloudflare, type Fetch } from "./cloudflare";
import { SOURCE, TARGETS, type TargetName } from "./targets";

/** Cloudflare's names for the permission groups (GET /accounts/{id}/tokens/permission_groups). */
export const PERMISSION = {
  workerEditor: "Individual Workers Editor",
  d1Write: "D1 Write",
  zoneRead: "Zone Read",
  routesRead: "Workers Routes Read",
  dnsRead: "DNS Read",
} as const;

/** The permission groups' ids (Cloudflare's, the same in every account), for when the list can't be read. */
export const KNOWN_IDS: Record<string, string> = {
  "Individual Workers Editor": "7e79ec33834341f28dd431ab73884400",
  "D1 Write": "09b2857d1c31407795e75e3fed8617a1",
  "Zone Read": "c8fed203ed3043cba015a93ad1616f1f",
  "Workers Routes Read": "2072033d694d415a936eaeb94e6405b8",
  "DNS Read": "82e64a83756745bbbb1c9c2701bf816b",
};

/** One deploy token, as planned: its name, the Workers it may deploy, and the zones it may read. */
export interface TokenPlan {
  /** The token's name on Cloudflare (Manage Account › Account API Tokens). */
  name: string;
  /** The server it's for: the Worker that keeps it as CLOUDFLARE_DEPLOY_TOKEN. */
  target: TargetName;
  storedOn: string;
  /** Editor on these Workers only. */
  workers: string[];
  /** Read on these zones only. */
  zones: string[];
  /** Workers it must not reach (the check makes sure it can't). */
  notWorkers: string[];
}

/** The token for one of Erga's servers, from deploy/targets.json (`deploys`). */
export function tokenPlan(name: TargetName): TokenPlan {
  const spec = TARGETS[name];
  const deploys = spec.deploys.map((t) => TARGETS[t]);
  const all = Object.values(TARGETS);
  return {
    name: `erga-deploy-${name}`,
    target: name,
    storedOn: spec.worker,
    workers: deploys.map((t) => t.worker),
    zones: [...new Set(deploys.flatMap((t) => [t.zone, t.pages.zone]))],
    notWorkers: all.map((t) => t.worker).filter((w) => !deploys.some((t) => t.worker == w)),
  };
}

/** What the plan grants, in words (the setup shows it before it makes the token). */
export function describePlan(p: TokenPlan): string[] {
  return [
    `${PERMISSION.workerEditor}: ${p.workers.join(", ")} (nothing else)`,
    `${PERMISSION.d1Write}: the account's D1 databases (Cloudflare has no narrower scope for D1)`,
    `${PERMISSION.zoneRead}, ${PERMISSION.routesRead}, ${PERMISSION.dnsRead}: ${p.zones.join(", ")} (read only)`,
    `Artifacts: none in the token. ${p.storedOn}'s own Artifacts binding (namespace ${SOURCE.namespace} only) reads and writes Erga's source; the factory and pushes write through its Git endpoint (/git/erga.git)`,
  ];
}

/** The resource key of one Worker in a token policy: the Worker's tag (its id in GET /workers/scripts). */
export const workerResource = (tag: string) => `com.cloudflare.edge.worker.script.${tag}`;
export const zoneResource = (id: string) => `com.cloudflare.api.account.zone.${id}`;
export const accountResource = (id: string) => `com.cloudflare.api.account.${id}`;

/** A token policy. A Worker's resource sits under its account's (Cloudflare refuses it on its own, with a 1004). */
export interface Policy { effect: "allow"; permission_groups: { id: string; name?: string }[]; resources: Record<string, string | Record<string, string>> }

/** A policy's resource keys, nested ones (a Worker under its account) included. */
export const resourceKeys = (p: Pick<Policy, "resources">): string[] =>
  Object.entries(p.resources).flatMap(([k, v]) => (typeof v == "string" ? [k] : Object.keys(v)));

/** The permission groups' ids by name: the account's list, else the known ids. */
export async function permissionIds(cf: Cloudflare, accountId: string): Promise<Record<string, string>> {
  const list = await cf.call<{ id: string; name: string }[]>("GET", `/accounts/${accountId}/tokens/permission_groups`, "list the token permission groups").catch(() => null);
  const out: Record<string, string> = { ...KNOWN_IDS };
  for (const g of list ?? []) if (Object.values(PERMISSION).includes(g.name as never)) out[g.name] = g.id;
  return out;
}

/** The plan's policies, with the Workers' tags and the zones' ids looked up. */
export async function policiesFor(cf: Cloudflare, accountId: string, p: TokenPlan, ids: Record<string, string>): Promise<Policy[]> {
  const scripts = (await cf.call<{ id: string; tag?: string }[]>("GET", `/accounts/${accountId}/workers/scripts`, "list the Workers")) ?? [];
  const tags = p.workers.map((w) => {
    const tag = scripts.find((s) => s.id == w)?.tag;
    if (!tag) throw new DeployError(`There's no Worker called ${w} yet: a token can only name a Worker that exists (deploy it first).`);
    return tag;
  });
  const zones = await Promise.all(p.zones.map((z) => zoneIdOf(cf, accountId, z)));
  const group = (name: string) => ({ id: ids[name] });
  return [
    // Nested under the account: a Worker's key on its own is refused (code 1004, "server error when creating the token").
    { effect: "allow", permission_groups: [group(PERMISSION.workerEditor)], resources: { [accountResource(accountId)]: Object.fromEntries(tags.map((t) => [workerResource(t), "*"])) } },
    { effect: "allow", permission_groups: [group(PERMISSION.d1Write)], resources: { [accountResource(accountId)]: "*" } },
    { effect: "allow", permission_groups: [group(PERMISSION.zoneRead), group(PERMISSION.routesRead), group(PERMISSION.dnsRead)], resources: Object.fromEntries(zones.map((z) => [zoneResource(z), "*"])) },
  ];
}

/** Makes the token. Its value comes back once, here: the caller stores it as the Worker's secret and never prints it. */
export async function createToken(cf: Cloudflare, accountId: string, p: TokenPlan, policies: Policy[]): Promise<{ id: string; value: string }> {
  const made = await cf.call<{ id: string; value: string }>("POST", `/accounts/${accountId}/tokens`, `make the token ${p.name}`, { name: p.name, policies });
  if (!made?.id || !made.value) throw new DeployError(`Cloudflare made the token ${p.name} but didn't give its value.`);
  return made;
}

/** The account's other tokens by this name (older ones, to delete once the new one is stored). */
export async function olderTokens(cf: Cloudflare, accountId: string, p: TokenPlan, keep: string): Promise<string[]> {
  const list = await cf.call<{ id: string; name: string }[]>("GET", `/accounts/${accountId}/tokens?per_page=100`, "list the account's tokens").catch(() => null);
  return (list ?? []).filter((t) => t.name == p.name && t.id != keep).map((t) => t.id);
}

/**
 * Checks a token does what its plan says, and no more, with the token
 * itself: it's active; it reads each of its Workers' settings and its zones'
 * routes and DNS records, and lists the D1 databases; it can't read the
 * Workers it mustn't reach, nor write their secrets, nor write a DNS record
 * or a route. The writes are asked with an empty body, which Cloudflare
 * refuses before doing anything: a 403 says the permission is missing, as it
 * must be; anything else is a problem. Also reads the token's policies back
 * (with the setup's credential): exactly the plan's. Answers what's wrong
 * (nothing: []).
 */
export async function checkToken(o: { net: Fetch; admin: Cloudflare; accountId: string; plan: TokenPlan; id: string; value: string; policies: Policy[]; api?: string; tokens?: Cloudflare }): Promise<string[]> {
  const api = o.api ?? "https://api.cloudflare.com/client/v4";
  const acc = `/accounts/${o.accountId}`;
  const as = async (method: string, path: string, body?: unknown) => {
    const r = await o.net(`${api}${path}`, { method, headers: { Authorization: `Bearer ${o.value}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    await r.body?.cancel().catch(() => {});
    return r.status;
  };
  const wrong: string[] = [];
  const must = async (what: string, method: string, path: string) => { const s = await as(method, path); if (s != 200) wrong.push(`it can't ${what} (${s})`); };
  const mustNot = async (what: string, method: string, path: string, body?: unknown) => { const s = await as(method, path, body); if (s != 403 && s != 401 && s != 404) wrong.push(`it can ${what} (${s}), which it mustn't`); };

  const verify = await o.net(`${api}${acc}/tokens/verify`, { headers: { Authorization: `Bearer ${o.value}` } }).then((r) => r.json() as Promise<{ result?: { status?: string } }>).catch(() => null);
  if (verify?.result?.status != "active") wrong.push(`it isn't active (${verify?.result?.status ?? "no answer"})`);
  for (const w of o.plan.workers) await must(`read ${w}'s settings`, "GET", `${acc}/workers/scripts/${w}/settings`);
  await must("list the D1 databases", "GET", `${acc}/d1/database?per_page=1`);
  for (const z of o.plan.zones) {
    const id = await zoneIdOf(o.admin, o.accountId, z);
    await must(`read ${z}'s Worker routes`, "GET", `/zones/${id}/workers/routes`);
    await must(`read ${z}'s DNS records`, "GET", `/zones/${id}/dns_records?per_page=1`);
    await mustNot(`write ${z}'s DNS records`, "POST", `/zones/${id}/dns_records`, {});
    await mustNot(`write ${z}'s Worker routes`, "POST", `/zones/${id}/workers/routes`, {});
  }
  for (const w of o.plan.notWorkers) {
    await mustNot(`read ${w}'s settings`, "GET", `${acc}/workers/scripts/${w}/settings`);
    await mustNot(`write ${w}'s secrets`, "PUT", `${acc}/workers/scripts/${w}/secrets`, {});
  }
  await mustNot("make a Worker", "PUT", `${acc}/workers/scripts/erga-token-check-${o.plan.target}`, {});

  // Its policies, read back: exactly the plan's permission groups on exactly its resources.
  const back = await (o.tokens ?? o.admin).call<{ policies?: Policy[] }>("GET", `${acc}/tokens/${o.id}`, `read the token ${o.plan.name} back`).catch(() => null);
  if (!back?.policies) wrong.push("its policies couldn't be read back");
  else {
    const flat = (ps: Policy[]) => ps.flatMap((p) => p.permission_groups.flatMap((g) => resourceKeys(p).map((r) => `${g.id} ${r}`))).sort().join("\n");
    if (flat(back.policies) != flat(o.policies)) wrong.push("its policies aren't the plan's");
  }
  return wrong;
}

/**
 * What the credential that makes the tokens is (CLOUDFLARE_TOKEN_MAKER, or
 * the setup's own): an account-owned API token that's active and may make
 * account API tokens, or what's wrong with it, in words. `ok` false stops the
 * setup before it tries.
 */
export async function diagnoseMaker(o: { net: Fetch; accountId: string; value: string; api?: string }): Promise<{ ok: boolean; said: string[] }> {
  const api = o.api ?? "https://api.cloudflare.com/client/v4";
  const said: string[] = [];
  const v = o.value;
  if (/\s/.test(v) || v.length < 30 || v.length > 200) return { ok: false, said: [`It doesn't look like an API token (${v.length} characters${/\s/.test(v) ? ", with spaces or line breaks" : ""}): is the clipboard holding something else?`] };
  const get = async (path: string) => {
    const r = await o.net(`${api}${path}`, { headers: { Authorization: `Bearer ${v}` } }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { success?: boolean; result?: any; errors?: { code: number; message: string }[] } | null;
    return { status: r?.status ?? 0, ok: !!r?.ok && j?.success !== false, result: j?.result, errors: j?.errors ?? [] };
  };
  const acc = await get(`/accounts/${o.accountId}/tokens/verify`);
  if (!acc.ok) {
    const user = await get("/user/tokens/verify");
    if (user.ok) return { ok: false, said: [`It's a user API token (My Profile › API Tokens), not an account-owned one. Make it under Manage Account › Account API Tokens, with Account API Tokens Edit.`] };
    return { ok: false, said: [`Cloudflare doesn't know this token, for this account or as a user token (${acc.status}${acc.errors[0] ? `: ${acc.errors[0].message}` : ""}). It may be mistyped, deleted, or for another account.`] };
  }
  const status = acc.result?.status, expires = acc.result?.expires_on;
  if (status != "active") return { ok: false, said: [`It's an account token, but it isn't active (${status ?? "no status"}${expires ? `, expires ${expires}` : ""}).`] };
  said.push(`An account-owned token, active${expires ? ` until ${expires}` : ""}.`);
  const groups = await get(`/accounts/${o.accountId}/tokens/permission_groups`);
  const self = acc.result?.id ? await get(`/accounts/${o.accountId}/tokens/${acc.result.id}`) : null;
  const names = (self?.result?.policies as Policy[] | undefined)?.flatMap((p) => p.permission_groups.map((g) => g.name ?? g.id));
  if (names?.length) said.push(`Its permissions: ${[...new Set(names)].join(", ")}.`);
  const canMake = names ? names.some((n) => /^Account API Tokens (Write|Edit)$/i.test(n)) : groups.ok;
  if (!canMake) {
    said.push(`It can't make account API tokens${names ? "" : ` (it can't even list the permission groups: ${groups.status})`}: give it the permission Account › Account API Tokens › Edit.`);
    return { ok: false, said };
  }
  return { ok: true, said };
}
