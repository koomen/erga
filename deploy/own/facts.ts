// What `bun erga setup` observes before it decides anything: this machine, the person's Cloudflare account, and each
// server as the world sees it. Each fact is what was seen, or null when it couldn't look (deploy/own/plan.ts decides).
// Under ERGA_DEPLOY_MOCK=1, the account and the servers are a mock Cloudflare's (dev/mock-cloudflare.ts): nothing real.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { entryOf, readConfig } from "../cli/config";
import { mocked, netOf } from "../cli/deploy";
import { Cloudflare, type Fetch, findDatabase } from "../pipeline/pipeline";
import { d1 } from "../pipeline/account";
import { machineCredential } from "../local-credential";
import { type Answers, type Facts, hostOf, SETUP_COMMIT, namesOf, type TargetFacts, type TargetName, targetsOf } from "./plan";
import { DIR, loadSecrets, type Own, ROOT, secretNames } from "./store";

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return r.exitCode == 0 ? r.stdout.toString().trim() : null;
};

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

/** Whether node_modules is what the lockfile says: bun's own check, with nothing written. */
function installed(): boolean {
  if (!existsSync(join(ROOT, "node_modules/effect"))) return false;
  const r = Bun.spawnSync(["bun", "install", "--frozen-lockfile", "--dry-run"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
  return r.exitCode == 0;
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
async function getJson<T>(net: Fetch, url: string): Promise<T | null> {
  const r = await net(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => null)) as T | null) : null;
}

/** Where /auth/github sends a person: GitHub, with this client id and this host's callback, or what's wrong. */
export async function signInCheck(net: Fetch, host: string, clientId: string | undefined): Promise<TargetFacts["signIn"]> {
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

/** One server: its Worker, its address, what it answers, its entry, and (with the database) the company's access rule. */
async function targetFacts(
  { cf, net }: Connection,
  account: string,
  zones: { id: string; name: string }[],
  a: Answers,
  t: TargetName,
  own: Own
): Promise<TargetFacts> {
  const host = hostOf(a, t),
    n = namesOf(host),
    acc = `/accounts/${account}`;
  const scripts =
    (await cf
      .call<{ id: string; tags?: string[]; named_handlers?: { name?: string }[] }[]>("GET", `${acc}/workers/scripts`, "list your Workers")
      .catch(() => [])) ?? [];
  const found = scripts.find((s) => s.id == n.worker);
  const worker = !found
    ? "missing"
    : found.tags?.includes("erga") || found.named_handlers?.some((h) => h.name == "DocumentObject")
      ? "ours"
      : "other";
  const domains =
    (await cf
      .call<{ hostname: string; service: string }[]>(
        "GET",
        `${acc}/workers/domains?hostname=${encodeURIComponent(host)}`,
        "read custom domains"
      )
      .catch(() => [])) ?? [];
  const domain = domains.find((d) => d.hostname == host);
  let address: TargetFacts["address"] = "free";
  if (domain) address = domain.service == n.worker ? "ours" : { taken: `it's the address of the Worker ${domain.service}` };
  else {
    const zone = zones.filter((z) => host == z.name || host.endsWith(`.${z.name}`)).sort((x, y) => y.name.length - x.name.length)[0];
    const records = zone
      ? ((await cf
          .call<{ type: string; content: string }[]>(
            "GET",
            `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`,
            "read DNS records"
          )
          .catch(() => [])) ?? [])
      : [];
    if (records.length) address = { taken: `DNS already has ${records.map((r) => `${r.type} ${r.content}`).join(", ")} for it` };
  }
  const v = worker == "ours" ? await getJson<{ version?: string }>(net, `https://${host}/api/deploys/version`) : null;
  const h = v
    ? await getJson<{ ok?: boolean; checks?: Record<string, { ok: boolean; error?: string }> }>(net, `https://${host}/api/health`)
    : null;
  const health: TargetFacts["health"] = !v ? null : h?.ok ? "ok" : { bad: h ? JSON.stringify(h.checks ?? h).slice(0, 200) : "no answer" };
  const signIn = v ? await signInCheck(net, host, own.github?.clientId) : null;
  let rule: boolean | null = null;
  if (worker == "ours") {
    const db = await findDatabase(cf, acc, n.database).catch(() => null);
    if (db) {
      if (a.preset == "company" && a.company) {
        const r = await d1(
          cf,
          acc,
          db,
          "SELECT id FROM access_rules WHERE value = ?1 AND access IN ('read','write')",
          [a.company],
          "look for the access rule"
        ).catch(() => null);
        rule = r ? r.length > 0 : null;
      }
    }
  }
  return {
    worker,
    address,
    version: v?.version ?? null,
    health,
    signIn,
    registered: !!entryOf(readConfig(DIR), host)?.token,
    rule,
    held: worker == "ours" ? await heldBy(cf, acc, n.worker) : null,
  };
}

/** The Worker's bindings now: the names of its secrets (never their values), and its plain values. */
async function heldBy(cf: Cloudflare, acc: string, worker: string): Promise<TargetFacts["held"]> {
  const r = await cf
    .call<{ bindings?: { type: string; name: string; text?: string }[] }>(
      "GET",
      `${acc}/workers/scripts/${worker}/settings`,
      "read the Worker's settings"
    )
    .catch(() => null);
  if (!r?.bindings) return null;
  return {
    secrets: r.bindings.filter((b) => b.type == "secret_text").map((b) => b.name),
    vars: Object.fromEntries(r.bindings.filter((b) => b.type == "plain_text").map((b) => [b.name, b.text ?? ""])),
  };
}

/** Everything `bun erga setup <host> status` decides from. */
export async function observe(own: Own, a: Answers | null): Promise<Facts & { zoneIds: { id: string; name: string }[] }> {
  const head = git("rev-parse", "--verify", "--quiet", `${SETUP_COMMIT}^{commit}`);
  const facts: Facts & { zoneIds: { id: string; name: string }[] } = {
    bun: Bun.version,
    origin: git("remote", "get-url", "origin"),
    installed: installed(),
    head,
    login: { ok: false, why: "" },
    account: null,
    zones: [],
    zoneIds: [],
    workersSubdomain: null,
    targets: {},
    secrets: secretNames(loadSecrets()),
  };
  const c = await cloudflare();
  if ("why" in c) {
    facts.login = { ok: false, why: c.why };
    return facts;
  }
  const accounts =
    (await c.cf.call<{ id: string; name: string }[]>("GET", "/accounts", "list your accounts").catch((e: Error) => {
      facts.login = { ok: false, why: e.message };
      return null;
    })) ?? null;
  if (!accounts) return facts;
  facts.login = { ok: true, accounts: accounts.map((x) => ({ id: x.id, name: x.name })) };
  facts.account = own.account ?? (accounts.length == 1 ? accounts[0].id : null);
  if (!facts.account) return facts;
  const acc = `/accounts/${facts.account}`;
  facts.zoneIds = (
    (await c.cf
      .call<{ id: string; name: string }[]>("GET", `/zones?account.id=${facts.account}&per_page=50`, "list your domains")
      .catch(() => [])) ?? []
  ).map((z) => ({ id: z.id, name: z.name }));
  facts.zones = facts.zoneIds.map((z) => z.name);
  facts.workersSubdomain =
    (
      await c.cf
        .call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read your workers.dev subdomain", undefined, { allow404: true })
        .catch(() => null)
    )?.subdomain ?? null;
  if (a?.host) for (const t of targetsOf(a)) facts.targets[t] = await targetFacts(c, facts.account, facts.zoneIds, a, t, own);
  return facts;
}
