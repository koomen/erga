// The setup of a new instance, as one state machine (`bun erga setup <host> --host ... --sign-in ...`). Pure: no
// network, no files.
//
//   login > (stop) > app > build > (update) > admin > done
//
// With --remote (answers.remote) the user is at another computer: their steps (login, app, admin) go through their terminal,
// never a browser on this machine. A command with no terminal (an agent's shell) stops there: "terminal".
//
// The answers are the command's options (plan.ts): the agent asked the user every question first (README, Setup),
// and `missing` says which option is still needed. The state is the first step that the answers and what the command
// observed (Seen) leave open. `step` folds an observation in: it fills what the code can find (the one account that
// holds the domain, the profile's region) and gives the state. The owner (cli.ts) observes, does the state's step, and
// observes again; a run again goes on from where the last one stopped. A dry run stops before the first step that
// makes something, and prints the plan.

import { ANSWER_VARS, type Answers, emailOf, namesOf, pagesOf, pagesProblem, sso, varsOf, zoneOf } from "./plan";

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
  /** AWS: the stack's status and outputs, and each resource of the template on disk ("Name (Type)"). */
  stack: { status: string | null; outputs: Record<string, string>; resources: string[] } | null;
  /** The app step's secret is there: the GitHub App's, or (single sign-on on AWS) the client's in Parameter Store. */
  app: boolean;
  /** The server as its platform shows it: the release that serves, its health, and whether its settings are the answers' sign-in. */
  live: { version: string | null; healthy: boolean; signIn: "ok" | { bad: string } | null } | null;
  /** The secrets the server holds already (their names). */
  held: string[];
  /** The server has an admin: its database has a user with that role (the platform's database API reads it). */
  admin: boolean;
  /** The plain settings of the instance's entry in .erga/config.json, or null: no entry yet. */
  vars: Record<string, string> | null;
  /** The GitHub App's client id that setup holds for the host, or "". */
  github: string;
  /** The user's terminal (/dev/tty) opens for this command: an agent's shell has none. */
  terminal: boolean;
}

export const nothingSeen: Seen = {
  login: null,
  choices: [],
  zones: [],
  account: "",
  region: "",
  subdomain: null,
  taken: null,
  stack: null,
  app: false,
  live: null,
  held: [],
  admin: false,
  vars: null,
  github: "",
  terminal: false,
};

export type State =
  /** The command runs the host's login; the user finishes it in the browser. */
  | { at: "login"; why?: string }
  /** Only the user can go on: the command says why, and ends. */
  | { at: "stop"; why: string }
  /** The user's step in the browser: the GitHub App, or (single sign-on on AWS) the client's secret. */
  | { at: "app"; kind: "github" | "oidc" }
  | { at: "build" }
  /**
   * The instance runs with no admin yet, but the answers give other settings than its entry's (a run again): setup
   * writes the entry and deploys again. An instance with an admin is what its entry says: `bun erga deploy` changes it.
   */
  | { at: "update"; vars: string[] }
  /** The user signs in to the new server with a one-time link: they become its admin. */
  | { at: "admin" }
  /** --remote: the next step is the user's, in their terminal, and this command has none. The user runs it in theirs. */
  | { at: "terminal" }
  | { at: "done" };

/** Each option that the answers still need, with what it is for. */
export function missing(a: Answers): string[] {
  const aws = a.where == "aws";
  const need: string[] = [];
  if (!a.where) need.push("--host cloudflare or --host aws: where Erga runs.");
  if (!a.signIn) need.push("--sign-in invite, organization or sso: who may sign in.");
  if (a.signIn == "organization" && !a.organization)
    need.push("--organization <GitHub organization or email domain>: whose users may sign in.");
  if (sso(a) && !aws && !a.team) need.push("--team <name>: the Cloudflare Zero Trust team, the part before .cloudflareaccess.com.");
  if (sso(a) && !aws && !a.aud) need.push("--aud <tag>: the Access application's Audience tag.");
  if (sso(a) && aws && !a.issuer) need.push("--issuer <URL>: the issuer URL of the organization's sign-in (OpenID Connect).");
  if (sso(a) && aws && !a.client) need.push("--client <ID>: Erga's client ID at the organization's sign-in.");
  if (a.emailClaim && !(sso(a) && aws)) need.push("--email-claim is only for --sign-in sso on AWS: leave it out.");
  if (a.signInDays && !(sso(a) && aws))
    need.push("--sign-in-days is only for --sign-in sso on AWS: leave it out. An admin sets it on the server's Settings page.");
  if (aws && !pagesOf(a)) need.push("--pages <domain>: a second Route 53 domain of the account, for the documents' pages.");
  return need;
}

/** What the code can find, so the user need not say it: the one account or profile that fits, the profile's region. */
function filled(a: Answers, s: Seen): Partial<Answers> {
  const fill: Partial<Answers> = {};
  if (a.where == "cloudflare" && s.login?.ok) {
    const named = a.account && s.choices.find((c) => c.id != a.account && c.name.toLowerCase() == a.account.toLowerCase());
    if (named) fill.account = named.id;
    else if (!a.account && s.choices.length == 1) fill.account = s.choices[0].id;
  }
  if (a.where == "aws" && !a.profile && s.choices.length <= 1) fill.profile = s.choices[0]?.id ?? "default";
  if (a.where == "aws" && a.profile && !a.region) fill.region = s.region || "us-east-1";
  return fill;
}

/** The first step that is still open. */
export function stateOf(a: Answers, s: Seen): State {
  const aws = a.where == "aws";
  const domain = a.host.split(".").slice(-2).join(".");
  const another = "or choose another address";
  if (aws && !a.profile)
    return { at: "stop", why: `Several AWS profiles: ${s.choices.map((c) => c.id).join(", ")}. Add --profile with one of them.` };
  if (!s.login?.ok) return { at: "login", ...(s.login ? { why: s.login.why } : {}) };
  if (s.admin) return { at: "done" };
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
  const kind = !sso(a) ? "github" : aws ? "oidc" : null;
  if (kind && !s.app) return { at: "app", kind };
  if (!(s.live?.healthy && s.live.version && s.live.signIn == "ok")) return { at: "build" };
  const changed = changedVars(a, s);
  if (changed.length) return { at: "update", vars: changed };
  return { at: "admin" };
}

/**
 * The settings that the answers give (plan.ts, varsOf) and the entry doesn't have: their names. A left-out option is
 * its default: the options of each run are the whole answer.
 */
export function changedVars(a: Answers, s: Seen): string[] {
  if (!s.vars) return [];
  const want: Record<string, string> = varsOf(a, s.github || undefined, s.stack?.outputs.Proxy);
  const had = s.vars;
  return ANSWER_VARS.filter((k) => (want[k] ?? "") != (had[k] ?? ""));
}

/** Folds what was seen in: the answers with what the code found, and the state. `look`: an answer changed, so observe again. */
export function step(a: Answers, s: Seen): { answers: Answers; state: State; look: boolean } {
  const fill = filled(a, s);
  const answers = { ...a, ...fill };
  const state = stateOf(answers, s);
  const theirs = state.at == "login" || state.at == "app" || state.at == "admin";
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

/** What the dry run checked, each as a line that passed. */
export function checksOf(a: Answers, s: Seen): string[] {
  const aws = a.where == "aws";
  return [
    aws ? `Signed in to AWS: account ${s.account}, region ${a.region}` : "Signed in to Cloudflare",
    aws ? `Route 53 holds ${zoneOf(a.host, s.zones)}` : `The account ${accountName(a, s)} holds ${zoneOf(a.host, s.zones)}`,
    `${a.host} is free`,
  ];
}

/** The plan, as the agent says it before the user's yes. */
export function planText(a: Answers, s: Seen): string[] {
  const email = emailOf(a);
  const signIn = sso(a)
    ? a.where == "aws"
      ? `• your organization's sign-in, at the gate in front of Erga (you type its client secret ${a.remote ? "in your terminal" : "on a page that opens"})${email ? `; the email address in ${email.claim}, after "${email.prefix}"` : ""}${a.signInDays ? `; a sign-in lasts ${a.signInDays} days` : ""}`
      : "• your organization's sign-in, with Cloudflare Access"
    : "• a GitHub App, for sign-in (you click one button)";
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
      "AWS bills it by use.",
    ];
  const n = namesOf(a.host);
  return [
    `I will make Erga at ${a.host}, in the Cloudflare account ${accountName(a, s)}:`,
    `• a Worker (${n.worker}), a D1 database, an R2 bucket and a DNS record`,
    signIn,
    tracks,
    "It costs $5 a month: the Workers Paid plan.",
  ];
}
