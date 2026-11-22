// What `bun erga setup` observes before each step of the flow (deploy/own/flow.ts, Seen): the login, the user's
// account, and the server as its platform shows it (never a request to the server). The dry run's checks are these. It looks at what the answers so far name, and no further. AWS's side
// is deploy/aws/setup.ts. Under ERGA_DEPLOY_MOCK=1, the account and the servers are a mock Cloudflare's
// (dev/mock-cloudflare.ts): nothing real.

import { entryOf, readConfig } from "../cli/config";
import { mocked, netOf } from "../cli/deploy";
import { Cloudflare, type Fetch } from "../deployer/cloudflare-api";
import { d1Api, healthRow, liveDeployment, liveRelease, readHealth, WORKER_TAG } from "../deployer/cloudflare";
import { keptLogin } from "../local-credential";
import { DEPLOYER_TAG, deployerName } from "../pipeline/deployer";
import { nothingSeen, type Seen } from "./flow";
import { type Answers, varsOf, zoneOf } from "./plan";
import { adminOn } from "./first";
import { DIR, namesAt } from "./store";

export interface Connection {
  /** The API with the login as it is at each call: a login that ends during a wait for the user is read again. */
  cf: Cloudflare;
  /** The Cloudflare API: fetch, or the mock's. */
  net: Fetch;
  /** The login's token now: a step takes its connection when it starts, not before a wait. */
  token: string;
}
let mock: Connection | null = null;
const login = keptLogin();

/** The Cloudflare API with this machine's login, or why there's none. One mock for the whole process, under ERGA_DEPLOY_MOCK. */
export async function cloudflare(): Promise<Connection | { why: string }> {
  if (mock) return mock;
  if (mocked()) {
    const m = await netOf({});
    return (mock = { cf: new Cloudflare(m.token, m.net), net: m.net, token: m.token });
  }
  const c = login();
  if (!c) return { why: "Not logged in to Cloudflare: run `bunx cf auth login`." };
  return { cf: new Cloudflare(() => login()?.token ?? c.token), net: globalThis.fetch.bind(globalThis), token: c.token };
}

type SignIn = NonNullable<Seen["live"]>["signIn"];

/**
 * Whether the settings that a release runs with are the sign-in that the answers name: with single sign-on the proxy
 * (`signer`: AWS's proxy, from the stack), and the GitHub app that the instance's entry names, if it names one
 * (`githubId`). A person's own sign-in, on the setup page, proves the rest: setup asks the server nothing.
 */
export function signInOf(a: Answers, githubId: string | undefined, vars: Record<string, string>, signer?: string): SignIn {
  const want: Record<string, string> = varsOf(a, githubId, signer);
  if ((want.PROXY_SIGN_IN ?? "") != (vars.PROXY_SIGN_IN ?? ""))
    return { bad: "the deployed sign-in at the proxy (PROXY_SIGN_IN) is not the one that the answers name: deploy again" };
  if ((want.GITHUB_CLIENT_ID ?? "") != (vars.GITHUB_CLIENT_ID ?? ""))
    return {
      bad: `it signs in with the app ${vars.GITHUB_CLIENT_ID || "(none)"}, not yours (${want.GITHUB_CLIENT_ID || "none"}): deploy again`,
    };
  return "ok";
}

/**
 * The server as Cloudflare shows it: the release of the Worker's version that serves, its health row, and its sign-in
 * settings.
 */
export async function liveOf(
  cf: Cloudflare,
  account: string,
  worker: string,
  a: Answers,
  githubId: string | undefined
): Promise<Seen["live"]> {
  const live = await liveDeployment(cf, account, worker).catch(() => null);
  if (!live) return { version: null, healthy: false, signIn: null };
  const r = await liveRelease(cf, account, worker, live.versionId);
  const row = r.database ? await healthRow(d1Api(cf, `/accounts/${account}`, r.database)).catch(() => null) : null;
  return { version: r.version, healthy: readHealth(row, r.version, Date.now()).healthy === true, signIn: signInOf(a, githubId, r.vars) };
}

/** What the flow decides from, on Cloudflare: the login, the accounts that hold the domain, and the server. */
export async function observe(a: Answers, dir = DIR, connect = cloudflare): Promise<Seen> {
  const entry = entryOf(readConfig(dir), a.host);
  const seen: Seen = { ...nothingSeen, vars: entry ? { ...entry.vars } : null, github: entry?.vars.GITHUB_CLIENT_ID ?? "" };
  if (!a.where) return seen;
  if (a.where == "aws") return (await import("../aws/setup")).observeAws(dir, a, seen);
  const c = await connect();
  if ("why" in c) return { ...seen, login: { ok: false, why: c.why } };
  const { cf } = c;
  const accounts = await cf.call<{ id: string; name: string }[]>("GET", "/accounts", "list your accounts").catch((e: Error) => e);
  if (accounts instanceof Error || !accounts)
    return { ...seen, login: { ok: false, why: accounts?.message ?? "Cloudflare listed no account." } };
  seen.login = { ok: true };
  const zonesOf = async (account: string) =>
    (await cf
      .call<{ id: string; name: string }[]>("GET", `/zones?account.id=${account}&per_page=50`, "list your domains")
      .catch(() => [])) ?? [];
  // The account comes from the address: each account with a domain that holds it.
  const all = await Promise.all(accounts.map(async (x) => ({ ...x, zones: await zonesOf(x.id) })));
  seen.choices = all
    .filter((x) =>
      zoneOf(
        a.host,
        x.zones.map((z) => z.name)
      )
    )
    .map(({ id, name }) => ({ id, name }));
  const account = all.find((x) => x.id == a.account);
  if (!account) return seen;
  seen.account = account.id;
  seen.zones = account.zones.map((z) => z.name);
  const acc = `/accounts/${account.id}`;
  seen.subdomain =
    (
      await cf
        .call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read your workers.dev subdomain", undefined, { allow404: true })
        .catch(() => null)
    )?.subdomain ?? null;
  const scripts =
    (await cf
      .call<{ id: string; tags?: string[]; named_handlers?: { name?: string }[] }[]>("GET", `${acc}/workers/scripts`, "list your Workers")
      .catch(() => [])) ?? [];
  const erga = (id: string) => {
    const x = scripts.find((x) => x.id == id);
    return !!x && (!!x.tags?.includes(WORKER_TAG) || !!x.named_handlers?.some((h) => h.name == "DocumentObject"));
  };
  const domains =
    (await cf
      .call<{ hostname: string; service: string }[]>(
        "GET",
        `${acc}/workers/domains?hostname=${encodeURIComponent(a.host)}`,
        "read custom domains"
      )
      .catch(() => [])) ?? [];
  const domain = domains.find((d) => d.hostname == a.host);
  // An Erga runs at the address, and this clone has no entry for it (another clone set it up): the instance is that
  // Worker, with its own name. A Worker that isn't Erga is never the instance: the address is in use.
  if (!entry && domain && erga(domain.service)) seen.adopt = domain.service;
  const worker = seen.adopt ?? namesAt(a.host, dir).worker;
  const ours = erga(worker);
  if (!ours && scripts.some((x) => x.id == worker)) seen.taken = `a Worker called ${worker} is there, and it isn't Erga`;
  if (domain && domain.service != worker) seen.taken = `it is the address of the Worker ${domain.service}`;
  const zone = account.zones.find((z) => z.name == zoneOf(a.host, seen.zones));
  if (!domain && zone) {
    const records =
      (await cf
        .call<{ type: string; content: string }[]>(
          "GET",
          `/zones/${zone.id}/dns_records?name=${encodeURIComponent(a.host)}`,
          "read DNS records"
        )
        .catch(() => [])) ?? [];
    if (records.length) seen.taken = `DNS has ${records.map((r) => `${r.type} ${r.content}`).join(", ")} for it`;
  }
  if (ours) {
    const settings = await cf
      .call<{ bindings?: { type: string; name: string }[] }>(
        "GET",
        `${acc}/workers/scripts/${worker}/settings`,
        "read the Worker's settings"
      )
      .catch(() => null);
    seen.held = (settings?.bindings ?? []).filter((b) => b.type == "secret_text").map((b) => b.name);
    seen.live = await liveOf(cf, account.id, worker, a, seen.github || undefined);
    seen.admin = !!(await adminOn(cf, acc, worker).catch(() => null));
    seen.deployer = !!scripts.find((x) => x.id == deployerName(worker))?.tags?.includes(DEPLOYER_TAG);
  }
  return seen;
}
