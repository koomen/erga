// A new Erga instance (`bun erga setup <host> --host ... --sign-in ...`): the user's answers, which the agent asked
// first and gives as the command's options, and what follows from them alone: the instance's names, its entry in
// .erga/config.json, its plain settings, its database's first rows, its GitHub App. Pure: no network, no files. The
// flow (what the command does next) is deploy/own/flow.ts.

import { type CloudflareEntry, DEFAULT_BRANCH, DEFAULT_REPO, repoName } from "../cli/config";
import { type Target, targetFacts } from "../pipeline/pipeline";
import { SIGN_IN_DAYS_MAX } from "../../gate/core.ts";

export type Where = "cloudflare" | "aws";
/** Who may sign in: users the admin invites, they and an organization's users, or everyone the organization's single sign-on lets pass. */
export type SignIn = "invite" | "organization" | "sso";

/** The user's answers. "" is "not answered yet". No secret is ever in here. */
export interface Answers {
  /** The instance's address: a hostname on a domain of the user's account ("erga.example.com"). The command's. */
  host: string;
  /** --repo, --branch: the repository and the branch that the instance tracks: each deploy gives it that branch's head. */
  repo: string;
  branch: string;
  where: Where | "";
  /** Cloudflare: the account that holds the host's domain: its id, or its name (found; asked only when two accounts hold it). */
  account: string;
  /** AWS: the AWS CLI's profile (asked only with more than one), its region, and the machine's way out to the internet. */
  profile: string;
  region: string;
  egress: string;
  signIn: SignIn | "";
  /** organization: a GitHub organization's login, or a Google Workspace's domain. */
  organization: string;
  /** sso on Cloudflare (Cloudflare Access): the Zero Trust team's name, and the Access application's audience tag (typed on the page). */
  team: string;
  aud: string;
  /** sso on AWS (an Application Load Balancer): the organization's OIDC issuer's URL, and Erga's client ID there. */
  issuer: string;
  client: string;
  /** sso on AWS, when the sign-in gives no `email`: the claim with the address, and the text before it ("preferred_username:corp|"). */
  emailClaim: string;
  /** sso on AWS: how many days a sign-in at the gate lasts ("": the gate's 30). Without sso, an admin sets it on /admin/settings. */
  signInDays: string;
  /** Documents' pages: "shared", or a domain. "": the default (pagesOf). */
  pages: string;
  /** --remote (or $SSH_CONNECTION): the user is at another computer. Their steps go through their terminal, never a browser here. */
  remote: boolean;
}

/** The answers that an option gives as text. */
export type TextAnswer = Exclude<keyof Answers, "remote">;

export const noAnswers = (host: string): Answers => ({
  host,
  repo: DEFAULT_REPO,
  branch: DEFAULT_BRANCH,
  where: "",
  account: "",
  profile: "",
  region: "",
  egress: "nat-instance",
  signIn: "",
  organization: "",
  team: "",
  aud: "",
  issuer: "",
  client: "",
  emailClaim: "",
  signInDays: "",
  pages: "",
  remote: false,
});

export const sso = (a: Pick<Answers, "signIn">) => a.signIn == "sso";

/**
 * Where documents' pages run. Cloudflare: one shared workers.dev address (safe for one author; a domain of their own
 * is a later change). AWS: a domain. With single sign-on it is pages.<host>: the gate in front guards both, with the
 * user's sign-on. Without it, the pages need a whole zone that isn't the app's (a page's
 * script must not share the app's site), so the user names one ("": not answered).
 */
export const pagesOf = (a: Answers): string => a.pages || (a.where != "aws" ? "shared" : sso(a) ? `pages.${a.host}` : "");

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Reads one answer as the user gave it: its value, or why it isn't one. */
export function parseAnswer(key: TextAnswer, raw: string): { value: string } | { problem: string } {
  const v = raw.trim();
  const low = v.toLowerCase();
  const is = (ok: boolean, value: string, problem: string) => (ok ? { value } : { problem });
  switch (key) {
    case "host":
      return is(HOST.test(low), low, `"${v}" isn't an address like erga.example.com.`);
    case "repo":
      return is(/^[^\s-]\S{2,300}$/.test(v), repoName(v), `"${v}" isn't a repository like ${DEFAULT_REPO}.`);
    case "branch":
      return is(/^[\w.][\w./-]{0,200}$/.test(v), v, `"${v}" isn't a branch's name.`);
    case "where":
      return is(low == "cloudflare" || low == "aws", low, "where is cloudflare or aws.");
    case "account":
      return is(v.length > 0 && v.length <= 200, /^[0-9a-f]{32}$/.test(low) ? low : v, "account is the Cloudflare account's name or id.");
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
      return is(low == "invite" || low == "organization" || low == "sso", low, "signIn is invite, organization or sso.");
    case "organization":
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
    case "emailClaim":
      return is(
        /^[A-Za-z_][\w.-]{0,63}(:[^\s@:]{0,64})?$/.test(v),
        v,
        `"${v}" isn't <claim>:<prefix>, like preferred_username:corp| for "corp|ada@example.com".`
      );
    case "signInDays":
      return is(
        /^[1-9]\d?$/.test(v) && Number(v) <= SIGN_IN_DAYS_MAX,
        v,
        `"${v}" isn't a whole number of days from 1 to ${SIGN_IN_DAYS_MAX}.`
      );
    case "pages":
      return is(low == "shared" || HOST.test(low), low, "pages is shared, or a domain.");
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

/** The settings' defaults that the answer sets (SERVER_DEFAULTS): an admin can change each on its admin page (/admin). */
export const defaultsOf = (a: Pick<Answers, "signIn">) => ({ public_sharing: a.signIn == "invite", delete_docs_after_hours: null });

/** --email-claim's parts: the claim with the address, and the text before the address; null: not answered. */
export const emailOf = (a: Pick<Answers, "emailClaim">): { claim: string; prefix: string } | null => {
  const [claim, prefix = ""] = a.emailClaim.split(":");
  return claim ? { claim, prefix } : null;
};

/**
 * Single sign-on: the server's setting for the proxy in front (PROXY_SIGN_IN, which the server reads no more: the gate replaced it, server/identity/mode.ts); null without
 * it. `signer`: on AWS, the proxy's ARN (the stack's output). A proxy whose values aren't all known yet gives "{}".
 * A server with any value here and no gate's key (GATE_KEY) refuses to come up: no other sign-in stands in.
 */
export function proxySetting(a: Answers, signer?: string): string | null {
  if (!sso(a)) return null;
  if (a.where == "aws") {
    const email = emailOf(a);
    return signer ? JSON.stringify({ kind: "aws-alb", signer, issuer: a.issuer, client: a.client, ...(email ? { email } : {}) }) : "{}";
  }
  return JSON.stringify({ kind: "cloudflare-access", team: a.team, aud: a.aud });
}

/** The names of the plain settings that varsOf gives: what the answers decide in an entry. */
export const ANSWER_VARS = ["GITHUB_CLIENT_ID", "PROXY_SIGN_IN", "SERVER_DEFAULTS"];

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
 * own way: first.ts, deploy/aws/setup.ts): the access rule that the answer names. An organization's users may sign in and
 * write: a GitHub organization's members, or a Google Workspace's (once Google sign-in is on). With single sign-on,
 * everybody who passes the proxy may. No admin: the user who opens setup's one-time link becomes it
 * (server/identity/claim.ts).
 */
export function firstRows(a: Answers, now = Date.now()): FirstRow[] {
  const rule = (kind: string, value: string): FirstRow => ({
    table: "access_rules",
    row: { kind, value, access: "write", created: now },
    onConflict: "(kind, value) DO UPDATE SET access = 'write'",
  });
  if (sso(a)) return [rule("everybody", "")];
  if (a.signIn == "organization" && a.organization)
    return [rule(a.organization.includes(".") ? "workspace" : "github_org", a.organization)];
  return [];
}

/**
 * An instance's names. With an entry (.erga/config.json), the entry's. Without one, a new instance's, from its
 * address: erga.example.com gives the Worker and the database erga-example-com (on AWS, the stack). The bucket and the
 * shared pages Worker have the Worker's name (deploy/deployer/cloudflare.ts, bucketName).
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

export const callbackOf = (host: string) => `https://${host}/_edge/callback`;

/**
 * The entry of `.erga/config.json` for a new instance on Cloudflare, from the answers alone: its names, its plain
 * settings, and the repository and the branch that it tracks (its first deploy takes that branch's head).
 */
export function setupEntry(a: Answers, o: { zones: string[]; subdomain: string | null; github?: string }): CloudflareEntry {
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
    vars: varsOf(a, o.github),
    secrets: {},
  };
  return {
    host: a.host,
    repo: a.repo,
    branch: a.branch,
    ...targetFacts(target),
  };
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
