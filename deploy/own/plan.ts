// A new Erga instance (`bun erga setup <host>`): the person's answers, and what follows from them alone: the
// instance's names, its entry in .erga/config.json, its plain settings, its database's first rows, its GitHub App.
// Pure: no network, no files. The flow (which answer is asked when, and who does each step) is deploy/own/flow.ts.

import type { CloudflareEntry } from "../cli/config";
import { deployFacts } from "../pipeline/account";
import type { Target } from "../pipeline/pipeline";

export type Where = "cloudflare" | "aws";
/** Who may sign in: people the admin invites, they and a company's people, or everyone the company's single sign-on lets pass. */
export type SignIn = "invite" | "company" | "sso";

/** The person's answers. "" is "not answered yet". No secret is ever in here. */
export interface Answers {
  /** The instance's address: a hostname on a domain of the person's account ("erga.example.com"). The command's. */
  host: string;
  /** A staging instance's setup: its primary's host, which has an entry in .erga/config.json. */
  stagingOf: string;
  where: Where | "";
  /** Cloudflare: the account that holds the host's domain (found; asked only when two accounts hold it). */
  account: string;
  /** AWS: the AWS CLI's profile (asked only with more than one), its region, and the machine's way out to the internet. */
  profile: string;
  region: string;
  egress: string;
  signIn: SignIn | "";
  /** company: a GitHub organization's login, or a Google Workspace's domain. */
  company: string;
  /** sso on Cloudflare (Cloudflare Access): the Zero Trust team's name, and the Access application's audience tag (typed on the page). */
  team: string;
  aud: string;
  /** sso on AWS (an Application Load Balancer): the company's OIDC issuer's URL, and Erga's client ID there. */
  issuer: string;
  client: string;
  /** Documents' pages: "shared", or a domain. "": the default (pagesOf). */
  pages: string;
  /** The person's yes to the plan: the plan it was said to (planKey). Another answer after it asks again. */
  confirm: string;
}

export const noAnswers = (host: string): Answers => ({
  host,
  stagingOf: "",
  where: "",
  account: "",
  profile: "",
  region: "",
  egress: "nat-instance",
  signIn: "",
  company: "",
  team: "",
  aud: "",
  issuer: "",
  client: "",
  pages: "",
  confirm: "",
});

export const sso = (a: Pick<Answers, "signIn">) => a.signIn == "sso";

/**
 * Where documents' pages run. Cloudflare: one shared workers.dev address (safe for one author; a domain of their own
 * is a later change). AWS: a domain. With single sign-on it is pages.<host>: the proxy's certificate is the stack's
 * own, and the person's sign-on guards both. Without it, the pages need a whole zone that isn't the app's (a page's
 * script must not share the app's site), so the person names one ("": not answered).
 */
export const pagesOf = (a: Answers): string => a.pages || (a.where != "aws" ? "shared" : sso(a) ? `pages.${a.host}` : "");

/** The plan that a yes is said to: every answer that decides what is made. */
export const planKey = (a: Answers): string =>
  [
    a.host,
    a.stagingOf,
    a.where,
    a.account,
    a.profile,
    a.region,
    a.egress,
    a.signIn,
    a.company,
    a.team,
    a.issuer,
    a.client,
    pagesOf(a),
  ].join("|");

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Reads one answer as the person gave it: its value, or why it isn't one. */
export function parseAnswer(key: keyof Answers, raw: string): { value: string } | { problem: string } {
  const v = raw.trim();
  const low = v.toLowerCase();
  const is = (ok: boolean, value: string, problem: string) => (ok ? { value } : { problem });
  switch (key) {
    case "host":
    case "stagingOf":
      return is(HOST.test(low), low, `"${v}" isn't an address like erga.example.com.`);
    case "where":
      return is(low == "cloudflare" || low == "aws", low, "where is cloudflare or aws.");
    case "account":
      return is(/^[0-9a-f]{32}$/.test(low), low, "account is the Cloudflare account's id: 32 hex digits.");
    case "profile":
      return is(/^[\w.+@-]{1,64}$/.test(v), v, `"${v}" isn't an AWS CLI profile's name.`);
    case "region":
      return is(/^[a-z]{2}(-[a-z]+)+-\d$/.test(low), low, `"${v}" isn't an AWS region like us-east-1.`);
    case "egress":
      return is(
        low == "nat-instance" || low == "nat-gateway" || /^vpc-[0-9a-f]+\/subnet-[0-9a-f]+$/.test(low),
        low,
        "egress is nat-instance, nat-gateway, or <vpc id>/<private subnet id>."
      );
    case "signIn":
      return is(low == "invite" || low == "company" || low == "sso", low, "signIn is invite, company or sso.");
    case "company":
      return is(
        /^[a-z0-9][a-z0-9.-]{0,99}$/.test(low),
        low,
        `"${v}" isn't a GitHub organization (acme-inc) or an email domain (acme.com).`
      );
    case "team": {
      const team = low.replace(/\.cloudflareaccess\.com$/, "");
      return is(
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(team),
        team,
        `"${v}" isn't a Zero Trust team's name: the part before .cloudflareaccess.com.`
      );
    }
    case "aud":
      return is(/^[0-9a-f]{32,128}$/.test(low), low, "The Audience tag is 64 letters and digits.");
    case "issuer":
      return is(
        /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w.~/-]*)?$/i.test(v),
        v.replace(/\/+$/, ""),
        `"${v}" isn't an issuer's URL (https://...).`
      );
    case "client":
      return is(/^[\w.~-]{1,128}$/.test(v), v, `"${v}" isn't a client ID.`);
    case "pages":
      return is(low == "shared" || HOST.test(low), low, "pages is shared, or a domain.");
    case "confirm":
      return is(low == "yes", low, "confirm is yes.");
  }
}

/** The zone (of `zones`) that holds `host`: the longest one, or null. */
export const zoneOf = (host: string, zones: string[]): string | null =>
  zones.filter((z) => host == z || host.endsWith(`.${z}`)).sort((x, y) => y.length - x.length)[0] ?? null;

/** Why the pages' domain can't be `pages`, on AWS, or null. `zones`: the account's Route 53 zones. */
export function pagesProblem(a: Answers, zones: string[]): string | null {
  const pages = pagesOf(a);
  if (a.where != "aws" || !pages) return null;
  if (pages == "shared") return "On AWS the documents' pages need a domain.";
  if (sso(a))
    return !zoneOf(pages, zones)
      ? `${pages} isn't on a Route 53 zone of this account.`
      : pages == a.host || a.host.endsWith(`.${pages}`)
        ? "The documents' pages need a name of their own: not the app's, and not one above it."
        : null;
  if (!zones.includes(pages)) return `${pages} isn't a Route 53 zone of this account: the pages need a whole zone of their own.`;
  return zoneOf(a.host, zones) == pages
    ? "The documents' pages need another domain than the app's: a page's script must not share the app's site."
    : null;
}

/** The settings' defaults that the answer sets (SERVER_DEFAULTS): an admin can change each on /admin/settings. */
export const defaultsOf = (a: Pick<Answers, "signIn">) => ({ public_sharing: a.signIn == "invite", delete_docs_after_hours: null });

/**
 * Single sign-on: the server's setting for the proxy in front (PROXY_SIGN_IN: server/identity/proxy.ts); null without
 * it. `signer`: on AWS, the proxy's ARN (the stack's output). A proxy whose values aren't all known yet gives "{}",
 * which the server reads as no proxy: then nobody signs in, and no other sign-in stands in.
 */
export function proxySetting(a: Answers, signer?: string): string | null {
  if (!sso(a)) return null;
  if (a.where == "aws") return signer ? JSON.stringify({ kind: "aws-alb", signer, issuer: a.issuer, client: a.client }) : "{}";
  return JSON.stringify({ kind: "cloudflare-access", team: a.team, aud: a.aud });
}

/**
 * Single sign-on: what a browser that isn't signed in must be sent to by the proxy in front, for the check after a
 * deploy (facts.ts). Cloudflare Access sends to the team's address; AWS's proxy names Erga's client and its own callback.
 */
export const proxyExpects = (a: Answers): { to?: string; clientId?: string; callback?: string } =>
  a.where == "aws" ? { clientId: a.client, callback: `https://${a.host}/oauth2/idpresponse` } : { to: `${a.team}.cloudflareaccess.com` };

/** The instance's plain settings: its sign-in (the GitHub App's id, or the proxy), and the settings' defaults. */
export function varsOf(a: Answers, github: string | undefined, signer?: string): Record<string, string> {
  const proxy = proxySetting(a, signer);
  return {
    GITHUB_CLIENT_ID: proxy == null ? (github ?? "") : "",
    ...(proxy == null ? {} : { PROXY_SIGN_IN: proxy }),
    SERVER_DEFAULTS: JSON.stringify(defaultsOf(a)),
  };
}

/** A row of a new server's database: its table, its values by column, what happens if it is there already. */
export interface FirstRow {
  table: string;
  row: Record<string, string | number>;
  /** After ON CONFLICT. */
  onConflict: string;
}

/**
 * The rows a new server's database gets with its first deploy, only while it has no admin (each host writes them in its
 * own way: first.ts, deploy/aws/setup.ts): the access rule that the answer names. A company's people may sign in and
 * write: a GitHub organization's members, or a Google Workspace's (once Google sign-in is on). With single sign-on,
 * everybody who passes the proxy may. No admin: the person who opens the setup page's link becomes it
 * (server/identity/claim.ts).
 */
export function firstRows(a: Answers, now = Date.now()): FirstRow[] {
  const rule = (kind: string, value: string): FirstRow => ({
    table: "access_rules",
    row: { kind, value, access: "write", created: now },
    onConflict: "(kind, value) DO UPDATE SET access = 'write'",
  });
  if (sso(a)) return [rule("everybody", "")];
  if (a.signIn == "company" && a.company) return [rule(a.company.includes(".") ? "workspace" : "github_org", a.company)];
  return [];
}

/**
 * An instance's names. With an entry (.erga/config.json), the entry's. Without one, a new instance's, from its
 * address: erga.example.com gives the Worker and the database erga-example-com (on AWS, the stack). The bucket and the
 * shared pages Worker have the Worker's name (deploy/pipeline/account.ts, bucketName).
 */
export function namesOf(
  host: string,
  entry?: { worker: string; database: string } | null
): { worker: string; database: string; bucket: string; pagesWorker: string } {
  const worker =
    entry?.worker ??
    host
      .replace(/\./g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 54)
      .replace(/-+$/, "");
  return { worker, database: entry?.database ?? worker, bucket: `${worker}-files`, pagesWorker: `${worker}-pages` };
}

/** The stack's name of the instance on AWS. */
export const stackOf = (a: Answers) => namesOf(a.host).worker;

/**
 * The commit a new instance gets: origin's main, as this clone knows it (git fetch to update it). A primary's deploy moves
 * main to its commit (deploy/cli/deploy.ts), so a setup from a feature branch never puts that branch on main.
 */
export const SETUP_COMMIT = "origin/main";
export const callbackOf = (host: string) => `https://${host}/auth/github/callback`;

/**
 * The entry of `.erga/config.json` for a new instance on Cloudflare, from the answers alone: its names, its plain
 * settings, and no token yet (the token comes at the end, when the admin approves it). A staging instance names its
 * primary, and takes the settings' defaults from it (`base`: the primary's vars).
 */
export function setupEntry(
  a: Answers,
  o: { zones: string[]; subdomain: string | null; github?: string; base?: Record<string, string> }
): CloudflareEntry {
  const n = namesOf(a.host);
  const pages = pagesOf(a);
  const target: Target = {
    label: a.host,
    accountId: a.account,
    workerName: n.worker,
    databaseName: n.database,
    ...(pages == "shared" ? { subdomain: o.subdomain ?? n.worker.slice(0, 40), createSubdomain: !o.subdomain } : {}),
    app: { kind: "domain", zoneName: zoneOf(a.host, o.zones)!, hostname: a.host },
    pages: pages == "shared" ? { kind: "shared" } : { kind: "zone", zoneName: pages },
    vars: { ...varsOf(a, o.github), ...(o.base?.SERVER_DEFAULTS ? { SERVER_DEFAULTS: o.base.SERVER_DEFAULTS } : {}) },
    secrets: {},
  };
  return { host: a.host, ...(a.stagingOf ? { stagingOf: a.stagingOf } : {}), ...deployFacts(target), token: "" };
}

/** The GitHub App's manifest (GitHub makes the app from it in one click): sign-in only, no permissions. */
export const githubManifest = (a: Answers, redirect: string): Record<string, unknown> => ({
  name: `Erga ${a.host}`.slice(0, 34),
  url: `https://${a.host}`,
  redirect_url: redirect,
  callback_urls: [callbackOf(a.host)],
  description: `Sign-in for the Erga at https://${a.host}`,
  public: false,
  request_oauth_on_install: false,
  hook_attributes: { url: `https://${a.host}/`, active: false },
  default_permissions: {},
});
