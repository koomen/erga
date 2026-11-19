// The verify suite's prerequisites (`bun erga verify`): what a person sets up one time on this machine and in the
// accounts, before a run can deploy. Each one has a check in code, which says done or not done, and what to do: a
// command, a link, or a file to write.
//
//   probe    asks the machine and the accounts (IO): the token, the logins, the zones, what the accounts hold
//            (dedicated.ts), the browsers. It only reads, with two exceptions that make nothing: where the zones and
//            the account are the suite's to use, the token is asked to make an Access application with no values
//            (Cloudflare refuses the empty request after it checked the permission); and a Safari that takes
//            automation opens one empty window for a moment
//   decide   pure: the facts in, each prerequisite's state out (tests/verify-suite.test.ts)
//
// Trap: a new zone of the Free plan adds the Web Analytics script to each page from its first minutes, while the API
// says that its Web Analytics is off and lists no site for it (seen 2026-11-19): the check `analytics` passes, and
// invariant 4 fails in Chromium and Firefox. Setting the zone's `rum` setting to "off" one time ended it in a minute:
// PATCH /zones/<zone>/settings/rum {"value": "off"}.

import { existsSync } from "node:fs";
import { chromium, firefox, webkit } from "playwright-core";
import { ROOT, sh } from "../../deploy/root.ts";
import { dedicatedEnv, type Local, tokenPath } from "./config.ts";
import { type Api, awsGuarded, awsHeld, cloudflare, cloudflareHeld, REGION, tokenNow } from "./dedicated.ts";
import { awsStrangers, cloudflareStrangers, type Held } from "./safe.ts";

export type Id =
  | "config"
  | "token"
  | "wrangler"
  | "cloudflare"
  | "zones"
  | "workers-dev"
  | "analytics"
  | "access"
  | "aws"
  | "aws-own"
  | "aws-zones"
  | "browsers"
  | "safari-version"
  | "safari-automation"
  | "safari-preview";

export interface Prereq {
  id: Id;
  title: string;
  done: boolean;
  /** What the check saw. */
  detail: string;
  /** What to do, when it is not done: a command, a link, or a file to write. */
  todo: string;
}

/** A zone of the account, as Cloudflare's API says it; null: the token sees none of that name. */
export interface Zone {
  id: string;
  account: string;
  active: boolean;
  /** Universal SSL is on: a Custom Domain's certificate needs it. null: not read. */
  ssl: boolean | null;
  /** Web Analytics adds its script to the zone's pages (automatic setup). null: not read. */
  analytics: boolean | null;
}

export interface Facts {
  local: Local;
  /** Why there is no Cloudflare API token for the suite ("": there is one). */
  token: string;
  /** What `wrangler whoami` printed with that token; "": it did not run. */
  wrangler: string;
  /** By the zone's name: the two Cloudflare test zones. */
  zones: Record<string, Zone | null>;
  /** The account's workers.dev subdomain. */
  subdomain: string | null;
  /** Whether the token may edit Access applications; null: not known. */
  access: boolean | null;
  /** What the accounts hold (dedicated.ts): the suite runs only where all of it is its own. */
  held: Held;
  /** Why the AWS CLI did not say the profile's account ("": it did), and the profile's region. */
  aws: { why: string; region: string };
  /** By the zone's name: the two Route 53 test zones. null: the account has no such public zone. `delegated`: the internet's name servers for it are Route 53's (null: not read). */
  awsZones: Record<string, { delegated: boolean | null } | null>;
  /** Playwright's browsers that are installed. */
  browsers: Record<"chromium" | "firefox" | "webkit", boolean>;
  /** Safari: its version, why it takes no automation ("": it does), and whether Technology Preview is installed. */
  safari: { version: string; automation: string; preview: boolean };
  /** The system's version (macOS). */
  system: string;
}

/**
 * Safari's first version that keeps a partitioned cookie in a frame on another site, which the gate's hand-off needs:
 * and the system's (macOS, iOS) first version too. Safari 26 on macOS 15 keeps none: the system's network code decides.
 */
export const SAFARI = [26, 2];
const atLeast = (version: string, [major, minor]: number[]) => {
  const [a = 0, b = 0] = version.split(".").map(Number);
  return a > major || (a == major && b >= minor);
};
/** Whether a Safari of this version, on a system of this version, keeps a cookie that a frame on another site sets. */
export const framesKeepCookies = (safari: string, system: string) => atLeast(safari, SAFARI) && atLeast(system, SAFARI);

/** The settings file, as a person writes it. */
const EXAMPLE =
  '{"cloudflare": {"account": "<account ID>", "shell": "<zone>", "content": "<zone on another site>", "team": "<Zero Trust team>"}, "aws": {"profile": "<AWS CLI profile>", "account": "<account ID>", "shell": "<Route 53 zone>", "content": "<Route 53 zone on another site>"}, "refuse": []}';

/** Each prerequisite's state, from the facts. */
export function decide(f: Facts): Prereq[] {
  const l = f.local;
  const c = l.cloudflare;
  const a = l.aws;
  const names = [c.shell, c.content].filter(Boolean);
  const zones = names.map((n) => ({ name: n, z: f.zones[n] ?? null }));
  /** A page of Cloudflare's dashboard: it puts the person's own account (and zone) in the address. */
  const dash = (path: string) => `https://dash.cloudflare.com/?to=/:account/${path}`;
  const signedIn = /You are logged in/.test(f.wrangler);
  const zoneWrong = zones.flatMap(({ name, z }) =>
    !z
      ? [`the token sees no zone ${name}`]
      : [...(z.active ? [] : [`${name} is not active`]), ...(z.ssl === false ? [`Universal SSL is off on ${name}`] : [])]
  );
  const counted = zones.filter((z) => z.z?.analytics === true).map((z) => z.name);
  const analyticsRead = zones.length > 0 && zones.every((z) => z.z && z.z.analytics != null);
  const missing = (["chromium", "firefox", "webkit"] as const).filter((b) => !f.browsers[b]);
  const foreign = f.token || !c.account ? [] : cloudflareStrangers(l, f.held.cloudflare);
  const awsSet = !!a.profile && !!a.account;
  const awsForeign = awsSet && !f.aws.why ? awsStrangers(l, f.held.aws) : [];
  const awsZones = [a.shell, a.content].filter(Boolean).map((n) => ({ name: n, z: f.awsZones[n] ?? null }));
  const awsZoneWrong = awsZones.flatMap(({ name, z }) =>
    !z
      ? [`the account has no public Route 53 zone ${name}`]
      : z.delegated === false
        ? [`the internet's name servers for ${name} are not that zone's: its NS records are not at its parent zone or registrar yet`]
        : []
  );
  const row = (id: Id, title: string, done: boolean, detail: string, todo: string): Prereq => ({
    id,
    title,
    done,
    detail,
    todo: done ? "" : todo,
  });
  return [
    row(
      "config",
      "The suite's accounts and its own test zones are named",
      !l.problem,
      l.problem ??
        `Cloudflare ...${c.account.slice(-6)}${c.shared ? " (shared: it holds other work, which the suite never touches)" : ""}: shells under ${c.shell}, other-site content under ${c.content}${c.team ? `, the team ${c.team}` : ""}.${awsSet ? ` AWS ...${a.account.slice(-4)} (profile ${a.profile}): apps under ${a.shell}, pages on ${a.content}.` : " No AWS account is named."}`,
      `Write .erga/verify.json in the main clone, with a Cloudflare account and an AWS account that the suite alone uses (or, with "shared": true, an account that holds other work, and two zones that hold none): ${EXAMPLE}`
    ),
    row(
      "token",
      c.login == "cf" ? "The cf CLI's login, as the suite's Cloudflare API token" : "An API token of the suite's Cloudflare account",
      !f.token,
      f.token ||
        (c.login == "cf"
          ? "The cf CLI is signed in on this machine. Its login reaches more than a run needs: the suite's rule is asked before each call."
          : "The token is in .erga/verify-cloudflare.token, a file of this user's only."),
      c.login == "cf"
        ? "bunx cf auth login"
        : `In the account, make an API token for that account only (https://dash.cloudflare.com/profile/api-tokens), with: Account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Access: Apps and Policies Edit, Access: Organizations, Identity Providers, and Groups Edit, Account Settings Read; Zone (the two test zones): Zone Read, DNS Edit, Workers Routes Edit, SSL and Certificates Edit. Save it as one line in ${tokenPath("<the main clone>/.erga")}, then: chmod 600 that file.`
    ),
    row(
      "wrangler",
      "wrangler takes the suite's token",
      signedIn,
      f.token ? "Not asked: there is no token." : signedIn ? "wrangler is signed in with the token." : "wrangler does not take the token.",
      c.login == "cf"
        ? "bunx cf auth login"
        : "Make the token again, with Workers Scripts Edit and Account Settings Read (see the row above)."
    ),
    row(
      "cloudflare",
      c.shared
        ? "The two test zones hold only what the suite makes (a shared account)"
        : "The Cloudflare account, its zones and its team hold only what the suite makes",
      !f.token && !!c.account && !l.problem && !foreign.length,
      f.token || l.problem
        ? "Not read: the settings or the token are missing."
        : foreign.length
          ? foreign.join(" ")
          : c.shared
            ? `The token reaches only ...${c.account.slice(-6)}. The DNS records, routes and Custom Domains of ${names.join(" and ")} are all the suite's. The account holds other work: the suite makes, changes and deletes only what is named erga-verify-..., under those two zones.`
            : `The token reaches only ...${c.account.slice(-6)}. Its Workers, the DNS records and routes of ${names.join(" and ")}${c.team ? `, and the team ${c.team}'s Access applications` : ""} are all the suite's.`,
      c.shared
        ? "Move anything that the suite did not make out of the two test zones (.erga/verify.json): a test zone holds only the runs' hosts."
        : "Name a Cloudflare account that the suite alone uses (.erga/verify.json), with a token for that account only. Move anything else out of it: the suite never runs beside other work."
    ),
    row(
      "zones",
      "The test zones are active, with Universal SSL",
      zones.length > 0 && !zoneWrong.length,
      zones.length
        ? zoneWrong.length
          ? `${zoneWrong.join("; ")}.`
          : `${names.join(" and ")}: active, and each host gets a certificate.`
        : "No test zone is named.",
      zones.length
        ? `Add each zone to the dedicated account, set its name servers at its registrar, and turn on Universal SSL: ${dash(":zone/ssl-tls/edge-certificates")}`
        : "Name the test zones first."
    ),
    row(
      "workers-dev",
      "A workers.dev subdomain, for the test issuer",
      !!f.subdomain,
      f.subdomain
        ? `The test issuer answers on ${f.subdomain}.workers.dev.`
        : "The account has no workers.dev subdomain, or the token can't read it.",
      dash("workers-and-pages")
    ),
    row(
      "analytics",
      "Cloudflare Web Analytics adds no script on the test zones",
      analyticsRead && !counted.length,
      !analyticsRead
        ? "Not read: the token sees no zone, or can't read Web Analytics."
        : counted.length
          ? `Automatic setup is on for ${counted.join(" and ")}: it adds a script to each page, and invariant 4 fails.`
          : "No automatic setup on the test zones.",
      `For ${counted.join(" and ") || "each test zone"}: Manage site, then turn off automatic setup, at ${dash("web-analytics/sites")}`
    ),
    row(
      "access",
      "The account has a Zero Trust team that the suite may use, and the token edits its Access (setting 4)",
      !!c.team && f.access === true && f.held.cloudflare.team == c.team,
      !c.team
        ? c.shared
          ? "No team is named. The account is shared: its Zero Trust team holds other work."
          : "No team is named."
        : f.held.cloudflare.team != c.team
          ? `The account's team is ${f.held.cloudflare.team || "not set up, or not read"}, not ${c.team}.`
          : f.access === true
            ? `The team ${c.team}${c.shared ? " (shared: the suite makes and deletes only its own applications and identity provider there)" : ""}: the token may make Access applications and policies.`
            : f.access === false
              ? "The token may not edit Access."
              : "Not asked: there is no token, or the zones and the account are not the suite's to use yet.",
      c.shared && !c.team
        ? "Setting 4 needs a dedicated account, with a Zero Trust team of its own (an account has one team only). Or, when the owner of this account's team allows it: put the team's name in .erga/verify.json as \"team\". The suite then makes and deletes only applications and an identity provider named erga-verify-... in that team, and changes nothing else of it."
        : `In the account, set up Zero Trust (${dash("access")}): choose the team's name, and put it in .erga/verify.json as "team". The token needs Access: Apps and Policies Edit, and Access: Organizations, Identity Providers, and Groups Edit.`
    ),
    row(
      "aws",
      "The AWS CLI reaches the suite's AWS account",
      awsSet && !f.aws.why && f.held.aws.account == a.account,
      !awsSet
        ? "No AWS account and profile are named."
        : f.aws.why ||
            (f.held.aws.account == a.account
              ? `Profile ${a.profile}: account ...${a.account.slice(-4)}${a.shared ? " (shared: it holds other work, which the suite never touches)" : ""}. Its region is ${f.aws.region || "not set"}; the runs' stacks go to ${REGION}.`
              : `Profile ${a.profile} reaches the account ...${(f.held.aws.account ?? "?").slice(-4)}, not ...${a.account.slice(-4)}.`),
      awsSet
        ? `aws sso login --profile ${a.profile} (or: aws login --profile ${a.profile})`
        : 'Make an AWS account that the suite alone uses, and a profile of the AWS CLI for it with administrator access (aws configure sso). Put "profile" and "account" (its 12 digits) under "aws" in .erga/verify.json. (An account that holds other work: only when its owner allows it, with "shared": true. The suite then touches only stacks named erga-verify-....)'
    ),
    row(
      "aws-own",
      a.shared ? "The AWS account is the settings' (a shared account)" : "The AWS account holds only the suite's stacks",
      awsSet && !f.aws.why && !awsForeign.length,
      !awsSet || f.aws.why
        ? "Not read: the AWS CLI does not reach the account."
        : awsForeign.join(" ") ||
            (a.shared
              ? "The account holds other work: the suite makes, changes and deletes only stacks named erga-verify-..., and what those stacks hold. Only this machine reaches a run's deploy."
              : `Each stack in ${REGION} is the suite's.`),
      a.shared
        ? `aws sso login --profile ${a.profile}`
        : "Name an AWS account that the suite alone uses (.erga/verify.json). The suite never runs in an account with other stacks."
    ),
    row(
      "aws-zones",
      "Two Route 53 zones for the runs on AWS, which the internet finds",
      awsZones.length == 2 && !f.aws.why && !awsZoneWrong.length,
      awsZones.length < 2
        ? "No Route 53 zones are named."
        : f.aws.why
          ? "Not read: the AWS CLI does not reach the account."
          : awsZoneWrong.length
            ? `${awsZoneWrong.join("; ")}.`
            : `${a.shell} and ${a.content}: public zones of the account. The certificates' checks and the apps' names go there.`,
      'In the AWS account, make two public hosted zones in Route 53, on two different sites (two domains, or a name under each Cloudflare test zone). For each, put its four NS records at its registrar or in its parent zone. Put their names under "aws" in .erga/verify.json as "shell" and "content".'
    ),
    row(
      "browsers",
      "Playwright's Chromium, Firefox and WebKit",
      !missing.length,
      missing.length ? `Not installed: ${missing.join(", ")}.` : "All three are installed.",
      `bunx playwright-core install ${missing.join(" ")}`
    ),
    row(
      "safari-version",
      `Safari ${SAFARI.join(".")} or later, on macOS ${SAFARI.join(".")} or later`,
      framesKeepCookies(f.safari.version, f.system),
      f.safari.version
        ? `Safari ${f.safari.version} on macOS ${f.system || "?"}${framesKeepCookies(f.safari.version, f.system) ? "." : ": it keeps no cookie of a frame on another site. A run in it checks the gate's page for an unsupported browser, not an open document."}`
        : "Safari is not installed.",
      `System Settings > General > Software Update: macOS ${SAFARI.join(".")} or later, with its Safari. (Safari ${SAFARI.join(".")} alone, on an older macOS, is not enough.)`
    ),
    row(
      "safari-automation",
      "Safari takes automation (safaridriver)",
      !!f.safari.version && !f.safari.automation,
      f.safari.automation || "safaridriver makes a session.",
      "Safari > Settings > Developer > Allow remote automation. Then: sudo safaridriver --enable"
    ),
    row(
      "safari-preview",
      "Safari Technology Preview",
      f.safari.preview,
      f.safari.preview ? "Installed." : "Not installed. No run uses it yet.",
      "https://developer.apple.com/safari/technology-preview/"
    ),
  ];
}

// ---------------------------------------------------------------- the probe (IO)

/** Why safaridriver makes no session ("": it makes one, which ends at once). */
async function safariAutomation(): Promise<string> {
  if (!existsSync("/usr/bin/safaridriver")) return "This machine has no safaridriver.";
  const port = 4990 + Math.floor(Math.random() * 1000);
  const driver = Bun.spawn(["/usr/bin/safaridriver", "-p", String(port)], { stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 40; i++) {
      const up = await fetch(`http://127.0.0.1:${port}/status`).then(
        (r) => r.ok,
        () => false
      );
      if (up) break;
      await Bun.sleep(100);
    }
    const r = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: { browserName: "safari" } } }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json().catch(() => null)) as { value?: { sessionId?: string; message?: string } } | null;
    const id = j?.value?.sessionId;
    if (id) await fetch(`http://127.0.0.1:${port}/session/${id}`, { method: "DELETE" }).catch(() => null);
    return id ? "" : (j?.value?.message ?? `safaridriver answered ${r.status}.`).replace(/^Could not create a session: /, "");
  } catch (e) {
    return `safaridriver gave no answer: ${(e as Error).message}`;
  } finally {
    driver.kill();
  }
}

/** The internet's name servers for a name, asked over HTTPS (never this machine's resolver, which keeps a "no such host"); null: no answer. */
async function nameServers(name: string): Promise<string[] | null> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=NS`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
    return (j.Answer ?? []).filter((x) => x.type == 2).map((x) => x.data.replace(/\.$/, "").toLowerCase());
  } catch {
    return null;
  }
}

/** The account's public Route 53 zone of each name, and whether the internet's name servers for it are the zone's. */
async function route53(l: Local): Promise<Facts["awsZones"]> {
  const aws = (...args: string[]) => sh(["aws", ...args, "--profile", l.aws.profile, "--output", "json"]);
  const listed = aws("route53", "list-hosted-zones");
  const zones = listed.ok
    ? (JSON.parse(listed.out) as { HostedZones: { Id: string; Name: string; Config: { PrivateZone: boolean } }[] }).HostedZones
    : [];
  const one = async (name: string): Promise<Facts["awsZones"][string]> => {
    const z = zones.find((x) => !x.Config.PrivateZone && x.Name == `${name}.`);
    if (!z) return null;
    const got = aws("route53", "get-hosted-zone", "--id", z.Id);
    const own = got.ok
      ? (JSON.parse(got.out) as { DelegationSet?: { NameServers?: string[] } }).DelegationSet?.NameServers?.map((n) => n.toLowerCase())
      : undefined;
    const seen = await nameServers(name);
    return { delegated: own && seen ? seen.length > 0 && seen.every((n) => own.includes(n)) : null };
  };
  const names = [l.aws.shell, l.aws.content].filter(Boolean);
  return Object.fromEntries(await Promise.all(names.map(async (n) => [n, await one(n)] as const)));
}

/** The machine and the accounts, as they are now. `token`: why there is no Cloudflare token for the suite ("": there is one). */
export async function probe(local: Local, token: string): Promise<{ facts: Facts; api: Api | null }> {
  // (The suite's rule is asked before each call: dedicated.ts, `cloudflare`.)
  const api = !token && !local.problem ? ((await cloudflare().catch(() => null))?.api ?? null) : null;
  const acc = `/accounts/${local.cloudflare.account}`;
  const zone = async (name: string): Promise<Zone | null> => {
    const found = ((await api!("GET", `/zones?name=${name}`)).result ?? []) as {
      id: string;
      name: string;
      status: string;
      account: { id: string };
    }[];
    const z = found.find((x) => x.name == name);
    if (!z) return null;
    const ssl = (await api!("GET", `/zones/${z.id}/ssl/universal/settings`)).result as { enabled?: boolean } | null;
    return { id: z.id, account: z.account.id, active: z.status == "active", ssl: ssl?.enabled ?? null, analytics: null };
  };
  const names = [local.cloudflare.shell, local.cloudflare.content].filter(Boolean);
  const awsSet = !!local.aws.profile;
  // (Each `aws` command below is asked of the suite's rule first: no command runs without it.)
  if (awsSet) awsGuarded();
  const held = await cloudflareHeld(local, api);
  // Only where the zones and the account are the suite's to use, and the settings name a team, is the token asked this.
  const own = !!api && !!local.cloudflare.team && !cloudflareStrangers(local, held).length;
  const [zoneList, sites, subdomain, access, wrangler, aws, awsZones, automation] = await Promise.all([
    Promise.all(names.map(async (n) => [n, api ? await zone(n) : null] as const)),
    api ? api("GET", `${acc}/rum/site_info/list?per_page=200`) : null,
    api ? api("GET", `${acc}/workers/subdomain`) : null,
    // An empty request says it: 403 with no permission, 400 (no values) with it. It makes nothing.
    own ? api!("POST", `${acc}/access/apps`, {}).then((r) => ([400, 422] as number[]).includes(r.status)) : null,
    (async () => {
      if (!api) return "";
      const r = sh(["bunx", "wrangler", "whoami"], {
        cwd: ROOT,
        env: { ...process.env, ...dedicatedEnv(local), CLOUDFLARE_API_TOKEN: tokenNow() },
      });
      return r.ok ? `${r.out}\n${r.err}` : "";
    })(),
    (async (): Promise<Facts["aws"]> => {
      if (!awsSet) return { why: "No AWS profile is named.", region: "" };
      const me = sh(["aws", "sts", "get-caller-identity", "--profile", local.aws.profile, "--output", "json"]);
      const region = sh(["aws", "configure", "get", "region", "--profile", local.aws.profile]).out;
      return {
        why: me.ok ? "" : `Profile ${local.aws.profile}: ${(me.err || me.out).trim().split("\n").at(-1) ?? "the AWS CLI failed"}`,
        region,
      };
    })(),
    awsSet ? route53(local) : {},
    process.platform == "darwin" ? safariAutomation() : "Safari runs only on a Mac.",
  ]);
  const zones: Record<string, Zone | null> = Object.fromEntries(zoneList);
  if (sites?.status == 200)
    for (const z of Object.values(zones))
      if (z)
        z.analytics = ((sites.result ?? []) as { auto_install?: boolean; ruleset?: { zone_tag?: string; enabled?: boolean } }[]).some(
          (s) => s.ruleset?.zone_tag == z.id && s.auto_install === true && s.ruleset.enabled !== false
        );
  const installed = (path: () => string) => {
    try {
      return existsSync(path());
    } catch {
      return false;
    }
  };
  const facts: Facts = {
    local,
    token,
    wrangler,
    zones,
    subdomain: (subdomain?.result as { subdomain?: string } | null)?.subdomain ?? null,
    access,
    held: { cloudflare: held, aws: awsSet && !aws.why ? awsHeld(local) : { account: null, stacks: null } },
    aws,
    awsZones,
    browsers: {
      chromium: installed(() => chromium.executablePath()),
      firefox: installed(() => firefox.executablePath()),
      webkit: installed(() => webkit.executablePath()),
    },
    safari: {
      version: sh(["defaults", "read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"]).out,
      automation,
      preview: existsSync("/Applications/Safari Technology Preview.app"),
    },
    system: sh(["sw_vers", "-productVersion"]).out,
  };
  return { facts, api };
}
