// The verify suite runs only on infrastructure of its own (safe.ts): two Cloudflare test zones in an account that
// this machine's settings name (config.ts), and an AWS account. A dedicated account holds nothing but what the suite
// makes (`whole`); a shared one holds other work, which the suite never touches (`shared`). This file does the IO
// that safe.ts decides on:
//
//   the reach    Cloudflare's API as the suite calls it (`cloudflare`): each call is asked of the suite's rule before
//                it is sent (`guarded`: safe.ts, apiProblem), a read too, and gets the token at its own time
//                (`tokenNow`)
//   the look     what the accounts hold (`cloudflareHeld`, `awsHeld`). It only reads. (Each `aws` command is asked
//                of the suite's rule too: aws-guard.ts)
//   the stop     `assertDedicated` stops a deploy when the zones or the accounts are not the suite's own
//
//   bun erga verify      shows it as two prerequisites (prereqs.ts), which block each setting
//   the step `deploy`    asks again itself, just before it makes anything (`assertDedicated`): the step also runs
//                        alone (bun dev/verify.ts <n> deploy), with no prerequisites checked

import { ergaDir, readConfig } from "../../deploy/cli/config.ts";
import { API, Cloudflare, type Fetch } from "../../deploy/deployer/cloudflare-api.ts";
import { sh } from "../../deploy/root.ts";
import { guardAws, guarded as awsInFront } from "./aws-guard.ts";
import { dedicatedEnv, hostsOf, type Local, readLocal, tokenOf } from "./config.ts";
import { apiProblem, awsStrangers, cloudflareStrangers, type Held, type Scope } from "./safe.ts";

/** The region of the runs' stacks. */
export const REGION = "us-east-1";

/** This machine's settings, read now. */
const settings = (): Local => {
  const dir = ergaDir();
  return readLocal(dir, hostsOf(readConfig(dir)));
};

/** A token with less time left than this is not used: a call may take that long. */
const SPARE = 120_000;
let kept: { token: string; expires?: number } | null = null;
/**
 * The suite's Cloudflare token, at the time of a call (config.ts, tokenOf); it throws when there is none.
 * The cf CLI's login lasts an hour, and the CLI renews it only after its end: a login in its last two minutes is
 * waited out, and then read again.
 */
export function tokenNow(): string {
  const left = () => (kept?.expires || Number.POSITIVE_INFINITY) - Date.now();
  for (let reads = 0; !kept || left() < SPARE; reads++) {
    if (reads > 2) throw new Error("The cf CLI did not renew its login: bunx cf auth login");
    // (A read gave a login near its end: the CLI renews it after its end.)
    if (reads) Bun.sleepSync(Math.max(0, left()) + 1000);
    const t = tokenOf(ergaDir(), settings());
    if ("why" in t) throw new Error(t.why);
    kept = t;
  }
  return kept.token;
}

/** In the place of a token in a call's header: `guarded` puts the token there when it sends the call. */
export const LATER = "the-token-at-the-call";

/**
 * fetch for Cloudflare's API, as the suite may use it: each call is asked of the suite's rule first (safe.ts,
 * apiProblem), and a call that the rule refuses throws: nothing is sent. A call names a D1 database, an Access
 * application, an identity provider, a DNS record or a Custom Domain by its ID: its name is asked of the account first. `token`: the token at the time of a call.
 */
export function guarded(scope: Scope, token: () => string, inner: Fetch = fetch): Fetch {
  const json = (text: unknown): unknown => {
    try {
      return JSON.parse(String(text));
    } catch {
      return {};
    }
  };
  /** A thing's name by its ID, as the account says it: kept only when the account answered ("": it has none). */
  const named = async (names: Record<string, string>, path: string, id: string) => {
    if (id in names || !/^[0-9a-f-]{32,36}$/.test(id)) return;
    const r = await inner(`${API}/accounts/${scope.account}/${path}/${id}`, { headers: { authorization: `Bearer ${token()}` } });
    const name = ((await r.json().catch(() => null)) as { result?: { name?: string } } | null)?.result?.name;
    if (r.status == 200 && name) names[id] = name;
    else if (r.status == 404) names[id] = "";
  };
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.href.startsWith(`${API}/`)) throw new Error(`The verify suite's Cloudflare calls go to ${API} only, not to ${url.host}.`);
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname.slice(new URL(API).pathname.length);
    const body =
      init.body instanceof FormData ? { metadata: json(init.body.get("metadata")) } : typeof init.body == "string" ? json(init.body) : {};
    const bound = ((body as { metadata?: { bindings?: { type?: string; id?: string; database_id?: string }[] } }).metadata?.bindings ?? [])
      .filter((b) => b?.type == "d1")
      .flatMap((b) => [b.id, b.database_id]);
    for (const id of [/\/d1\/database\/([^/]+)/.exec(path)?.[1], ...bound])
      if (typeof id == "string") await named(scope.databases, "d1/database", id);
    const access = /\/access\/(apps|identity_providers)\/([^/]+)/.exec(path);
    if (access && scope.team) await named(scope.access, `access/${access[1]}`, access[2]);
    const record = /^\/zones\/([\w-]+)\/dns_records\/([\w-]+)$/.exec(path);
    if (record && !(record[2] in scope.records)) {
      const r = await inner(`${API}${path}`, { headers: { authorization: `Bearer ${token()}` } });
      const name = ((await r.json().catch(() => null)) as { result?: { name?: string } } | null)?.result?.name;
      if (r.status == 200 && name) scope.records[record[2]] = name;
    }
    const domain = /\/workers\/domains\/([\w-]+)$/.exec(path)?.[1];
    if (domain && !(domain in scope.domains)) {
      const r = await inner(`${API}/accounts/${scope.account}/workers/domains/${domain}`, {
        headers: { authorization: `Bearer ${token()}` },
      });
      const d = ((await r.json().catch(() => null)) as { result?: { hostname?: string; service?: string } } | null)?.result;
      if (r.status == 200 && d?.hostname && d.service) scope.domains[domain] = { hostname: d.hostname, service: d.service };
    }
    const no = apiProblem(method, path, body, scope);
    if (no) throw new Error(no);
    const headers = new Headers(init.headers);
    if (headers.get("authorization") == `Bearer ${LATER}`) headers.set("authorization", `Bearer ${token()}`);
    return inner(url, { ...init, headers });
  };
}

/** Cloudflare's API as the suite reads it: the answer's status and its result. It never throws: 0 is no answer, or a call that the rule refused. */
export type Api = (method: string, path: string, body?: unknown) => Promise<{ status: number; result: unknown }>;
export const apiOf =
  (send: Fetch): Api =>
  async (method, path, body) => {
    try {
      const r = await send(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${LATER}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const j = (await r.json().catch(() => null)) as { result?: unknown } | null;
      return { status: r.status, result: j?.result ?? null };
    } catch {
      return { status: 0, result: null };
    }
  };

/** What the suite's calls may name: the settings' account and its two test zones, whose IDs the account says. */
export async function scopeOf(l: Local, send: (scope: Scope) => Fetch): Promise<Scope> {
  const c = l.cloudflare;
  const scope: Scope = {
    account: c.account,
    team: c.team,
    shell: c.shell,
    content: c.content,
    zones: {},
    databases: {},
    access: {},
    records: {},
    domains: {},
  };
  const api = apiOf(send(scope));
  for (const name of [c.shell, c.content]) {
    const found = ((await api("GET", `/zones?name=${name}`)).result ?? []) as { id: string; name: string; account: { id: string } }[];
    const z = found.find((x) => x.name == name && x.account.id == c.account);
    if (z) scope.zones[z.id] = name;
  }
  return scope;
}

let reach: Promise<{ local: Local; scope: Scope; api: Api; cf: Cloudflare }> | null = null;
/**
 * Cloudflare's API for this process, with the suite's rule before each call: `api` for the suite's own reads, and
 * `cf` for the deploy's code (deploy/pipeline/). It throws when the settings can't be used, or there is no token.
 */
export const cloudflare = () =>
  (reach ??= (async () => {
    const local = settings();
    if (local.problem) throw new Error(local.problem);
    tokenNow();
    const scope = await scopeOf(local, (s) => guarded(s, tokenNow));
    const send = guarded(scope, tokenNow);
    return { local, scope, api: apiOf(send), cf: new Cloudflare(LATER, send) };
  })());

/** What the Cloudflare account holds, as the token sees it. A shared account: its two test zones only. */
export async function cloudflareHeld(l: Local, api: Api | null): Promise<Held["cloudflare"]> {
  const none: Held["cloudflare"] = {
    accounts: null,
    zones: {},
    otherZones: null,
    workers: null,
    databases: null,
    buckets: null,
    team: null,
    apps: null,
    providers: null,
  };
  if (!api) return none;
  /** One page of a list, `most` long at most. Null: not read, or a full page (there may be more: not all was read). */
  const list = async <T>(path: string, most: number, at = (r: unknown) => r): Promise<T[] | null> => {
    const r = await api("GET", path);
    const rows = r.status == 200 ? at(r.result) : null;
    return Array.isArray(rows) && rows.length < most ? (rows as T[]) : null;
  };
  const acc = `/accounts/${l.cloudflare.account}`;
  const zone = async (name: string): Promise<Held["cloudflare"]["zones"][string]> => {
    const z = (await list<{ id: string; name: string; account: { id: string } }>(`/zones?name=${name}`, 50))?.find((x) => x.name == name);
    if (!z) return null;
    const [records, routes, domains] = await Promise.all([
      list<{ type: string; name: string }>(`/zones/${z.id}/dns_records?per_page=1000`, 1000),
      list<{ pattern: string }>(`/zones/${z.id}/workers/routes`, 1000),
      list<{ hostname: string; service: string }>(`${acc}/workers/domains?zone_name=${name}`, 1000),
    ]);
    // (A list that was not read counts as one stranger: the zone is not known to be the suite's own.)
    return {
      account: z.account.id,
      records: records?.map((r) => ({ type: r.type, name: r.name })) ?? [{ type: "?", name: "(the records were not read)" }],
      routes: routes?.map((r) => r.pattern) ?? ["(the routes were not read)"],
      // (Asked for this zone; the answer's own names are checked too: the filter is Cloudflare's.)
      domains: domains
        ?.filter((d) => d.hostname == name || d.hostname.endsWith(`.${name}`))
        .map((d) => ({ hostname: d.hostname, service: d.service })) ?? [{ hostname: "(the Custom Domains were not read)", service: "?" }],
    };
  };
  const names = [l.cloudflare.shell, l.cloudflare.content].filter(Boolean);
  const [accounts, zones] = await Promise.all([
    list<{ id: string }>("/accounts?per_page=50", 50),
    Promise.all(names.map(async (n) => [n, await zone(n)] as const)),
  ]);
  const own = { ...none, accounts: accounts?.map((a) => a.id) ?? null, zones: Object.fromEntries(zones) };
  const org = l.cloudflare.team || !l.cloudflare.shared ? await api("GET", `${acc}/access/organizations`) : { status: 0, result: null };
  const domain = (org.result as { auth_domain?: string } | null)?.auth_domain;
  // (A 404: the account has no team.)
  const team = org.status == 200 && domain ? domain.replace(/\.cloudflareaccess\.com$/, "") : org.status == 404 ? "" : null;
  // A shared account: the rest of it is not the suite's, and is not read.
  if (l.cloudflare.shared) return { ...own, team };
  const [all, workers, databases, buckets, apps, providers] = await Promise.all([
    list<{ name: string }>(`/zones?account.id=${l.cloudflare.account}&per_page=50`, 50),
    list<{ id: string }>(`${acc}/workers/scripts`, 10_000),
    list<{ name: string }>(`${acc}/d1/database?per_page=100`, 100),
    list<{ name: string }>(`${acc}/r2/buckets?per_page=1000`, 1000, (r) => (r as { buckets?: unknown } | null)?.buckets),
    list<{ name: string }>(`${acc}/access/apps?per_page=200`, 200),
    list<{ name: string }>(`${acc}/access/identity_providers?per_page=200`, 200),
  ]);
  const named = (rows: { name: string }[] | null) => rows?.map((r) => r.name) ?? null;
  return {
    ...own,
    otherZones: named(all)?.filter((z) => !names.includes(z)) ?? null,
    workers: workers?.map((w) => w.id) ?? null,
    databases: named(databases),
    buckets: named(buckets),
    team,
    apps: named(apps),
    providers: named(providers),
  };
}

/** Before an `aws` command of the suite's own: it throws unless the suite's `aws` is in front (aws-guard.ts). */
export function awsGuarded(): void {
  if (!awsInFront()) throw new Error("The verify suite's aws is not in front of the AWS CLI in this process: no AWS command runs.");
}

/** The states of a stack that is there (not: deleted). */
const THERE = [
  "CREATE_IN_PROGRESS",
  "CREATE_FAILED",
  "CREATE_COMPLETE",
  "ROLLBACK_IN_PROGRESS",
  "ROLLBACK_FAILED",
  "ROLLBACK_COMPLETE",
  "DELETE_IN_PROGRESS",
  "DELETE_FAILED",
  "UPDATE_IN_PROGRESS",
  "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
  "UPDATE_COMPLETE",
  "UPDATE_FAILED",
  "UPDATE_ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_FAILED",
  "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
  "UPDATE_ROLLBACK_COMPLETE",
  "REVIEW_IN_PROGRESS",
];
/** The names of the account's stacks in the runs' region, or why they were not listed. Names only: no stack is read. */
export function stackNames(l: Local): { names: string[] } | { why: string } {
  awsGuarded();
  const r = sh([
    "aws",
    "cloudformation",
    "list-stacks",
    "--stack-status-filter",
    ...THERE,
    "--query",
    "StackSummaries[].StackName",
    "--region",
    REGION,
    "--profile",
    l.aws.profile,
    "--output",
    "json",
  ]);
  return r.ok ? { names: JSON.parse(r.out) as string[] } : { why: r.err.split("\n").at(-1) ?? "the AWS CLI failed" };
}

/** What the AWS account holds, as the profile sees it: its ID, and its stacks' names. */
export function awsHeld(l: Local): Held["aws"] {
  if (!l.aws.profile) return { account: null, stacks: null };
  awsGuarded();
  const me = sh(["aws", "sts", "get-caller-identity", "--profile", l.aws.profile, "--output", "json"]);
  if (!me.ok) return { account: null, stacks: null };
  const stacks = stackNames(l);
  return { account: (JSON.parse(me.out) as { Account: string }).Account, stacks: "names" in stacks ? stacks.names : null };
}

/**
 * Stops unless this machine's settings name infrastructure that the suite may use, and the accounts are that: before
 * a deploy makes anything. `aws`: the run deploys to AWS too.
 */
export async function assertDedicated(o: { cloudflare: boolean; aws: boolean }): Promise<void> {
  const local = settings();
  if (local.problem) throw new Error(local.problem);
  const problems: string[] = [];
  if (o.cloudflare) {
    const mine = await cloudflare().catch((e: Error) => e.message);
    problems.push(...(typeof mine == "string" ? [mine] : cloudflareStrangers(local, await cloudflareHeld(local, mine.api))));
  }
  if (o.aws)
    problems.push(
      ...(!local.aws.profile || !local.aws.account || !local.aws.shell || !local.aws.content
        ? ["The suite's AWS account, its profile and its two Route 53 zones are not set (.erga/verify.json)."]
        : awsStrangers(local, awsHeld(local)))
    );
  if (problems.length)
    throw new Error(
      `The verify suite runs only on zones and accounts that are its own to use (.erga/verify.json). Nothing was made.\n${problems.map((p) => `  ${p}`).join("\n")}`
    );
}

/**
 * A step's process takes the suite's accounts for its own environment (config.ts, dedicatedEnv), and so do the
 * commands it starts: wrangler gets the suite's Cloudflare account, the AWS CLI the suite's profile. No Cloudflare
 * token is in the environment: the suite's own is taken at each call (tokenNow), and nothing of this machine's other
 * sign-ins takes its place. `bun erga verify` gives a step the same values; a step that runs alone reads them here.
 */
export async function useDedicated(): Promise<void> {
  const local = settings();
  if (local.problem) throw new Error(local.problem);
  // (AWS keys of the environment win over a profile: only the suite's profile counts.)
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ])
    delete process.env[name];
  Object.assign(process.env, dedicatedEnv(local));
  // Each `aws` command of this process, and of setup's code in it, is asked of the suite's rule first (aws-guard.ts).
  if (local.aws.profile) await guardAws(local.aws.profile, [local.aws.shell, local.aws.content]);
}
