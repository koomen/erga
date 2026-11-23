// The setup of a new instance, as one state machine (`bun erga setup <host> --host ... --deploys ...`). Pure: no
// network, no files.
//
//   login > (adopt) > (stop) > (app) > build > (update) > (old-pages) > (deployer) > page > done
//
// An instance that has an admin already is what it is, with its accounts and its documents: there a left-out option
// changes nothing, and each given option applies, or the command stops and says why. No answer is ignored:
//
//   login > (adopt) > (stop) > (app) > (keep) > (move) > (keep) > (old-pages) > (deployer) > done
//
// move: the answers change the instance's sign-in (to the organization's single sign-on, or to another setting of
// it), or the documents' pages (from the shared workers.dev address to a domain): the command writes the change into
// the entry and deploys the tracked branch's head. keep: with single sign-on, a person is another identity than the
// one that made their account, so each account keeps its person by their address at the organization's sign-in
// (--keep <username>=<address>; an account whose sign-in before verified one address keeps it by that one). The
// command writes a row for each into the instance's database (first.ts, writeKeeps), before the move when the release
// that runs knows such rows, else after it. old-pages: the pages moved to a domain, and the Worker of the shared
// address is still in the account: the command deletes it.
//
// page: the server runs, with no sign-in and no admin. The command opens the server's setup page in the user's browser
// (/setup, server/identity/setup.ts), and the user finishes there: GitHub or Google sign-in, the deployer's token (cloud
// deploys on Cloudflare), and their own sign-in, which makes them the admin. The command asks the user nothing itself,
// and waits for nothing: it ends when the page is open.
//
// app: single sign-on at an issuer only: the client secret of the organization's sign-in, before the build.
//
// adopt: an Erga runs at the address already, and this clone has no entry for it: another clone, or another machine,
// set it up. The command takes it over: it writes the entry from what Cloudflare holds of the instance, and goes on
// from where that instance is. It changes nothing of the instance.
//
// deployer: the answer --deploys and what the account has differ. cloud with no deployer: the command installs it,
// with no step of the user's. On AWS the deployer's role is its credential. On Cloudflare the deployer is a second
// Worker, installed with no token, and the instance's Worker binds it (a deploy of the instance again): the user
// pastes the token on the server itself (its setup page; with an admin, its Deploy page), which hands it to the
// deployer. local with a deployer: the command removes it. This step is open on an instance that is done too: a run
// again with the other answer changes it.
//
// With --remote (answers.remote) the user is at another computer: their steps (login, app, page) go through their terminal,
// never a browser on this machine. A command with no terminal (an agent's shell) stops there: "terminal".
//
// The answers are the command's options (plan.ts): the agent asked the user every question first (README, Setup),
// and `missing` says which option is still needed. The state is the first step that the answers and what the command
// observed (Seen) leave open. `step` folds an observation in: it fills what the code can find (the one account that
// holds the domain, the profile's region) and gives the state. The owner (cli.ts) observes, does the state's step, and
// observes again; a run again goes on from where the last one stopped. A dry run stops before the first step that
// makes something, and prints the plan.

import { ACCESS_OPEN } from "../../gate/core.ts";
import type { AutoMode } from "../deployer/tags";
import {
  ANSWER_VARS,
  type Answers,
  defaultsOf,
  type Endpoints,
  type Keep,
  namesOf,
  pagesOf,
  pagesProblem,
  sso,
  ssoAnswers,
  stackOf,
  type TextAnswer,
  varsOf,
  viaAccess,
  zoneOf,
} from "./plan";

/** An account of an instance that runs, as setup reads it in the instance's database (first.ts, accountsOf). */
export interface Account {
  login: string;
  admin: boolean;
  /** It signs in with the organization's single sign-on already. */
  sso: boolean;
  /** The addresses that its sign-ins before verified (Google's sign-in gives one; GitHub's gives none). */
  emails: string[];
  /** The address of the row that keeps the account for its person, when setup wrote one. */
  keeps: string | null;
}

/** What the command observed (facts.ts; deploy/aws/setup.ts on AWS). */
export interface Seen {
  /** The login of the host's CLI (cf, or aws with the profile): null before the first look. */
  login: { ok: true } | { ok: false; why: string } | null;
  /** Cloudflare: each account that holds the host's domain. AWS: each profile of the AWS CLI (name: its account, if the profile says). */
  choices: { id: string; name: string }[];
  /** The chosen account's domains (AWS: its Route 53 zones), and on AWS the account's id and the profile's region. */
  zones: string[];
  account: string;
  region: string;
  /** Cloudflare: the account's workers.dev subdomain. */
  subdomain: string | null;
  /** Why the address can't be this instance's (a DNS record, another Worker), or null. */
  taken: string | null;
  /** Cloudflare: the Worker of an Erga that runs at the address, which this clone has no entry for; else null. */
  adopt: string | null;
  /** AWS: the stack's status and outputs, and each resource of the template on disk ("Name (Type)"). */
  stack: { status: string | null; outputs: Record<string, string>; resources: string[] } | null;
  /** The app step's secret is there: (single sign-on with an issuer) the client's: on AWS in Parameter Store. */
  app: boolean;
  /** Single sign-on on Cloudflare with an issuer: its endpoints, as it publishes them; or why they are not known. Null: not asked. */
  oidc: Endpoints | { why: string } | null;
  /**
   * The server as its platform shows it: the release that serves, its health, and whether its settings are the answers'
   * sign-in. `sso` and `pages`: the single sign-on setting ("": none) and the documents' pages ("shared", or their
   * domain) that the release itself runs with, when the look read them: an entry that a run changed and did not deploy
   * differs from them.
   */
  live: { version: string | null; healthy: boolean; signIn: "ok" | { bad: string } | null; sso?: string; pages?: string | null } | null;
  /** The secrets the server holds already (their names). */
  held: string[];
  /** The server has an admin: its database has a user with that role (the platform's database API reads it). */
  admin: boolean;
  /** The plain settings of the instance's entry in .erga/config.json, or null: no entry yet. */
  vars: Record<string, string> | null;
  /** The client id of the GitHub app that the instance's entry names (an instance from before the setup page), or "". */
  github: string;
  /** The account has the instance's deployer, which deploys each new release by itself: on Cloudflare a Worker, on AWS a Lambda function. */
  deployer: boolean;
  /** Cloudflare: the instance's Worker binds its deployer (DEPLOYER), so the server can hand it the user's token. */
  bound: boolean;
  /** The user's terminal (/dev/tty) opens for this command: an agent's shell has none. */
  terminal: boolean;
  /** The instance's entry: where the documents' pages are ("shared", or their domain), and what it tracks. Null: no entry yet. */
  pages: string | null;
  tracks: { repo: string; branch: string } | null;
  /** Cloudflare: the account of the instance's entry, or "". */
  entryAccount: string;
  /** Cloudflare, an instance with an admin: its accounts; null: not read. */
  accounts: Account[] | null;
  /** The database of the release that runs can keep an account for its person (its people table has `login`). */
  keepable: boolean;
  /** Cloudflare: the Worker of the shared pages address (<worker>-pages) is in the account. */
  pagesWorker: boolean;
}

export const nothingSeen: Seen = {
  login: null,
  choices: [],
  zones: [],
  account: "",
  region: "",
  subdomain: null,
  taken: null,
  adopt: null,
  stack: null,
  app: false,
  oidc: null,
  live: null,
  held: [],
  admin: false,
  vars: null,
  github: "",
  deployer: false,
  bound: false,
  terminal: false,
  pages: null,
  tracks: null,
  entryAccount: "",
  accounts: null,
  keepable: false,
  pagesWorker: false,
};

export type State =
  /** The command runs the host's login; the user finishes it in the browser. */
  | { at: "login"; why?: string }
  /** Only the user can go on: the command says why, and ends. */
  | { at: "stop"; why: string }
  /** The command writes the entry of the Erga that runs at the address, as `bun erga register` does: the instance stays as it is. */
  | { at: "adopt"; worker: string }
  /** The user's step before the build, with single sign-on at an issuer: the client's secret. */
  | { at: "app"; kind: "oidc" }
  | { at: "build" }
  /**
   * The instance runs with no admin yet, but the answers give other settings than its entry's (a run again), other
   * pages (`pages`: their domain), or another branch to track (`tracks`): setup writes the entry and deploys again.
   * An instance with an admin changes by `move`.
   */
  | { at: "update"; vars: string[]; pages?: string; tracks?: true }
  /**
   * The instance runs, with an admin, and the answers change its sign-in settings (`vars`) or move the documents'
   * pages to a domain (`pages`): setup writes the change into the entry and deploys the tracked branch's head. Its
   * accounts and its documents stay.
   */
  | { at: "move"; vars: string[]; pages: string | null }
  /** With single sign-on: the rows that keep each account for its person, by their address there. */
  | { at: "keep"; rows: Keep[] }
  /** The pages are on a domain now: the Worker of the shared pages address goes. */
  | { at: "old-pages" }
  /** The instance runs, and who deploys it is not what --deploys says: the command installs the deployer, or removes it. */
  | { at: "deployer"; do: "install" | "remove" }
  /** The server runs with no admin: the user finishes on its setup page, which the command opens with a one-time link. */
  | { at: "page" }
  /** --remote: the next step is the user's, in their terminal, and this command has none. The user runs it in theirs. */
  | { at: "terminal" }
  | { at: "done" };

/** Each answer's option, as the user types it. */
export const OPTION_NAMES: Record<TextAnswer, string> = {
  host: "<host>",
  where: "--host",
  signIn: "--sign-in",
  repo: "--repo",
  branch: "--branch",
  account: "--account",
  profile: "--profile",
  region: "(the profile's region)",
  team: "--team",
  aud: "--aud",
  issuer: "--issuer",
  client: "--client",
  signInDays: "--sign-in-days",
  pages: "--pages",
  egress: "--egress",
  deploys: "--deploys",
  auto: "--auto-deploy",
};

/**
 * What a person does in Cloudflare Zero Trust before single sign-on with Cloudflare Access, in its order: the
 * application's Audience tag is there only when the application is in front of the address.
 */
export const accessSteps = (host: string) =>
  `in Cloudflare Zero Trust, in this order: 1. Add a self-hosted Access application for ${host}, with the policy that lets your people in. It may go in front of a server that runs: people pass Access first, then sign in as before. 2. Add a second Access application for these paths of ${host}, with one policy (Bypass, Everyone): ${ACCESS_OPEN.join(", ")}. They carry no Access sign-in (agents use them), and Erga checks its own tokens there. 3. Copy the Audience tag (AUD) of the first application: it is --aud. The team's name, the part before .cloudflareaccess.com, is --team.`;

/** Each option that the answers still need, with what it is for. */
export function missing(a: Answers): string[] {
  const aws = a.where == "aws";
  const need: string[] = [];
  if (!a.where) need.push("--host cloudflare or --host aws: where Erga runs.");
  // Single sign-on on Cloudflare: Cloudflare Access in front (the team and the application's tag), or an issuer.
  const access = viaAccess(a),
    issuer = sso(a) && (aws || !!(a.issuer || a.client));
  if (sso(a) && !aws && !access && !issuer)
    need.push(
      "--team <name> and --aud <tag>: the Cloudflare Zero Trust team and the Access application's Audience tag (Cloudflare Access signs people in); or --issuer <URL> and --client <ID>: the organization's own sign-in (OpenID Connect)."
    );
  if (access && issuer)
    need.push("--team and --aud (Cloudflare Access), or --issuer and --client (the organization's own sign-in): not both.");
  if (access && !issuer && !a.team) need.push("--team <name>: the Cloudflare Zero Trust team, the part before .cloudflareaccess.com.");
  if (access && !issuer && !a.aud) need.push("--aud <tag>: the Access application's Audience tag.");
  // The tag is there only when the application is: the order of the person's steps, for the agent to say.
  if (sso(a) && !aws && !issuer && !(a.team && a.aud)) need.push(`For --team and --aud: ${accessSteps(a.host)}`);
  if (issuer && !access && !a.issuer) need.push("--issuer <URL>: the issuer URL of the organization's sign-in (OpenID Connect).");
  if (issuer && !access && !a.client) need.push("--client <ID>: Erga's client ID at the organization's sign-in.");
  if (a.signInDays && !(sso(a) && aws))
    need.push("--sign-in-days is only for --sign-in sso on AWS: leave it out. An admin sets it on the server's Settings page.");
  if (aws && !pagesOf(a)) need.push("--pages <domain>: a second Route 53 domain of the account, for the documents' pages.");
  if (sso(a) && !aws && !pagesOf(a))
    need.push("--pages <domain>: a second domain of the Cloudflare account, for the documents' pages (with single sign-on they need one).");
  // An option that does nothing with the other answers stops the command: it is never left out silently.
  const given = (k: TextAnswer) => a.given.includes(k);
  const idle = (keys: TextAnswer[], why: string) => {
    const names = keys.filter(given).map((k) => OPTION_NAMES[k]);
    if (names.length)
      need.push(`${names.join(", ")} ${names.length > 1 ? "go" : "goes"} ${why}: leave ${names.length > 1 ? "them" : "it"} out.`);
  };
  if (!sso(a)) idle(["team", "aud", "issuer", "client"], "with --sign-in sso only");
  if (aws) idle(["account", "team", "aud"], "with --host cloudflare only");
  if (a.where == "cloudflare") idle(["profile", "egress"], "with --host aws only");
  if (a.keep.length && aws) need.push("--keep goes with --host cloudflare only: leave it out.");
  if (a.where && !a.deploys)
    need.push("--deploys cloud or --deploys local: who deploys each new release: a deployer in your account, or you with bun erga deploy.");
  if (a.auto && a.deploys == "local")
    need.push(
      "--auto-deploy goes with --deploys cloud only: leave it out. (bun erga track <host> --auto-deploy sets the mode of an instance that deploys from a machine.)"
    );
  return need;
}

/** The options of the sign-in: a run that gives one of them gives the sign-in whole. */
const SIGN_IN_KEYS: TextAnswer[] = ["signIn", "team", "aud", "issuer", "client"];
const signInGiven = (a: Answers) => SIGN_IN_KEYS.some((k) => a.given.includes(k));

/** What the code can find, so the user need not say it: the one account or profile that fits, the profile's region. */
function filled(a: Answers, s: Seen): Partial<Answers> {
  const fill: Partial<Answers> = {};
  if (a.where == "cloudflare" && s.login?.ok) {
    const named = a.account && s.choices.find((c) => c.id != a.account && c.name.toLowerCase() == a.account.toLowerCase());
    if (named) fill.account = named.id;
    else if (!a.account && s.choices.length == 1) fill.account = s.choices[0].id;
  }
  // An instance with an admin is what it is: an option that the run left out is as the instance's entry has it.
  if (a.where == "cloudflare" && s.admin && s.vars) {
    const was: Partial<Answers> = {
      ...(signInGiven(a) ? {} : ssoAnswers(s.vars.SSO)),
      ...(!a.given.includes("pages") && s.pages ? { pages: s.pages } : {}),
      ...(!a.given.includes("account") && s.entryAccount ? { account: s.entryAccount } : {}),
    };
    for (const [k, v] of Object.entries(was) as [TextAnswer, string][]) if (a[k] != v) (fill as Record<string, string>)[k] = v;
  }
  if (a.where == "aws" && !a.profile && s.choices.length <= 1) fill.profile = s.choices[0]?.id ?? "default";
  if (a.where == "aws" && a.profile && !a.region) fill.region = s.region || "us-east-1";
  return fill;
}

/** A list of names for a line of text: the first ones, and how many more. */
const names = (all: string[], most = 12) => `${all.slice(0, most).join(", ")}${all.length > most ? `, and ${all.length - most} more` : ""}`;

/**
 * With single sign-on on an instance that has accounts: how each account keeps its person (`by`), the rows that the
 * database still lacks for it (`rows`), or why the answers can't be so (`problem`).
 *
 *   sso       the account signs in with the organization's sign-in already
 *   given     --keep names it, with its person's address
 *   kept      a row from a run before keeps it
 *   verified  its sign-in before verified one address (Google's), which no other account has: that address keeps it
 *   none      no address: nobody signs in to it, and it stays as it is, until a run gives its --keep
 */
export function keepsOf(
  a: Answers,
  s: Pick<Seen, "accounts">
): { rows: Keep[]; by: Record<string, "sso" | "given" | "kept" | "verified" | "none">; problem: string | null } {
  const accounts = s.accounts ?? [];
  const by: Record<string, "sso" | "given" | "kept" | "verified" | "none"> = {};
  const rows: Keep[] = [];
  const stop = (problem: string) => ({ rows: [], by: {}, problem });
  if (!sso(a) || a.where != "cloudflare" || !s.accounts) return { rows, by, problem: null };
  for (const [i, k] of a.keep.entries()) {
    const account = accounts.find((x) => x.login == k.login);
    if (!account)
      return stop(
        `${a.host} has no account ${k.login}${accounts.length ? `: its accounts are ${names(accounts.map((x) => x.login))}` : ""}. Give --keep an account's username.`
      );
    if (account.sso) return stop(`${k.login} signs in with the organization's sign-in already: leave its --keep out.`);
    const twice = a.keep.find((x, j) => j < i && (x.login == k.login || x.email == k.email));
    if (twice)
      return stop(
        twice.login == k.login
          ? `--keep names ${k.login} 2 times: an account keeps one person.`
          : `--keep gives ${k.email} to ${twice.login} and to ${k.login}: one address is one person's.`
      );
  }
  const given = new Set(a.keep.map((k) => k.email));
  for (const x of accounts) {
    const keep = a.keep.find((k) => k.login == x.login);
    const [email] = x.emails;
    if (x.sso) by[x.login] = "sso";
    else if (keep) {
      by[x.login] = "given";
      if (x.keeps != keep.email) rows.push(keep);
    } else if (x.keeps && !given.has(x.keeps)) by[x.login] = "kept";
    else if (
      x.emails.length == 1 &&
      !given.has(email) &&
      !accounts.some((y) => y != x && (y.keeps == email || (!y.sso && y.emails.includes(email))))
    ) {
      by[x.login] = "verified";
      rows.push({ login: x.login, email });
    } else by[x.login] = "none";
  }
  return { rows, by, problem: null };
}

/**
 * What the answers change in the entry of an instance that runs: its plain settings (changedVars; with an admin, only
 * with a change of the single sign-on), the documents' pages, and (only when the run gave --repo or --branch) what it
 * tracks.
 */
export function changeOf(a: Answers, s: Seen): { vars: string[]; pages: { from: string; to: string } | null; tracks: boolean } {
  const to = pagesOf(a);
  const vars = changedVars(a, s);
  return {
    // With an admin, the settings follow the sign-in only: an entry from before a setting (a registered instance's)
    // differs from the answers in it, and that is no change that the user chose.
    // And with no option of the sign-in in the run, the sign-in is as it is: its setting as text is no answer.
    // Another setting of a single sign-on that it has changes that setting alone.
    vars: !s.admin ? vars : !(signInGiven(a) && vars.includes("SSO")) ? [] : s.vars?.SSO ? ["SSO"] : vars,
    pages: s.pages && to && s.pages != to ? { from: s.pages, to } : null,
    tracks:
      !!s.tracks && ((a.given.includes("repo") && a.repo != s.tracks.repo) || (a.given.includes("branch") && a.branch != s.tracks.branch)),
  };
}

/** Why the account can't take the instance as the answers name it, or null: the account, the address, the pages' domain, the issuer. */
function blocked(a: Answers, s: Seen): State | null {
  const aws = a.where == "aws";
  const domain = a.host.split(".").slice(-2).join(".");
  const another = "or choose another address";
  if (!aws && !s.choices.some((c) => c.id == a.account))
    return {
      at: "stop",
      why:
        s.choices.length > 1
          ? `${domain} is on ${s.choices.length} of your Cloudflare accounts: ${s.choices.map((c) => c.name).join(", ")}. Add --account with one of them.`
          : s.choices.length
            ? `${domain} is on the Cloudflare account ${s.choices[0].name}, not on ${a.account}.`
            : `None of your Cloudflare accounts has ${domain}. Add ${domain} to Cloudflare, ${another}.`,
    };
  if (!zoneOf(a.host, s.zones))
    return {
      at: "stop",
      why: `${a.host} isn't on a ${aws ? "Route 53 hosted zone of this AWS account" : "domain of this Cloudflare account"} (${s.zones.join(", ") || "it has none"}). Add ${domain} there, ${another}.`,
    };
  if (s.taken) return { at: "stop", why: `${a.host} is in use: ${s.taken}. Free it, ${another}.` };
  const pages = pagesProblem(a, s.zones);
  if (pages) return { at: "stop", why: `${pages} Give another --pages.` };
  // (An instance with an admin, and no option of the sign-in in the run: its issuer is no answer of this run.)
  if (s.oidc && "why" in s.oidc && !(s.admin && !signInGiven(a))) return { at: "stop", why: `${s.oidc.why} Give another --issuer.` };
  return null;
}

/** The pages can't go where the answers say: setup moves them one way only. */
const pagesStop = (a: Answers, from: string): State => ({
  at: "stop",
  why: `The documents' pages of ${a.host} are on ${from}. Setup moves the pages only from the shared workers.dev address to a domain: give --pages ${from}, as it is.`,
});

/**
 * The Worker of the shared pages address, when the Worker is still in the account, and the release that runs has the
 * pages on their domain, healthy. Never from the entry alone: a deploy that did not end leaves the pages on that Worker.
 */
const oldPages = (_a: Answers, s: Seen): State | null =>
  !!s.pages && s.pages != "shared" && s.pagesWorker && !!s.live?.healthy && s.live.pages == s.pages ? { at: "old-pages" } : null;

/**
 * What the release that runs lacks of the instance's entry: a run wrote the entry and its deploy did not end (or a
 * person changed the entry). Its single sign-on setting, and where the documents' pages are.
 */
function behind(s: Seen): { sso: boolean; pages: boolean } {
  const live = s.live?.version ? s.live : null;
  return {
    sso: live?.sso != undefined && !!s.vars && live.sso != (s.vars.SSO ?? ""),
    pages: live?.pages != undefined && live.pages != null && !!s.pages && live.pages != s.pages,
  };
}

/**
 * Who deploys, against the answer: the deployer's step, or null. Only for an instance that runs (the deployer binds
 * its database). On Cloudflare the deployer is whole when the instance's Worker binds it too.
 */
export function deployerOf(a: Answers, s: Seen): Extract<State, { at: "deployer" }> | null {
  const aws = a.where == "aws";
  const whole = s.deployer && (aws || s.bound);
  const some = s.deployer || (!aws && s.bound);
  return a.deploys == "cloud" && !whole
    ? { at: "deployer", do: "install" }
    : a.deploys == "local" && some
      ? { at: "deployer", do: "remove" }
      : null;
}

/** The first step that is still open. */
export function stateOf(a: Answers, s: Seen): State {
  const aws = a.where == "aws";
  if (aws && !a.profile)
    return { at: "stop", why: `Several AWS profiles: ${s.choices.map((c) => c.id).join(", ")}. Add --profile with one of them.` };
  if (!s.login?.ok) return { at: "login", ...(s.login ? { why: s.login.why } : {}) };
  if (s.adopt) return { at: "adopt", worker: s.adopt };
  const deployer = deployerOf(a, s);
  // On AWS, each run brings the stacks of an instance that is done to the answers' template (cli.ts, done).
  if (s.admin && aws) return deployer ?? { at: "done" };
  if (s.admin) return withAdmin(a, s, deployer);
  const stop = blocked(a, s);
  if (stop) return stop;
  if (a.keep.length)
    return { at: "stop", why: `${a.host} has no admin yet, so it has no account that keeps its person: leave --keep out.` };
  if (sso(a) && !viaAccess(a) && !s.app) return { at: "app", kind: "oidc" };
  // (And the release has the entry's pages: an update that did not end deploys again.)
  if (!(s.live?.healthy && s.live.version && s.live.signIn == "ok") || behind(s).pages) return { at: "build" };
  const change = changeOf(a, s);
  if (change.pages && change.pages.from != "shared") return pagesStop(a, change.pages.from);
  if (change.vars.length || change.pages || change.tracks)
    return {
      at: "update",
      vars: change.vars,
      ...(change.pages ? { pages: change.pages.to } : {}),
      ...(change.tracks ? { tracks: true as const } : {}),
    };
  return oldPages(a, s) ?? deployer ?? { at: "page" };
}

/**
 * An instance on Cloudflare with an admin: each given option applies, or the command stops and says why (the top of
 * this file). `deployer`: the deployer's step, if --deploys and the account differ.
 */
function withAdmin(a: Answers, s: Seen, deployer: State | null): State {
  const change = changeOf(a, s);
  if (change.tracks)
    return {
      at: "stop",
      why: `${a.host} tracks ${s.tracks!.branch} of ${s.tracks!.repo}, and it has an admin: setup does not change what it tracks. Leave --repo and --branch out; bun erga track ${a.host} changes them.`,
    };
  if (s.entryAccount && a.account != s.entryAccount)
    return { at: "stop", why: `${a.host} is in the Cloudflare account ${s.entryAccount}, as its entry says: leave --account out.` };
  if (a.keep.length && !sso(a))
    return {
      at: "stop",
      why: `--keep goes with single sign-on, where an account keeps its person by their address, and ${a.host} signs people in with GitHub or Google: leave --keep out, or give --sign-in sso with its options.`,
    };
  const keeps = keepsOf(a, s);
  if (keeps.problem) return { at: "stop", why: keeps.problem };
  const keep: State | null = keeps.rows.length ? { at: "keep", rows: keeps.rows } : null;
  if (!change.vars.length && !change.pages) {
    // The entry has a change that the release lacks: a move that did not end. The same options again end it.
    const lacks = behind(s);
    if (lacks.sso || lacks.pages) {
      const what = [
        ...(lacks.sso ? ["the single sign-on setting"] : []),
        ...(lacks.pages ? [`the documents' pages (${s.pages})`] : []),
      ].join(" and ");
      if ((lacks.sso && !signInGiven(a)) || (lacks.pages && !a.given.includes("pages")))
        return {
          at: "stop",
          why: `This clone's entry of ${a.host} has ${what}, and the release that runs does not: a run of setup did not end, or the entry changed by hand. Run setup again with the options of that change (it deploys the entry), or deploy the entry as it is: bun erga deploy ${a.host} --write-spec.`,
        };
      const stop = blocked(a, s);
      return stop ?? { at: "move", vars: lacks.sso ? ["SSO"] : [], pages: lacks.pages ? s.pages : null };
    }
    if (keep && !s.keepable)
      return {
        at: "stop",
        why: `The release that ${a.host} runs can't keep an account for its person yet (its database has no place for it). Deploy a newer release first (bun erga deploy ${a.host}), then run this again.`,
      };
    return keep ?? oldPages(a, s) ?? deployer ?? { at: "done" };
  }
  const stop = blocked(a, s);
  if (stop) return stop;
  if (change.pages && change.pages.from != "shared") return pagesStop(a, change.pages.from);
  // From one organization's sign-in to another's: each account is known by the first one's id for its person, and
  // --keep is for an account that has none. Another application of the same team, or another client, keeps the ids.
  if (change.vars.includes("SSO") && s.vars?.SSO) {
    const was = ssoAnswers(s.vars.SSO);
    if ((was.team ?? "") != (viaAccess(a) ? a.team : "") || (was.issuer ?? "") != (viaAccess(a) ? "" : a.issuer))
      return {
        at: "stop",
        why: `${a.host} signs people in at ${was.team ? `the Cloudflare Zero Trust team ${was.team}` : was.issuer}, and each account is known by its person's id there. Setup does not move it to another organization's sign-in: the accounts would have no person. It changes the Access application (--aud) of the same team, or the client (--client) of the same issuer.`,
      };
  }
  // To single sign-on, from the sign-in that made the accounts: an admin must keep their account, or nobody is one.
  if (change.vars.includes("SSO") && !s.vars?.SSO) {
    const admins = (s.accounts ?? []).filter((x) => x.admin);
    if (!admins.some((x) => keeps.by[x.login] != "none"))
      return {
        at: "stop",
        why: `With single sign-on, a person takes their account by their email address at the organization's sign-in, and Erga has no address for an admin of ${a.host} (GitHub's sign-in gives none). Without one, nobody is its admin after the move. Add --keep <username>=<address> for an admin${admins.length ? ` (${names(admins.map((x) => x.login))})` : ""}, and for each other account that its person keeps.`,
      };
  }
  if (sso(a) && !viaAccess(a) && !s.app) return { at: "app", kind: "oidc" };
  // The rows first, where the release that runs knows them: then no sign-in comes between the move and its rows.
  if (keep && s.keepable) return keep;
  return { at: "move", vars: change.vars, pages: change.pages?.to ?? null };
}

/**
 * The settings that the answers give (plan.ts, varsOf) and the entry doesn't have: their names. A left-out option is
 * its default: the options of each run are the whole answer.
 */
export function changedVars(a: Answers, s: Seen): string[] {
  if (!s.vars) return [];
  const want: Record<string, string> = varsOf(a, s.github || undefined, s.oidc && "authorize" in s.oidc ? s.oidc : null);
  const had = s.vars;
  return ANSWER_VARS.filter((k) => (want[k] ?? "") != (had[k] ?? ""));
}

/** Folds what was seen in: the answers with what the code found, and the state. `look`: an answer changed, so observe again. */
export function step(a: Answers, s: Seen): { answers: Answers; state: State; look: boolean } {
  const fill = filled(a, s);
  const answers = { ...a, ...fill };
  const state = stateOf(answers, s);
  const theirs = state.at == "login" || state.at == "app" || state.at == "page";
  return {
    answers,
    state: theirs && answers.remote && !s.terminal ? { at: "terminal" } : state,
    look: Object.keys(fill).length > 0,
  };
}

/** The name of the account that Erga goes into, for the user. */
export const accountName = (a: Answers, s: Seen) =>
  a.where == "aws"
    ? s.account || s.choices.find((c) => c.id == a.profile)?.name || ""
    : (s.choices.find((c) => c.id == a.account)?.name ?? a.account);

/** What the dry run checked, each as a line that passed. An address that this instance has already is not "free": the plan says that it runs. */
export function checksOf(a: Answers, s: Seen): string[] {
  const aws = a.where == "aws";
  return [
    aws ? `Signed in to AWS: account ${s.account}, region ${a.region}` : "Signed in to Cloudflare",
    aws ? `Route 53 holds ${zoneOf(a.host, s.zones)}` : `The account ${accountName(a, s)} holds ${zoneOf(a.host, s.zones)}`,
    ...(s.live?.version ? [] : [`${a.host} is free`]),
  ];
}

/**
 * What the deployer deploys by itself, as the plan says it: the mode that the user chose (--auto-deploy). With none,
 * an instance that `runs` keeps the mode that it has (setup changes no mode that it did not get), and a new one
 * gets releases.
 */
const autoPlan = (a: Answers, runs: boolean) =>
  a.auto == "off"
    ? "it deploys only when an admin asks, on the server's Deploy page (auto-deploy is off, as you chose)"
    : a.auto == "commits"
      ? "it deploys each new commit by itself"
      : a.auto == "releases" || !runs
        ? "it deploys each new release by itself"
        : "it deploys by itself what the server's auto-deploy mode says. I do not change that mode (a server with no mode yet gets releases: each new release); --auto-deploy off|releases|commits sets another";

/** What the deployer does in a mode, as the command's last lines say it. */
export const autoText = (mode: AutoMode, branch: string) =>
  mode == "off"
    ? "deploys only when an admin asks, on the server's Deploy page (auto-deploy is off)"
    : `deploys each new ${mode == "releases" ? "tagged release (vX.Y.Z) of the repository" : `commit of ${branch}`} by itself`;

/**
 * Who deploys each new release, as the plan says it. `worker`: the instance's Worker, when it is not a new instance's
 * (an instance that runs has its entry's name: store.ts, namesAt). The user makes the token for that name. `where`:
 * the server's page where the user pastes it, when not a new server's setup page. `runs`: the instance runs already.
 */
export const deploysText = (a: Answers, worker = namesOf(a.host).worker, where = "its setup page", runs = false) =>
  a.deploys == "cloud" && a.where == "aws"
    ? `• a deployer (the Lambda function ${stackOf(a)}-deployer, in a stack of its own) in your AWS account: ${autoPlan(a, runs)}. It holds no token: its role may only put a release in the instance's bucket, and run the instance's fixed script on its machine`
    : a.deploys == "cloud"
      ? `• a deployer (the Worker ${worker}-deployer) in your account: ${autoPlan(a, runs)}. It needs a token for two Workers only (${worker} and ${worker}-deployer), which you make on Cloudflare and paste on the server: on ${where}`
      : `• no deployer: no credential stays in the cloud, and you deploy each new release with bun erga deploy ${a.host}`;

/**
 * What setup says of a deployer from before the deployer kept its own token (its token was a secret of its Worker):
 * setup replaces it, and the token goes with it. `will`: the dry run's plan. `where`: the page for the new token.
 * (The auto-deploy mode is not the deployer's: it stays, in the instance's database.)
 */
export const oldDeployerText = (host: string, where: string, will = false) =>
  `${will ? "Its deployer is from before the deployer kept its own token: I will replace it with a new one" : `The deployer of ${host} was from before the deployer kept its own token: it is replaced by a new one`}. The old deployer's token is not kept: the new deployer holds no token, and nothing deploys by itself until the user pastes a token on ${where}.`;

/** How the gate's single sign-on reads, in a line of a plan. */
const ssoText = (a: Answers) =>
  viaAccess(a)
    ? `your organization's sign-in, with Cloudflare Access in front of ${a.host} (the team ${a.team})`
    : `your organization's sign-in, at ${a.issuer}`;

/**
 * The accounts of an instance that moves to single sign-on, as the plan and the run's last lines say them: who keeps
 * each. No address is in the text: only usernames.
 */
export function accountsText(a: Answers, s: Pick<Seen, "accounts">, again: string): string[] {
  const { by } = keepsOf(a, s);
  const of = (how: string) => (s.accounts ?? []).filter((x) => by[x.login] == how).map((x) => `${x.login}${x.admin ? " (an admin)" : ""}`);
  const [has, given, kept, verified, none] = ["sso", "given", "kept", "verified", "none"].map(of);
  return [
    ...(given.length ? [`by the address that you gave (--keep): ${names(given)}`] : []),
    ...(kept.length ? [`by the address that a run before gave: ${names(kept)}`] : []),
    ...(verified.length ? [`by the address that Google verified at their sign-in before: ${names(verified)}`] : []),
    ...(has.length ? [`with the organization's sign-in already: ${names(has)}`] : []),
    ...(none.length
      ? [
          `with no address: ${names(none)}. Erga has none for them (GitHub's sign-in gives none). Each stays, with its documents, and nobody signs in to it until a run gives its person's address: ${again} --keep <username>=<address>`,
        ]
      : []),
  ];
}

/**
 * The plan for an instance that runs with an admin, where the answers change it (stateOf: move, keep, old-pages):
 * each change, and what stays. `worker`: the instance's Worker. `again`: the command, for the lines that name it.
 */
export function moveText(a: Answers, s: Seen, o: { worker: string; again: string }): string[] {
  const change = changeOf(a, s);
  const had = !!s.vars?.SSO;
  const lines = [`${a.host} runs, with an admin. I will change it as you chose. Its accounts and its documents stay:`];
  if (change.vars.includes("SSO"))
    lines.push(
      `• sign-in: from ${had ? "another setting of the organization's sign-in" : "GitHub or Google sign-in"} to ${ssoText(a)}. ${
        viaAccess(a)
          ? "After the deploy, Erga takes only a request with Access's proof for the application with your Audience tag"
          : "After the deploy, Erga's gate, inside its Worker, lets in only who signs in there"
      }${had ? "" : ". GitHub and Google sign-in stop"}`,
      ...(viaAccess(a)
        ? [
            `• before I deploy, the Access application must be in front of ${a.host}: with none, or with a wrong Audience tag, nobody comes in until a run again with the right one. The steps, ${accessSteps(a.host)}`,
          ]
        : [])
    );
  if (change.pages)
    lines.push(
      `• the documents' pages: from the shared workers.dev address to ${change.pages.to}, each document on a subdomain of its own. A document keeps its address on ${a.host}. I delete the Worker of the old address (${o.worker}-pages): that address answers no more, and a page that is open there must be loaded again`
    );
  else if (oldPages(a, s))
    lines.push(`• I delete the Worker of the old pages address (${o.worker}-pages): the pages are on ${s.pages} now`);
  if (change.vars.includes("SERVER_DEFAULTS")) {
    const to = defaultsOf(a);
    lines.push(
      `• the settings' defaults: Anyone's level becomes "${to.anyone_access}", and sharing with anyone with the link is ${to.public_sharing ? "on" : "off"}. A setting that an admin set on the server stays as it is`
    );
  }
  const accounts = sso(a) && s.accounts?.length ? accountsText(a, s, o.again) : [];
  if (accounts.length)
    lines.push(
      `• its ${s.accounts!.length} accounts: with single sign-on a person is known by their email address there. Each person takes their account at their first sign-in:`,
      ...accounts.map((l) => `  - ${l}`)
    );
  if (change.vars.includes("SSO") && !had)
    lines.push(
      "• who may come in stays as the server's Access page says (/admin/access): a person of your organization who has no account comes in only when an admin adds them there, or sets Anyone's level"
    );
  if (change.vars.length || change.pages)
    lines.push(`• I write the change into this clone's entry of ${a.host}, and deploy the newest commit of the branch that it tracks`);
  return lines;
}

/** The plan, as the agent says it before the user's yes. */
export function planText(a: Answers, s: Seen): string[] {
  const secret = `you type its client secret ${a.remote ? "in your terminal" : "on a page that opens"}`;
  const opens = `its setup page opens ${a.remote ? "from a link on your terminal" : "in your browser"}`;
  const signIn = !sso(a)
    ? `• no sign-in yet: when the server runs, ${opens}. You set up GitHub or Google sign-in there, and you sign in: you become the admin`
    : `${
        a.where == "aws"
          ? `• your organization's sign-in, at the gate in front of Erga (${secret})${a.signInDays ? `; a sign-in lasts ${a.signInDays} days` : ""}`
          : viaAccess(a)
            ? `• your organization's sign-in, with Cloudflare Access in front of ${a.host} (the team ${a.team}): Erga takes only a request with Access's proof for your application. You need a second Access application for these paths of ${a.host}, with one policy (Bypass, everyone): ${ACCESS_OPEN.join(", ")}. They carry no Access sign-in, and Erga checks its own tokens there`
            : `• your organization's sign-in, at ${a.issuer} (${secret}): Erga's gate, inside its Worker, lets in only who signs in there. Nothing else is in front of the Worker`
      }. When the server runs, ${opens}: you sign in with your organization's sign-in, and you become the admin`;
  const tracks = `• it tracks ${a.branch} of ${a.repo}: a deploy gives it that branch's newest commit`;
  if (a.where == "aws")
    return [
      `I will make Erga at ${a.host}, in your AWS account ${accountName(a, s)} (profile ${a.profile}, region ${a.region}), as one CloudFormation stack:`,
      a.egress.includes("/")
        ? "• your own network"
        : `• a new network, with a ${a.egress == "nat-gateway" ? "NAT gateway" : "small NAT machine"}`,
      "• one machine (t4g.small), with no public address",
      sso(a)
        ? "• an S3 bucket, 2 CloudFront distributions with the gate's functions, and the certificates"
        : "• an S3 bucket, 2 CloudFront distributions and the certificates",
      `• the documents' pages on ${pagesOf(a)}`,
      signIn,
      tracks,
      deploysText(a),
      "AWS bills it by use.",
    ];
  const n = namesOf(a.host);
  return [
    `I will make Erga at ${a.host}, in the Cloudflare account ${accountName(a, s)}:`,
    `• a Worker (${n.worker}), a D1 database, an R2 bucket and a DNS record`,
    pagesOf(a) == "shared"
      ? "• the documents' pages on one shared workers.dev address: safe for one author"
      : `• the documents' pages on ${pagesOf(a)}: each document on a subdomain of its own`,
    signIn,
    tracks,
    deploysText(a),
    "It costs $5 a month: the Workers Paid plan.",
  ];
}
