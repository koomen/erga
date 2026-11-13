// A new Erga instance (`bun erga setup <host>`): what the person decides, the names that follow from it, and the steps
// from a clone to a registered instance. Pure: no network, no files (deploy/own/facts.ts observes; deploy/own/cli.ts
// acts). `bun erga setup skill` is the manual; `bun erga setup <host> status` prints these steps, and the Setup tab of the
// ops page (deploy/own/page.ts) shows them.

import { PROXY_FREE_PATHS } from "../proxy-paths";
import { oidcSecretName } from "../aws/template";
import type { CloudflareEntry } from "../cli/config";
import { deployFacts } from "../pipeline/account";
import type { Target } from "../pipeline/pipeline";

/** The person's decisions, asked all at once (`bun erga setup <host> ask`), with these defaults. No secret is ever in here. */
export interface Answers {
  /** Where the instance runs: the person's Cloudflare account, or their AWS account. */
  provider: Provider;
  /**
   * The production address: a hostname on a zone in the account ("erga.example.com"). On AWS it may also be a short
   * name ("erga"): then the app and the pages have CloudFront's own names, and no domain is needed.
   */
  host: string;
  /** A staging server too, at its own address (empty: none). */
  staging: string;
  /**
   * How people sign in (server/identity/mode.ts). oauth: Erga signs them in itself, with the providers below. proxy: a
   * proxy in front of the server signs them in, with the company's own sign-in. The mode does not follow the host.
   */
  signIn: "oauth" | "proxy";
  /** The oauth mode: who may sign in with what: GitHub always (the first admin signs in with it); Google too if chosen. */
  providers: ("github" | "google")[];
  /** What the server is for: its settings' defaults (PRESETS). */
  preset: PresetName;
  /** The first admin: their GitHub login (oauth), or their email address as the company's sign-in gives it (proxy). */
  admin: string;
  /** "company" only: a Google Workspace domain or GitHub organization whose people may sign in. */
  company: string;
  /** Documents' pages: "shared" (one workers.dev host) or a second zone of the account's, never the app's own. */
  pages: string;
  /** The GitHub repository (owner/name) where feedback opens issues: the setting feedback_repository (empty: none). */
  feedback: string;
  /** AWS: the AWS CLI's profile (the account; empty: the CLI's default), and the region. */
  awsProfile: string;
  awsRegion: string;
  /** AWS: the machine's way out to the internet: a NAT machine, a NAT gateway, or "<vpc id>/<private subnet id>" of the person's own. */
  egress: string;
  /**
   * The proxy mode on AWS: the proxy is an Application Load Balancer (not CloudFront) with the company's OIDC sign-in: its issuer's
   * URL, and Erga's client ID there.
   */
  oidc: string;
  oidcClient: string;
  /**
   * The proxy mode on Cloudflare: the proxy is Cloudflare Access: the Zero Trust team's name (its sign-in is at
   * https://<team>.cloudflareaccess.com), and the audience tag of the Access application in front of the app.
   */
  accessTeam: string;
  accessAud: string;
}

/** Whether a proxy in front signs people in (the proxy mode), on either host. */
export const proxySignIn = (a: Pick<Answers, "signIn">) => a.signIn == "proxy";

/**
 * The proxy mode's setting for the server (PROXY_SIGN_IN: server/identity/proxy.ts), from the answers; null in the
 * oauth mode. `signer`: on AWS, the proxy's ARN (the stack's output). A proxy whose values aren't all known
 * yet gives "{}", which the server reads as no proxy: then nobody signs in, and no other sign-in stands in.
 */
export function proxySetting(a: Answers, signer?: string): string | null {
  if (!proxySignIn(a)) return null;
  if (a.provider == "aws") return signer ? JSON.stringify({ kind: "aws-alb", signer, issuer: a.oidc, client: a.oidcClient }) : "{}";
  return JSON.stringify({ kind: "cloudflare-access", team: a.accessTeam, aud: a.accessAud });
}

export type PresetName = "website" | "company";
export type Provider = "cloudflare" | "aws";

/**
 * What each preset sets. `defaults` go to the server as SERVER_DEFAULTS: defaults that the admins can still change on
 * /admin/settings (not locked). `open` says who may sign in besides the admins and people they add.
 */
export const PRESETS: Record<PresetName, { title: string; summary: string; defaults: Record<string, unknown>; open: string }> = {
  website: {
    title: "A website",
    summary:
      "Your homepage is public. Documents you share with anyone with the link open for everyone. Only you (and people you add) sign in.",
    defaults: { public_sharing: true, delete_docs_after_hours: null },
    open: "Only the admins, and the people an admin adds on /admin/users.",
  },
  company: {
    title: "Sharing docs in my company",
    summary: "Documents stay inside: nothing opens for people who are not signed in. People of your company sign in by themselves.",
    defaults: { public_sharing: false, delete_docs_after_hours: null },
    open: "The admins, people an admin adds, and everyone in the company's domain or GitHub organization (an access rule).",
  },
};

export const QUESTIONS: { key: keyof Answers; ask: string; help: string; aws?: true }[] = [
  {
    key: "provider",
    ask: "Host",
    help: "cloudflare (your Cloudflare account, Workers Paid plan) or aws (your AWS account: one machine, its bucket, CloudFront in front).",
  },
  {
    key: "host",
    ask: "Production address",
    help: "A name on a domain of your account, e.g. erga.example.com (Cloudflare: a zone on the account; AWS: a Route 53 hosted zone). On AWS, a short name (erga) instead: the app gets CloudFront's own address, and no domain is needed. Nothing may use it yet.",
  },
  {
    key: "staging",
    ask: "Staging server (address, or no)",
    help: "A second server for trying updates first, e.g. staging.example.com. Default: no.",
  },
  {
    key: "signIn",
    ask: "Sign-in mode",
    help: "oauth (Erga signs people in itself, with GitHub and, if you choose, Google) or proxy (a proxy in front of the server signs each person in with your company's sign-in, and Erga takes that as its own: no GitHub, no Google). The proxy is an Application Load Balancer on AWS (oidc, oidcClient), and Cloudflare Access on Cloudflare (accessTeam, accessAud). Default: oauth.",
  },
  { key: "providers", ask: "Sign-in providers (oauth)", help: "github, or github,google. The first admin signs in with GitHub." },
  { key: "preset", ask: "Server preset", help: `website (${PRESETS.website.summary}) or company (${PRESETS.company.summary})` },
  {
    key: "admin",
    ask: "Admin (your GitHub login)",
    help: "You become the first admin. With signIn=proxy: your email address, as your company's sign-in gives it.",
  },
  {
    key: "company",
    ask: "Company domain or GitHub org (company preset only)",
    help: "e.g. example.com or my-org. Empty: only people an admin adds.",
  },
  {
    key: "pages",
    ask: "Documents' pages",
    help: "shared (one address for all of them: workers.dev, or on AWS CloudFront's; no domain needed) or a second domain on your account (never the app's): each document gets an origin of its own. Shared is safe for one author only: there, a script in one document can reach what another document's page keeps in the browser. On AWS: shared with a short name, a domain with a domain. With signIn=proxy on AWS, any name on a zone of the account that is not the app's, also one under it (pages.erga.example.com).",
  },
  {
    key: "feedback",
    ask: "Feedback's repository (owner/name, or no)",
    help: "Send feedback opens a GitHub issue there, without the sender's name. Default: no. An admin can change it later.",
  },
  {
    key: "awsProfile",
    ask: "AWS profile (aws only)",
    help: "The AWS CLI's profile for the account (aws configure list-profiles). Empty: the CLI's default.",
    aws: true,
  },
  { key: "awsRegion", ask: "AWS region (aws only)", help: "Where the machine and its bucket are, e.g. us-east-1 or eu-west-1.", aws: true },
  {
    key: "egress",
    ask: "The machine's way out (aws only)",
    help: "nat-instance (a small NAT machine, about $7 a month), nat-gateway (AWS's managed NAT, about $33 a month), or <vpc id>/<private subnet id> of a VPC of yours that has its own way out and an internet gateway. The machine never has a public address.",
    aws: true,
  },
  {
    key: "oidc",
    ask: "Your company's sign-in (signIn=proxy on aws: its OIDC issuer's URL)",
    help: "A public Application Load Balancer (not CloudFront) signs each person in with your company's sign-in before Erga. It needs a domain for the app (the sign-in's callback is https://<host>/oauth2/idpresponse), and the client's secret in Secrets Manager. Default: no.",
    aws: true,
  },
  {
    key: "oidcClient",
    ask: "Erga's client ID at that sign-in (signIn=proxy on aws)",
    help: "The sign-in's admin gives it, with the secret.",
    aws: true,
  },
  {
    key: "accessTeam",
    ask: "Your Zero Trust team's name (signIn=proxy on cloudflare)",
    help: "The name before .cloudflareaccess.com (Zero Trust > Settings > Custom Pages shows the team domain). Cloudflare Access signs each person in before Erga.",
  },
  {
    key: "accessAud",
    ask: "The Access application's audience tag (signIn=proxy on cloudflare)",
    help:
      "Make the application first: Zero Trust > Access > Applications > Add an application > Self-hosted, for the app's address (and staging's), with a policy for who may pass. Its Application Audience (AUD) Tag is on its Overview. Then add a second application for the paths that need no sign-in, with a Bypass policy for Everyone: " +
      PROXY_FREE_PATHS.join(", ") +
      ".",
  },
];

export const defaultAnswers = (admin = ""): Answers => ({
  provider: "cloudflare",
  host: "",
  staging: "",
  signIn: "oauth",
  providers: ["github"],
  preset: "website",
  admin,
  company: "",
  pages: "shared",
  feedback: "",
  awsProfile: "",
  awsRegion: "us-east-1",
  egress: "nat-instance",
  oidc: "",
  oidcClient: "",
  accessTeam: "",
  accessAud: "",
});

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** An AWS instance's short name, when it has no domain: CloudFront gives its addresses. */
const NAME = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
/** Whether the setup's host is a short name (no domain) rather than an address. */
export const isName = (host: string) => NAME.test(host);
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const EMAIL = /^[^\s@']+@[^\s@']+\.[a-z]{2,63}$/i;

/** Reads one answer as the person typed it: the value, or why it isn't one. */
export function parseAnswer(key: keyof Answers, raw: string): { value: Answers[keyof Answers] } | { problem: string } {
  const v = raw.trim();
  const off = /^(no|none|off|false|-)?$/i.test(v);
  switch (key) {
    case "provider":
      return v == "cloudflare" || v == "aws" ? { value: v } : { problem: "The host is cloudflare or aws." };
    case "host":
      return HOST.test(v.toLowerCase()) || NAME.test(v.toLowerCase())
        ? { value: v.toLowerCase() }
        : { problem: `"${v}" isn't a hostname like erga.example.com, or a short name like erga (AWS).` };
    case "awsProfile":
      return off || /^[\w.+@-]{1,64}$/.test(v) ? { value: off ? "" : v } : { problem: `"${v}" isn't an AWS CLI profile name.` };
    case "awsRegion":
      return /^[a-z]{2}(-[a-z]+)+-\d$/.test(v) ? { value: v } : { problem: `"${v}" isn't an AWS region like us-east-1.` };
    case "egress":
      return v == "nat-instance" || v == "nat-gateway" || /^vpc-[0-9a-f]+\/subnet-[0-9a-f]+$/.test(v)
        ? { value: v }
        : { problem: "The way out is nat-instance, nat-gateway, or <vpc id>/<subnet id> (vpc-.../subnet-...)." };
    case "signIn":
      return off || v == "oauth"
        ? { value: "oauth" }
        : v == "proxy"
          ? { value: "proxy" }
          : { problem: "The sign-in mode is oauth or proxy." };
    case "staging":
      if (off) return { value: "" };
      return HOST.test(v.toLowerCase()) ? { value: v.toLowerCase() } : { problem: `"${v}" isn't a hostname, or "no".` };
    case "providers": {
      const list = [
        ...new Set(
          v
            .toLowerCase()
            .split(/[\s,+]+/)
            .filter(Boolean)
        ),
      ];
      if (list.some((p) => p != "github" && p != "google")) return { problem: "Sign-in is github, or github,google." };
      return { value: ["github", ...(list.includes("google") ? ["google" as const] : [])] as Answers["providers"] };
    }
    case "preset":
      return v == "website" || v == "company" ? { value: v } : { problem: "The preset is website or company." };
    case "admin":
      return LOGIN.test(v) || EMAIL.test(v)
        ? { value: v.toLowerCase() }
        : { problem: `"${v}" isn't a GitHub login (or, with signIn=proxy, an email address).` };
    case "oidc":
      return off
        ? { value: "" }
        : /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w.~/-]*)?$/i.test(v)
          ? { value: v.replace(/\/+$/, "") }
          : { problem: `"${v}" isn't an issuer's URL (https://...), or "no".` };
    case "oidcClient":
      return off || /^[\w.~-]{1,128}$/.test(v) ? { value: off ? "" : v } : { problem: `"${v}" isn't a client ID.` };
    case "accessTeam": {
      const team = v.toLowerCase().replace(/\.cloudflareaccess\.com$/, "");
      return off || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(team)
        ? { value: off ? "" : team }
        : { problem: `"${v}" isn't a Zero Trust team's name (the name before .cloudflareaccess.com).` };
    }
    case "accessAud":
      return off || /^[0-9a-f]{32,128}$/i.test(v)
        ? { value: off ? "" : v.toLowerCase() }
        : { problem: `"${v}" isn't an Access application's audience (AUD) tag.` };
    case "company":
      return off
        ? { value: "" }
        : /^[a-z0-9.-]{1,100}$/i.test(v)
          ? { value: v.toLowerCase() }
          : { problem: `"${v}" isn't a domain or an organization.` };
    case "pages":
      return off || v == "shared"
        ? { value: "shared" }
        : HOST.test(v.toLowerCase())
          ? { value: v.toLowerCase() }
          : { problem: "Pages are shared, or a domain." };
    case "feedback": {
      const repo = v.replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
      return off
        ? { value: "" }
        : /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)
          ? { value: repo }
          : { problem: `"${v}" isn't a GitHub repository: owner/name, or no.` };
    }
  }
}

/** What's still wrong with the answers as a whole (each one on its own is parsed already); null if nothing. */
export function answersProblem(a: Answers, zones: string[]): string | null {
  if (!a.host) return "Answer the questions first (bun erga setup <host> ask).";
  const proxy = proxySignIn(a);
  if (!a.admin) return `Name the first admin: your ${proxy ? "email address" : "GitHub login"}.`;
  if (proxy != EMAIL.test(a.admin))
    return proxy
      ? "With signIn=proxy, the first admin is an email address: yours, as your company's sign-in gives it (admin=you@example.com)."
      : "The first admin is a GitHub login.";
  // Each host has its own proxy, with its own answers: the other host's, or the oauth mode's, say what to change.
  const awsProxy = proxy && a.provider == "aws";
  if (a.oidc && !awsProxy) return "oidc is for signIn=proxy on AWS: answer signIn=proxy, or oidc=no.";
  if (a.accessTeam && !(proxy && a.provider == "cloudflare"))
    return "accessTeam is for signIn=proxy on Cloudflare (Cloudflare Access signs people in): answer signIn=proxy, or accessTeam=no.";
  if (proxy && a.provider == "cloudflare" && !(a.accessTeam && a.accessAud))
    return "With signIn=proxy on Cloudflare, give the Zero Trust team's name and the Access application's audience tag (accessTeam=... accessAud=...).";
  if (a.provider == "aws") {
    if (a.staging) return "Staging on AWS isn't there yet: answer staging=no.";
    if (awsProxy) {
      if (!a.oidc) return "With signIn=proxy on AWS, give your company's sign-in: its OIDC issuer's URL (oidc=https://...).";
      if (!a.oidcClient) return "Give Erga's client ID at the sign-in (oidcClient=...): its admin has it.";
      if (isName(a.host)) return "A proxy in front needs a domain for the app: the sign-in sends each person back to it.";
      if (a.egress.includes("/")) return "A proxy in front needs the stack's own network: answer egress=nat-instance or nat-gateway.";
    }
    if (isName(a.host) != (a.pages == "shared"))
      return isName(a.host)
        ? "With a short name, the pages share CloudFront's own address: answer pages=shared, or give the app a domain."
        : "With a domain for the app, the pages need a domain of their own too (pages=<domain>).";
    if (isName(a.host)) return null;
  } else if (isName(a.host))
    return `${a.host} is a short name: on Cloudflare the app needs an address on a zone of the account (erga.example.com).`;
  const account = a.provider == "aws" ? "Route 53 hosted zones of this AWS account" : "domains of this Cloudflare account";
  const zoneOf = (h: string) => zones.filter((z) => h == z || h.endsWith(`.${z}`)).sort((x, y) => y.length - x.length)[0] ?? null;
  for (const h of [a.host, a.staging].filter(Boolean))
    if (!zoneOf(h))
      return `${h} isn't on one of the ${account} (${zones.join(", ") || "it has none"}). Add the domain first, or pick a name on one of these.`;
  if (a.staging && a.staging == a.host) return "Staging needs an address of its own.";
  // A proxy's certificate and rules are the stack's own, so the pages take any name on a zone, also one under
  // the app's (the person's decision: under one registrable domain, a page's script can set a cookie for that domain).
  if (a.pages != "shared" && awsProxy) {
    if (!zoneOf(a.pages)) return `${a.pages} isn't on one of the ${account} (${zones.join(", ") || "it has none"}).`;
    if (a.pages == a.host || a.host.endsWith(`.${a.pages}`))
      return "Documents' pages need a name of their own: not the app's, and not one above it.";
  } else if (a.pages != "shared") {
    if (!zones.includes(a.pages)) return `${a.pages} isn't one of the ${account}: pages need a whole zone of their own.`;
    if ([a.host, a.staging].some((h) => h && zoneOf(h) == a.pages))
      return "Documents' pages need a different domain from the app's: a page's scripts must not share the app's site.";
  }
  return null;
}

/** A row of a new server's database: its table, its values by column, what happens if it is there already. */
export interface FirstRow {
  table: string;
  row: Record<string, string | number>;
  /** After ON CONFLICT. */
  onConflict: string;
  /** Only into a database with no admin yet. */
  noAdmin: boolean;
}

/**
 * The rows a new server's database gets with its first deploy, the same on every host (each host writes them in its
 * own way: first.ts, deploy/aws/setup.ts): the first admin, and feedback's repository. In the oauth mode the first
 * admin is a user, by their GitHub login. In the proxy mode they have no username before their first sign-in, so they
 * are a person an admin added (the people table: server/directory/people.ts), by their email; and with the company
 * preset, everybody who passes the proxy may make an account and write.
 */
export function firstRows(a: Answers, now = Date.now()): FirstRow[] {
  const rows: FirstRow[] = [];
  if (proxySignIn(a)) {
    rows.push({
      table: "people",
      row: { provider: "proxy", handle: a.admin, role: "admin", created: now },
      onConflict: "(provider, handle) DO UPDATE SET role = 'admin'",
      noAdmin: true,
    });
    if (a.preset == "company")
      rows.push({
        table: "access_rules",
        row: { kind: "everybody", value: "", access: "write", created: now },
        onConflict: "(kind, value) DO UPDATE SET access = 'write'",
        noAdmin: true,
      });
  } else
    rows.push({
      table: "users",
      row: { login: a.admin, name: a.admin, role: "admin", created: now },
      onConflict: "(login) DO UPDATE SET role = 'admin'",
      noAdmin: true,
    });
  if (a.feedback)
    rows.push({
      table: "server_config",
      row: { key: "feedback_repository", value: JSON.stringify(a.feedback), updated: now, updated_by: a.admin },
      onConflict: "(key) DO NOTHING",
      noAdmin: false,
    });
  return rows;
}

/**
 * The proxy mode: what a browser that isn't signed in must be sent to by the proxy in front of `host`, for the check
 * after a deploy (facts.ts, proxySignInCheck). Each host's proxy has its own: Cloudflare Access sends to the team's
 * address; AWS's proxy names Erga's client and its own callback.
 */
export const proxyExpects = (a: Answers, host: string): { to?: string; clientId?: string; callback?: string } =>
  a.provider == "aws"
    ? { clientId: a.oidcClient, callback: `https://${host}/oauth2/idpresponse` }
    : { to: `${a.accessTeam}.cloudflareaccess.com` };

/** A target's names, from its address: erga.example.com → Worker and database erga-example-com, bucket erga-example-com-files. */
export function namesOf(host: string): { worker: string; database: string; bucket: string; pagesWorker: string } {
  const worker = host
    .replace(/\./g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 54)
    .replace(/-+$/, "");
  return { worker, database: worker, bucket: `${worker}-files`, pagesWorker: `${worker}-pages` };
}

export type TargetName = "production" | "staging";
/**
 * The commit a new instance gets: origin's main, as this clone knows it (git fetch to update it). A primary's deploy moves
 * main to its commit (deploy/cli/deploy.ts), so a setup from a feature branch never puts that branch on main.
 */
export const SETUP_COMMIT = "origin/main";
export const hostOf = (a: Answers, t: TargetName) => (t == "production" ? a.host : a.staging);
export const targetsOf = (a: Answers): TargetName[] => (a.staging ? ["production", "staging"] : ["production"]);
export const callbackOf = (host: string, provider: "github" | "google") => `https://${host}/auth/${provider}/callback`;

/**
 * The bindings of a target that aren't secrets: its sign-in (the oauth mode's apps' ids, or the proxy mode's proxy),
 * the preset. No admin: the database holds them. `signer`: on AWS in the proxy mode, the proxy's ARN.
 */
export function varsOf(a: Answers, ids: { github?: string; google?: string }, signer?: string): Record<string, string> {
  const proxy = proxySetting(a, signer);
  return {
    GITHUB_CLIENT_ID: proxy == null ? (ids.github ?? "") : "",
    ...(proxy == null && a.providers.includes("google") && ids.google ? { GOOGLE_CLIENT_ID: ids.google } : {}),
    ...(proxy == null ? {} : { PROXY_SIGN_IN: proxy }),
    SERVER_CONFIG: "{}",
    SERVER_DEFAULTS: JSON.stringify(PRESETS[a.preset].defaults),
    CLOUDFLARE_OAUTH_CLIENT_ID: "",
    DEPLOY_TARGET: "",
  };
}

/**
 * The pipeline's target for one of the person's servers. It sends `secrets`, and the Worker keeps the ones it has
 * (keepSecrets). `bun erga setup` deploys an entry (setupEntry) with `bun erga deploy`'s code.
 */
export function ownTarget(
  a: Answers,
  t: TargetName,
  o: {
    account: string;
    zones: string[];
    subdomain: string | null;
    ids: { github?: string; google?: string };
    secrets: Record<string, string>;
  }
): Target {
  const host = hostOf(a, t),
    n = namesOf(host);
  const zoneName = o.zones.filter((z) => host == z || host.endsWith(`.${z}`)).sort((x, y) => y.length - x.length)[0];
  return {
    label: t,
    accountId: o.account,
    workerName: n.worker,
    databaseName: n.database,
    ...(a.pages == "shared" ? { subdomain: o.subdomain ?? n.worker.slice(0, 40), createSubdomain: !o.subdomain } : {}),
    app: { kind: "domain", zoneName, hostname: host },
    pages: a.pages == "shared" ? { kind: "shared" } : { kind: "zone", zoneName: a.pages },
    vars: varsOf(a, o.ids),
    secrets: o.secrets,
    keepSecrets: true,
    checkVersion: true,
  };
}

/**
 * The entry of `.erga/config.json` for one of the setup's servers, from the answers alone: its names, its plain settings,
 * and no token yet (the token comes at the end, when the admin approves it). A staging server names its primary.
 */
export function setupEntry(
  a: Answers,
  t: TargetName,
  o: { account: string; zones: string[]; subdomain: string | null; ids: { github?: string; google?: string } }
): CloudflareEntry {
  return {
    host: hostOf(a, t),
    ...(t == "staging" ? { stagingOf: a.host } : {}),
    ...deployFacts(ownTarget(a, t, { ...o, secrets: {} })),
    token: "",
  };
}

// ------------------------------------------------------------------ the steps

/** What the CLI observed (deploy/own/facts.ts): each field is a thing it looked at, or null if it couldn't look. */
export interface Facts {
  bun: string | null;
  /** The checkout's origin, and whether node_modules matches the lockfile. */
  origin: string | null;
  installed: boolean;
  /** The commit setup deploys: origin's main, as this clone knows it (SETUP_COMMIT). */
  head: string | null;
  /** The cf CLI's login: its accounts, or why not. */
  login: { ok: true; accounts: { id: string; name: string }[] } | { ok: false; why: string };
  account: string | null;
  zones: string[];
  workersSubdomain: string | null;
  /** AWS: the production stack as AWS has it (null: not looked at), and whether the templates on disk are the ones applied. */
  stack: { name: string; status: string | null; outputs: Record<string, string>; template: "none" | "new" | "changed" | "applied" } | null;
  /** The proxy mode on AWS: whether the sign-in's client secret is in Secrets Manager (null: not looked at). */
  proxySecret: boolean | null;
  /** By target: what's there now. */
  targets: Partial<Record<TargetName, TargetFacts>>;
  /** Which secrets the secrets file holds, as host:NAME (names only). */
  secrets: string[];
}

export interface TargetFacts {
  /** A Worker by its name: missing, Erga's (ours), or someone else's. */
  worker: "missing" | "ours" | "other";
  /** The address: free, ours (this Worker's custom domain), or taken (a DNS record or another Worker). */
  address: "free" | "ours" | { taken: string };
  /** What /api/deploys/version and /api/health answer. */
  version: string | null;
  health: "ok" | { bad: string } | null;
  /** Where /auth/github sends a person: GitHub with our client id and callback, or why not. */
  signIn: "ok" | { bad: string } | null;
  /** Its entry in .erga/config.json has an ops token: the admin approved it, and the instance is registered. */
  registered: boolean;
  /** The company preset's access rule is there. */
  rule: boolean | null;
  /** What Erga's Worker holds now: its secrets' names, and its plain values (the sign-in apps' ids). Null: no Worker of ours. */
  held: { secrets: string[]; vars: Record<string, string> } | null;
}

export type Who = "agent" | "person";
export type State = "done" | "todo" | "blocked" | "fail";
export interface Step {
  id: string;
  title: string;
  who: Who;
  state: State;
  detail: string;
  next: string;
  target?: TargetName;
}

/** The stack's name of a setup's server on AWS: its name from its address (namesOf). */
export const stackOf = (a: Answers, t: TargetName) => namesOf(hostOf(a, t)).worker;

/** Where a setup's server answers: its address; on AWS with a short name, CloudFront's, known once the stack is made (else null). */
export const addressOf = (a: Answers, t: TargetName, f: Pick<Facts, "stack">): string | null =>
  a.provider == "aws" && isName(hostOf(a, t)) ? (f.stack?.outputs.AppHost ?? null) : hostOf(a, t);

/** The address, or what stands in for it in a step's text until the stack gives it. */
const shown = (a: Answers, t: TargetName, f: Pick<Facts, "stack">) => addressOf(a, t, f) ?? "<the app's CloudFront address>";

/** The secret is in the secrets file under `host`, or on a server's Worker already: a deploy keeps a secret it doesn't send. */
export const hasSecret = (f: Facts, host: string, key: string) =>
  f.secrets.includes(`${host}:${key}`) || Object.values(f.targets).some((t) => t?.held?.secrets.includes(key));

/**
 * Every step, in order, with its state from what was observed. The first step that isn't done is the next one; each
 * says who does it (the agent, or the person) and exactly how. `bun erga setup <host>` runs the agent's steps by itself
 * (the deploys, and the ops token) and stops at a step of the person's.
 */
export function steps(a: Answers | null, f: Facts, o: { port?: number; ids: { github?: string; google?: string } }): Step[] {
  const out: Step[] = [];
  const cmd = `bun erga setup ${a?.host || "<host>"}`;
  const page = o.port ? `http://127.0.0.1:${o.port}/#${a?.host ?? ""}/setup` : `the ops page's Setup tab (${cmd} start)`;
  const add = (s: Omit<Step, "state"> & { ok: boolean | null; failed?: boolean }) => {
    const before = out.length && out.some((x) => x.state != "done");
    out.push({
      id: s.id,
      title: s.title,
      who: s.who,
      detail: s.detail,
      next: s.next,
      target: s.target,
      state: s.ok ? "done" : s.failed ? "fail" : before ? "blocked" : "todo",
    });
  };
  add({
    id: "tools",
    title: "Bun, and the packages",
    who: "agent",
    ok: !!f.bun && f.installed,
    detail: f.bun ? `bun ${f.bun}${f.installed ? ", packages installed" : ""}` : "bun is missing",
    next: !f.bun ? "Install Bun 1.4 or newer: curl -fsSL https://bun.sh/install | bash" : "Run: bun install --frozen-lockfile",
  });
  if (a?.provider == "aws")
    add({
      id: "login",
      title: "Log in to AWS",
      who: "person",
      ok: f.login.ok && !!f.account,
      detail: f.login.ok ? `account ${f.account} (${f.login.accounts[0]?.name}), region ${a.awsRegion}` : f.login.why,
      next: `The person logs the AWS CLI in to their account (aws sso login${a.awsProfile ? ` --profile ${a.awsProfile}` : ""}, or keys with aws configure), and names the profile: ${cmd} set awsProfile=<profile> awsRegion=<region>.`,
    });
  else
    add({
      id: "login",
      title: "Log in to Cloudflare",
      who: "person",
      ok: f.login.ok && !!f.account,
      detail: f.login.ok ? `${f.login.accounts.length} account(s)${f.account ? `; using ${f.account}` : ""}` : f.login.why,
      next: !f.login.ok
        ? "The agent runs `bunx cf auth login`: a browser opens; the person signs in to Cloudflare and clicks Allow."
        : `Several accounts: the agent asks which one, then runs: ${cmd} set account=<id>`,
    });
  const problem = a ? answersProblem(a, f.zones) : "Answer the questions first.";
  add({
    id: "decide",
    title: "The person's decisions",
    who: "person",
    ok: !problem,
    detail: a && !problem ? summary(a) : (problem ?? ""),
    next: `The agent asks all of them in one message (${cmd} ask shows them, with defaults), then records the answers with ${cmd} set key=value ... The person can also answer on ${page}.`,
  });
  if (!a || problem) return out;
  const proxy = proxySignIn(a);
  const awsProxy = proxy && a.provider == "aws";
  if (awsProxy)
    add({
      id: "secret",
      title: "The sign-in's client secret (Secrets Manager)",
      who: "person",
      ok: f.proxySecret,
      detail: f.proxySecret
        ? `the secret ${oidcSecretName(stackOf(a, "production"))} is there`
        : f.proxySecret == null
          ? "not looked at"
          : "not there yet",
      next: `The person who has the client secret stores it in Secrets Manager, in this account and region (${a.awsRegion}), as plain text, with the name ${oidcSecretName(stackOf(a, "production"))} (console: Secrets Manager, Store a new secret, Other type of secret, Plaintext; only the secret, no JSON). Never in the chat, a file or a command. The stack reads it by its name.`,
    });
  if (a.provider == "aws") {
    const st = f.stack;
    const done = !!st?.status && /_COMPLETE$/.test(st.status) && !/ROLLBACK|DELETE/.test(st.status) && st.template == "applied";
    add({
      id: "stack",
      title: "The AWS infrastructure (CloudFormation)",
      who: "person",
      ok: done,
      detail: !st
        ? "not looked at"
        : `stack ${st.name}: ${st.status ?? "not made yet"}${st.template == "changed" ? "; the template on disk changed since it was applied" : st.template == "new" ? "; the template is written, not applied" : ""}`,
      next: `The agent runs ${cmd} stack: it writes the templates into .erga/aws/ (the first time) and shows AWS's change set: what it will make. The person reads them, and may change the template (then the agent runs ${cmd} stack again). After the person's yes: ${cmd} stack --yes. CloudFront takes 5 to 15 minutes.`,
    });
  }
  const ghSecret = hasSecret(f, a.host, "GITHUB_CLIENT_SECRET");
  if (!proxy)
    add({
      id: "github",
      title: "GitHub sign-in app",
      who: "person",
      ok: !!o.ids.github && ghSecret,
      detail: o.ids.github ? `client id ${o.ids.github}${ghSecret ? ", secret stored" : ", no secret yet"}` : "none yet",
      next: `On ${page}, the person clicks "Create the GitHub App", then "Create GitHub App" on GitHub. Erga stores its id and secret by itself. (Already have an app? ${cmd} signin github --from-file <file with GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET>, and add the callback ${targetsOf(
        a
      )
        .map((t) => callbackOf(shown(a, t, f), "github"))
        .join(" and ")} to it.)`,
    });
  if (!proxy && a.providers.includes("google"))
    add({
      id: "google",
      title: "Google sign-in client",
      who: "person",
      ok: !!o.ids.google && hasSecret(f, a.host, "GOOGLE_CLIENT_SECRET"),
      detail: o.ids.google ? `client id ${o.ids.google}` : "none yet",
      next: `The person makes an OAuth client at https://console.cloud.google.com/auth/clients/create (type: Web application; authorized redirect URI${a.staging ? "s" : ""}: ${targetsOf(
        a
      )
        .map((t) => callbackOf(shown(a, t, f), "google"))
        .join(", ")}), then types its id and secret on ${page} (never in the chat).`,
    });
  for (const t of targetsOf(a)) {
    const host = shown(a, t, f),
      tf = f.targets[t];
    const n = namesOf(hostOf(a, t));
    const live = !!tf && tf.health == "ok" && !!tf.version && tf.version == f.head?.slice(0, 12);
    const clash =
      tf &&
      (tf.worker == "other"
        ? `A Worker called ${n.worker} is already there, and it isn't Erga.`
        : typeof tf.address == "object"
          ? `${host} is taken: ${tf.address.taken}.`
          : null);
    add({
      id: `deploy-${t}`,
      target: t,
      title: `Deploy ${t} to https://${host}`,
      who: "agent",
      ok: live,
      failed: !!clash,
      detail:
        clash ??
        (!tf
          ? "not looked at"
          : tf.version
            ? `release ${tf.version}${f.head && tf.version != f.head.slice(0, 12) ? ` (origin/main is at ${f.head.slice(0, 12)})` : ""}, health ${tf.health == "ok" ? "ok" : ((tf.health as { bad: string } | null)?.bad ?? "unknown")}`
            : "not deployed yet"),
      next: clash
        ? `The person decides: free ${host} or pick another address (${cmd} set host=...).`
        : `Run: ${cmd} (it deploys, then writes the first admin${a.feedback ? " and the feedback repository" : ""} into the database).`,
    });
    add({
      id: `signin-${t}`,
      target: t,
      title: `Sign-in works on ${host}`,
      who: "agent",
      ok: tf?.signIn == "ok",
      detail:
        tf?.signIn == "ok"
          ? proxy
            ? "a browser goes to your company's sign-in first"
            : "/auth/github goes to GitHub with your app"
          : typeof tf?.signIn == "object" && tf.signIn
            ? tf.signIn.bad
            : "not checked",
      next: awsProxy
        ? `Fix what the detail names (the client ID, or the callback https://${host}/oauth2/idpresponse at the sign-in), then: ${cmd} stack`
        : proxy
          ? `Fix what the detail names (the Access application for https://${host}, or the team's name), then: ${cmd}`
          : `Fix what the detail names (the app's callback URL, or its id), then: ${cmd}`,
    });
  }
  for (const t of targetsOf(a)) {
    const host = shown(a, t, f);
    add({
      id: `register-${t}`,
      target: t,
      title: `${a.admin} signs in to ${host}, and approves the ops token`,
      who: "person",
      ok: !!f.targets[t]?.registered,
      detail: f.targets[t]?.registered ? "registered in .erga/config.json, with an ops token" : "no ops token yet",
      next: awsProxy
        ? `The agent runs ${cmd}: it prints a link. The person opens it, signs in with the company's sign-in as ${a.admin} (the first time, they choose a username: they are the admin), and approves.`
        : `The agent runs ${cmd}: it prints a link. The person opens it, signs in with GitHub as ${a.admin}, and approves.`,
    });
  }
  // In the proxy mode, the company is whoever passes the proxy: the first deploy writes that rule (firstRows).
  if (!proxy && a.preset == "company" && a.company)
    add({
      id: "rule",
      title: `People of ${a.company} may sign in`,
      who: "agent",
      ok: !!f.targets.production?.rule,
      detail: f.targets.production?.rule ? "the access rule is there" : "no rule yet",
      next: `Run: ${cmd} preset (it adds the access rule with your admin token).`,
    });
  return out;
}

export const summary = (a: Answers) =>
  `${a.provider == "aws" ? `on AWS (${a.awsProfile || "the default profile"}, ${a.awsRegion}, way out: ${a.egress}): ${isName(a.host) ? `${a.host}, at CloudFront's own address` : `https://${a.host}`}` : `https://${a.host}`}${a.staging ? `, staging https://${a.staging}` : ", no staging"}; sign-in ${proxySignIn(a) ? `proxy (${a.provider == "aws" ? `an Application Load Balancer, ${a.oidc}` : `Cloudflare Access, ${a.accessTeam}`})` : `oauth (${a.providers.join(" + ")})`}; preset ${a.preset}${a.company ? ` (${a.company})` : ""}; admin ${a.admin}; pages ${a.pages == "shared" ? `on one shared ${a.provider == "aws" ? "CloudFront" : "workers.dev"} address` : `on *.${a.pages}`}; feedback ${a.feedback ? `to ${a.feedback}` : "kept on the server"}`;

/** The step to do now: the first that isn't done (null: all done). */
export const nextStep = (s: Step[]) => s.find((x) => x.state != "done") ?? null;

/**
 * The GitHub App's manifest (GitHub makes the app from it in one click): sign-in only, no permissions, every target's
 * callback. Null while the address isn't known (AWS with a short name, before the stack).
 */
export function githubManifest(a: Answers, f: Pick<Facts, "stack">, redirect: string): Record<string, unknown> | null {
  const app = addressOf(a, "production", f);
  if (!app || targetsOf(a).some((t) => !addressOf(a, t, f))) return null;
  return {
    name: `Erga ${a.host}`.slice(0, 34),
    url: `https://${app}`,
    redirect_url: redirect,
    callback_urls: targetsOf(a).map((t) => callbackOf(addressOf(a, t, f)!, "github")),
    description: `Sign-in for the Erga at https://${app}`,
    public: false,
    request_oauth_on_install: false,
    hook_attributes: { url: `https://${app}/`, active: false },
    default_permissions: {},
  };
}
