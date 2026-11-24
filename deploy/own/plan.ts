// A new Erga instance (`bun erga setup <host> --host ... --deploys ...`): the user's answers, which the agent asked
// first and gives as the command's options, and what follows from them alone: the instance's names, its entry in
// .erga/config.json, its plain settings, its database's first rows. Pure: no network, no files. The flow (what the
// command does next) is deploy/own/flow.ts. How people sign in is no answer: the user sets it up on the new server's
// setup page (server/identity/setup.ts). Single sign-on alone is the deploy's (--sign-in sso): the gate (gate/).

import { type CloudflareEntry, DEFAULT_BRANCH, DEFAULT_REPO, repoName } from "../cli/config";
import { type Target, targetFacts } from "../pipeline/pipeline";
import { CALLBACK, SIGN_IN_DAYS_MAX } from "../../gate/core.ts";

export type Where = "cloudflare" | "aws";
/** Who deploys each new release: a deployer in the user's own account, or the user from a machine. */
export type Deploys = "cloud" | "local";

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
  /** --sign-in sso: the organization's single sign-on, at the gate. "": the OAuth providers that the user sets up on the setup page. */
  signIn: "sso" | "";
  /** sso on Cloudflare, with Cloudflare Access in front: the Zero Trust team's name, and the Access application's audience tag. */
  team: string;
  aud: string;
  /** sso with an OIDC issuer (AWS; on Cloudflare, in place of Access): the organization's issuer's URL, and Erga's client ID there. */
  issuer: string;
  client: string;
  /** sso on AWS: how many days a sign-in at the gate lasts ("": the gate's 30). Elsewhere, an admin sets it on /admin/settings. */
  signInDays: string;
  /** Documents' pages: "shared", or a domain. "": the default (pagesOf). */
  pages: string;
  /**
   * --deploys: who deploys each new release. cloud: a deployer in the user's own account, by itself (it holds a token
   * for the instance's Worker and its own). local: the user, with `bun erga deploy`: no credential stays in the cloud.
   */
  deploys: Deploys | "";
  /**
   * --auto-deploy, with deploys cloud: what the deployer deploys by itself: off, releases (each tagged release) or
   * commits (each commit). "": an instance that runs keeps the mode that it has, and a new one gets releases.
   */
  auto: "off" | "releases" | "commits" | "";
  /** --remote (or $SSH_CONNECTION): the user is at another computer. Their steps go through their terminal, never a browser here. */
  remote: boolean;
  /**
   * --keep <username>=<address> (it can repeat), with single sign-on on an instance that has accounts already: the
   * person with that address at the organization's sign-in keeps that account, and its documents (flow.ts, keepsOf).
   */
  keep: Keep[];
  /**
   * The answers that the command line gave, by key. A new instance takes a left-out option as its default. An instance
   * with an admin is what it is: there a left-out option changes nothing, and only a given one does (flow.ts, filled).
   */
  given: TextAnswer[];
}

/** An account that keeps its person across the move to single sign-on: its username, and the person's address there. */
export interface Keep {
  login: string;
  email: string;
}

/** The answers that an option gives as text. */
export type TextAnswer = Exclude<keyof Answers, "remote" | "keep" | "given">;

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
  team: "",
  aud: "",
  issuer: "",
  client: "",
  signInDays: "",
  pages: "",
  deploys: "",
  auto: "",
  remote: false,
  keep: [],
  given: [],
});

export const sso = (a: Pick<Answers, "signIn">) => a.signIn == "sso";

/** Single sign-on on Cloudflare with Cloudflare Access in front (--team, --aud); else an OIDC issuer signs people in (--issuer, --client). */
export const viaAccess = (a: Pick<Answers, "signIn" | "where" | "team" | "aud">) => sso(a) && a.where != "aws" && !!(a.team || a.aud);

/**
 * Where documents' pages run. Cloudflare: one shared workers.dev address (safe for one author), or a second domain of
 * the account, where each document has a subdomain of its own (for many authors). With single sign-on there, the
 * domain ("": not answered): the gate has no way to guard the shared address. AWS: a domain. With single sign-on it
 * is pages.<host>: the gate in front guards both, with the user's sign-on. Without it, the pages need a whole zone
 * that isn't the app's (a page's script must not share the app's site), so the user names one.
 */
export const pagesOf = (a: Answers): string => a.pages || (a.where != "aws" ? (sso(a) ? "" : "shared") : sso(a) ? `pages.${a.host}` : "");

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
      return is(low == "sso", low, "--sign-in takes sso only. Without it, you set up GitHub or Google sign-in on the server's setup page.");
    case "deploys":
      return is(low == "cloud" || low == "local", low, "deploys is cloud or local.");
    case "auto":
      return is(low == "off" || low == "releases" || low == "commits", low, "auto-deploy is off, releases or commits.");
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

/** Reads one --keep as the user gave it: <username>=<address>. */
export function parseKeep(raw: string): { value: Keep } | { problem: string } {
  const [login, email, ...more] = raw.trim().toLowerCase().split("=");
  return !more.length && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login ?? "") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? "")
    ? { value: { login, email } }
    : {
        problem: `"${raw}" isn't <username>=<address>: an account's username on the server, and its person's email address at the organization's sign-in.`,
      };
}

/**
 * The answers that a server's single sign-on setting gives (SSO, as ssoSetting writes it): of an instance that runs,
 * for the options that a run leaves out. A server with no setting has none.
 */
export function ssoAnswers(setting: string | undefined): Partial<Pick<Answers, "signIn" | "team" | "aud" | "issuer" | "client">> {
  try {
    const o = JSON.parse(setting || "null") as {
      access?: { team?: string; aud?: string };
      oidc?: { issuer?: string; client?: string };
    } | null;
    if (o?.access) return { signIn: "sso", team: o.access.team ?? "", aud: o.access.aud ?? "" };
    if (o?.oidc) return { signIn: "sso", issuer: o.oidc.issuer ?? "", client: o.oidc.client ?? "" };
  } catch {}
  return {};
}

/** The zone (of `zones`) that holds `host`: the longest one, or null. */
export const zoneOf = (host: string, zones: string[]): string | null =>
  zones.filter((z) => host == z || host.endsWith(`.${z}`)).sort((x, y) => y.length - x.length)[0] ?? null;

/** Why the pages' domain can't be `pages`, or null. `zones`: the account's domains (AWS: its Route 53 zones). */
export function pagesProblem(a: Answers, zones: string[]): string | null {
  const pages = pagesOf(a);
  const other = "The documents' pages need another domain than the app's: a page's script must not share the app's site.";
  if (!pages) return null;
  if (a.where != "aws")
    return pages == "shared"
      ? sso(a)
        ? "With single sign-on the documents' pages need a domain."
        : null
      : !zones.includes(pages)
        ? `${pages} isn't a domain of this Cloudflare account: the pages need a whole domain of their own.`
        : zoneOf(a.host, zones) == pages
          ? other
          : null;
  if (pages == "shared") return "On AWS the documents' pages need a domain.";
  if (sso(a))
    return !zoneOf(pages, zones)
      ? `${pages} isn't on a Route 53 zone of this account.`
      : pages == a.host || a.host.endsWith(`.${pages}`)
        ? "The documents' pages need a name of their own: not the app's, and not one above it."
        : null;
  if (!zones.includes(pages)) return `${pages} isn't a Route 53 zone of this account: the pages need a whole zone of their own.`;
  return zoneOf(a.host, zones) == pages ? other : null;
}

/**
 * The settings' defaults of a new server (SERVER_DEFAULTS): an admin can change each on its admin page (/admin).
 * Only users that the admin invites sign in (/admin/access); they share with anyone with the link: Anyone may view
 * public documents, and the switch is on. With single sign-on, nobody outside the organization sees a document, but
 * the one that an admin publishes to a custom domain (gate/core.ts, Config.sites).
 */
export const defaultsOf = (a: Pick<Answers, "signIn">) => ({
  anyone_access: sso(a) ? "none" : "public",
  public_sharing: !sso(a),
  delete_docs_after_hours: null,
});

/** The endpoints of an OIDC issuer, as it publishes them (deploy/aws/setup.ts, discoverOidc). */
export interface Endpoints {
  authorize: string;
  token: string;
}

/**
 * Single sign-on on Cloudflare: the server's setting for the gate inside its Worker (SSO: gate/sso.ts); null without
 * it, and on AWS (there the gate is in front, and its values are in its own code: deploy/aws/gate.ts). `oidc`: the
 * issuer's endpoints; an issuer whose endpoints aren't known yet gives none, and that server does not come up.
 */
export function ssoSetting(a: Answers, oidc?: Endpoints | null): string | null {
  if (!sso(a) || a.where == "aws") return null;
  if (viaAccess(a)) return JSON.stringify({ access: { team: a.team, aud: a.aud } });
  return JSON.stringify({ oidc: { issuer: a.issuer, authorize: oidc?.authorize ?? "", token: oidc?.token ?? "", client: a.client } });
}

/** The names of the plain settings that varsOf gives: what the answers decide in an entry. */
export const ANSWER_VARS = ["GITHUB_CLIENT_ID", "SSO", "SERVER_DEFAULTS"];

/**
 * The instance's plain settings: the gate's single sign-on on Cloudflare (SSO), and the settings' defaults. `github`:
 * the client id of a GitHub app that the deploy itself gives the server (an instance from before the setup page; the
 * verify suite). Setup gives none: the user makes the app on the server's setup page, and the server keeps it.
 */
export function varsOf(a: Answers, github: string | undefined, oidc?: Endpoints | null): Record<string, string> {
  const setting = ssoSetting(a, oidc);
  return {
    GITHUB_CLIENT_ID: sso(a) ? "" : (github ?? ""),
    ...(setting == null ? {} : { SSO: setting }),
    SERVER_DEFAULTS: JSON.stringify(defaultsOf(a)),
  };
}

/**
 * The entry of an instance that runs, with what the answers change in it and nothing more (flow.ts, changeOf):
 * `change.pages`, the documents' pages on their domain; `change.vars`, the answers' plain settings by name. Everything
 * else of the entry stays: its names, what it tracks, its upstream, its custom domains, each other setting, and each
 * default of SERVER_DEFAULTS that is not the sign-in's (the sign-in decides Anyone's level and the public sharing).
 */
export function movedEntry(
  had: CloudflareEntry,
  a: Answers,
  change: { vars: readonly string[]; pages: string | null },
  o: { github?: string; oidc?: Endpoints | null } = {}
): CloudflareEntry {
  const want: Record<string, string> = varsOf(a, o.github, o.oidc);
  const vars: Record<string, string> = { ...had.vars };
  for (const k of change.vars) {
    if (k != "SERVER_DEFAULTS") vars[k] = want[k] ?? "";
    else {
      let was: Record<string, unknown> = {};
      try {
        was = JSON.parse(had.vars.SERVER_DEFAULTS || "{}") as Record<string, unknown>;
      } catch {}
      const { anyone_access, public_sharing } = defaultsOf(a);
      vars[k] = JSON.stringify({ ...JSON.parse(want[k]), ...was, anyone_access, public_sharing });
    }
  }
  if (!change.pages) return { ...had, vars };
  // The workers.dev subdomain is for a shared pages address, or a workers.dev app: an entry with neither names none.
  const { subdomain, ...rest } = had;
  return { ...(had.app.kind == "domain" ? rest : had), pages: { kind: "zone", zoneName: change.pages }, vars };
}

/** A row of a new server's database: who it lets write, its table, its values by column, what happens if it is there already. */
export interface FirstRow {
  who: string;
  table: string;
  row: Record<string, string | number>;
  /** After ON CONFLICT. */
  onConflict: string;
}

/**
 * The rows a new server's database gets with its first deploy, only while it has no admin (each host writes them in its
 * own way: first.ts, deploy/aws/setup.ts). With single sign-on, anyone who passes the gate may sign in and write:
 * Anyone's level (the setting anyone_access, server/directory/access.ts). Else none: only users that the admin invites
 * sign in. No admin: the user who finishes the server's setup page becomes it (server/identity/setup.ts).
 */
export function firstRows(a: Answers, now = Date.now()): FirstRow[] {
  if (sso(a))
    return [
      {
        who: "anyone",
        table: "server_config",
        row: { key: "anyone_access", value: '"write"', updated: now },
        onConflict: "(key) DO UPDATE SET value = excluded.value",
      },
    ];
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

export const callbackOf = (host: string) => `https://${host}${CALLBACK}`;

/**
 * The entry of `.erga/config.json` for a new instance on Cloudflare, from the answers alone: its names, its plain
 * settings, and the repository and the branch that it tracks (its first deploy takes that branch's head).
 */
export function setupEntry(
  a: Answers,
  o: { zones: string[]; subdomain: string | null; github?: string; oidc?: Endpoints | null }
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
    vars: varsOf(a, o.github, o.oidc),
    secrets: {},
  };
  return {
    host: a.host,
    repo: a.repo,
    branch: a.branch,
    ...targetFacts(target),
  };
}
