// What `bun erga setup` observes before each step of the flow (deploy/own/flow.ts, Seen): the login, the person's
// account, and the server as the world sees it. It looks at what the answers so far name, and no further. AWS's side
// is deploy/aws/setup.ts. Under ERGA_DEPLOY_MOCK=1, the account and the servers are a mock Cloudflare's
// (dev/mock-cloudflare.ts): nothing real.

import { entryOf, readConfig } from "../cli/config";
import { mocked, netOf } from "../cli/deploy";
import { Cloudflare, type Fetch } from "../pipeline/cloudflare-api";
import { WORKER_TAG } from "../pipeline/account";
import { machineCredential } from "../local-credential";
import { nothingSeen, type Seen } from "./flow";
import { type Answers, proxyExpects, sso, zoneOf } from "./plan";
import { DIR, loadSecrets, namesAt, type Setup } from "./store";

export interface Connection {
  cf: Cloudflare;
  /** The servers (and the API): site below, or the mock's. */
  net: Fetch;
  token: string;
}
let connection: Connection | null = null;

/** The Cloudflare API with this machine's login, or why there's none. One mock for the whole process, under ERGA_DEPLOY_MOCK. */
export async function cloudflare(): Promise<Connection | { why: string }> {
  if (connection) return connection;
  if (mocked()) {
    const m = await netOf({});
    return (connection = { cf: new Cloudflare(m.token, m.net), net: m.net, token: m.token });
  }
  const c = machineCredential();
  if (!c) return { why: "Not logged in to Cloudflare: run `bunx cf auth login`." };
  return (connection = { cf: new Cloudflare(c.token), net: site, token: c.token });
}

/**
 * fetch for a new server's address, with its name looked up at Cloudflare's DNS (DNS over HTTPS), not this machine's:
 * a name asked for a moment before it existed stays "not found" in the machine's cache for up to 30 minutes.
 */
const addresses = new Map<string, { ip: string; at: number }>();
export const site: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const host = url.hostname;
    let known = addresses.get(host);
    if (!known || Date.now() - known.at > 30_000) {
      const r = (await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000),
      })
        .then((x) => x.json())
        .catch(() => null)) as { Answer?: { type: number; data: string }[] } | null;
      const ip = r?.Answer?.find((a) => a.type == 1)?.data;
      // Not in Cloudflare's DNS yet: say so, and never ask this machine, which would remember "no such host".
      if (!ip) throw new TypeError(`${host} isn't in DNS yet`);
      known = { ip, at: Date.now() };
      addresses.set(host, known);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("Host", url.host);
    url.hostname = known.ip;
    return fetch(url, { ...init, headers, tls: { serverName: host } } as RequestInit);
  },
  { preconnect: fetch.preconnect }
);

/** Reads a site's JSON answer, or null. */
export async function getJson<T>(net: Fetch, url: string): Promise<T | null> {
  const r = await net(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => null)) as T | null) : null;
}

type SignIn = NonNullable<Seen["live"]>["signIn"];

/** Where /auth/github sends a person: GitHub, with this client id and this host's callback, or what's wrong. */
export async function signInCheck(net: Fetch, host: string, clientId: string | undefined): Promise<SignIn> {
  const r = await net(`https://${host}/auth/github`, { redirect: "manual", signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) return null;
  const to = r.headers.get("location") ?? "";
  if (r.status < 300 || r.status > 399 || !to.startsWith("https://github.com/login/oauth/authorize"))
    return { bad: `/auth/github answers ${r.status}${to ? ` and sends to ${to.slice(0, 80)}` : ""}, not to GitHub` };
  const q = new URL(to).searchParams;
  if (clientId && q.get("client_id") != clientId)
    return { bad: `it signs in with the app ${q.get("client_id")}, not yours (${clientId}): deploy again` };
  if (q.get("redirect_uri") != `https://${host}/auth/github/callback`) return { bad: `GitHub would come back to ${q.get("redirect_uri")}` };
  return "ok";
}

/**
 * The proxy mode: where the proxy in front sends a browser that isn't signed in. To the company's sign-in, away from
 * this host, or what's wrong. `to`: the host it must send to (Cloudflare Access: the team's). `clientId`, `callback`:
 * the client and the callback it must name there (AWS's proxy has its own, /oauth2/idpresponse).
 */
export async function proxySignInCheck(
  net: Fetch,
  host: string,
  o: { to?: string; clientId?: string; callback?: string }
): Promise<SignIn> {
  const r = await net(`https://${host}/auth/sign-in`, { redirect: "manual", signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r) return null;
  const to = r.headers.get("location") ?? "";
  if (r.status != 302 || !to.startsWith("https://") || new URL(to).host == host)
    return {
      bad: `/auth/sign-in answers ${r.status}${to ? ` and sends to ${to.slice(0, 80)}` : ""}, not to the sign-in at the proxy in front`,
    };
  if (o.to && new URL(to).host != o.to) return { bad: `the proxy sends a browser to ${new URL(to).host}, not to ${o.to}` };
  const q = new URL(to).searchParams;
  if (o.clientId && q.get("client_id") != o.clientId)
    return { bad: `the proxy signs in with the client ${q.get("client_id")}, not yours (${o.clientId})` };
  if (o.callback && q.get("redirect_uri") != o.callback) return { bad: `the sign-in would come back to ${q.get("redirect_uri")}` };
  return "ok";
}

/** Whether sign-in works on the instance: the GitHub App's, or with single sign-on the proxy's. */
export const checkSignIn = (net: Fetch, a: Answers, githubId: string | undefined) =>
  sso(a) ? proxySignInCheck(net, a.host, proxyExpects(a)) : signInCheck(net, a.host, githubId);

/** The server as the world sees it: the commit it answers with, its health, and its sign-in. */
export async function liveOf(net: Fetch, a: Answers, githubId: string | undefined): Promise<Seen["live"]> {
  const v = await getJson<{ version?: string }>(net, `https://${a.host}/api/deploys/version`);
  if (!v) return { version: null, healthy: false, signIn: null };
  const h = await getJson<{ ok?: boolean }>(net, `https://${a.host}/api/health`);
  return { version: v.version ?? null, healthy: !!h?.ok, signIn: await checkSignIn(net, a, githubId) };
}

/** What the flow decides from, on Cloudflare: the login, the accounts that hold the domain, and the server. */
export async function observe(setup: Setup, dir = DIR): Promise<Seen> {
  const a = setup.flow.answers;
  // The person who claimed the server: the setup's own record, while the entry has their token.
  const seen: Seen = { ...nothingSeen, admin: entryOf(readConfig(dir), a.host)?.token ? setup.flow.seen.admin || "an admin" : "" };
  if (!a.where) return seen;
  if (a.where == "aws") return (await import("../aws/setup")).observeAws(dir, setup, seen, site);
  const c = await cloudflare();
  if ("why" in c) return { ...seen, login: { ok: false, why: c.why } };
  const { cf, net } = c;
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
  const n = namesAt(a.host, dir);
  const scripts =
    (await cf
      .call<{ id: string; tags?: string[]; named_handlers?: { name?: string }[] }[]>("GET", `${acc}/workers/scripts`, "list your Workers")
      .catch(() => [])) ?? [];
  const found = scripts.find((x) => x.id == n.worker);
  const ours = !!found && (!!found.tags?.includes(WORKER_TAG) || !!found.named_handlers?.some((h) => h.name == "DocumentObject"));
  if (found && !ours) seen.taken = `a Worker called ${n.worker} is there, and it isn't Erga`;
  const domains =
    (await cf
      .call<{ hostname: string; service: string }[]>(
        "GET",
        `${acc}/workers/domains?hostname=${encodeURIComponent(a.host)}`,
        "read custom domains"
      )
      .catch(() => [])) ?? [];
  const domain = domains.find((d) => d.hostname == a.host);
  if (domain && domain.service != n.worker) seen.taken = `it is the address of the Worker ${domain.service}`;
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
        `${acc}/workers/scripts/${n.worker}/settings`,
        "read the Worker's settings"
      )
      .catch(() => null);
    seen.held = (settings?.bindings ?? []).filter((b) => b.type == "secret_text").map((b) => b.name);
    seen.live = await liveOf(net, a, setup.github?.clientId);
  }
  seen.app = !!setup.github && (!!loadSecrets(dir)[a.host]?.GITHUB_CLIENT_SECRET || seen.held.includes("GITHUB_CLIENT_SECRET"));
  return seen;
}
