// The setup of a new instance, as one state machine (`bun erga setup <host> --host ... --deploys ...`). Pure: no
// network, no files.
//
//   login > (adopt) > (stop) > (app) > build > (update) > (deployer) > page > done
//
// page: the server runs, with no sign-in and no admin. The command opens the server's setup page in the user's browser
// (/setup, server/identity/setup.ts), and the user finishes there: GitHub or Google sign-in, the deployer's token (cloud
// deploys on Cloudflare), and their own sign-in, which makes them the admin. The command asks the user nothing itself.
//
// app: single sign-on on AWS only: the client secret of the organization's sign-in, before the build.
//
// adopt: an Erga runs at the address already, and this clone has no entry for it: another clone, or another machine,
// set it up. The command takes it over: it writes the entry from what Cloudflare holds of the instance, and goes on
// from where that instance is. It changes nothing of the instance.
//
// deployer: the answer --deploys and what the account has differ. cloud with no deployer: the command installs it.
// On AWS there is no token (the deployer's role is its credential), so the step is the command's own. On Cloudflare
// the user makes the deployer's token: on a new server they paste it on the setup page (the page step), and the
// command installs the deployer with it; on a server that has its admin, on a page that the command opens. local with
// a deployer: the command removes it. This step is open on an instance that is done too: a run again with the other
// answer changes it.
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

import { ANSWER_VARS, type Answers, emailOf, namesOf, pagesOf, pagesProblem, sso, stackOf, varsOf, zoneOf } from "./plan";

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
  /** The app step's secret is there: (single sign-on on AWS) the client's, in Parameter Store. */
  app: boolean;
  /** The server as its platform shows it: the release that serves, its health, and whether its settings are the answers' sign-in. */
  live: { version: string | null; healthy: boolean; signIn: "ok" | { bad: string } | null } | null;
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
  adopt: null,
  stack: null,
  app: false,
  live: null,
  held: [],
  admin: false,
  vars: null,
  github: "",
  deployer: false,
  terminal: false,
};

export type State =
  /** The command runs the host's login; the user finishes it in the browser. */
  | { at: "login"; why?: string }
  /** Only the user can go on: the command says why, and ends. */
  | { at: "stop"; why: string }
  /** The command writes the entry of the Erga that runs at the address, as `bun erga register` does: the instance stays as it is. */
  | { at: "adopt"; worker: string }
  /** The user's step before the build, with single sign-on on AWS: the client's secret. */
  | { at: "app"; kind: "oidc" }
  | { at: "build" }
  /**
   * The instance runs with no admin yet, but the answers give other settings than its entry's (a run again): setup
   * writes the entry and deploys again. An instance with an admin is what its entry says: `bun erga deploy` changes it.
   */
  | { at: "update"; vars: string[] }
  /**
   * The instance runs, and who deploys it is not what --deploys says. install: on Cloudflare the user's step, the
   * deployer's token (the instance has its admin: a new one takes the token on its setup page). remove: the command
   * removes the deployer.
   */
  | { at: "deployer"; do: "install" | "remove" }
  /**
   * The server runs with no admin: the user finishes on its setup page, which the command opens with a one-time link.
   * `token`: the page takes the deployer's token (cloud deploys on Cloudflare), and the command waits for it.
   */
  | { at: "page"; token: boolean }
  /** --remote: the next step is the user's, in their terminal, and this command has none. The user runs it in theirs. */
  | { at: "terminal" }
  | { at: "done" };

/** Each option that the answers still need, with what it is for. */
export function missing(a: Answers): string[] {
  const aws = a.where == "aws";
  const need: string[] = [];
  if (!a.where) need.push("--host cloudflare or --host aws: where Erga runs.");
  if (sso(a) && !aws && !a.team) need.push("--team <name>: the Cloudflare Zero Trust team, the part before .cloudflareaccess.com.");
  if (sso(a) && !aws && !a.aud) need.push("--aud <tag>: the Access application's Audience tag.");
  if (sso(a) && aws && !a.issuer) need.push("--issuer <URL>: the issuer URL of the organization's sign-in (OpenID Connect).");
  if (sso(a) && aws && !a.client) need.push("--client <ID>: Erga's client ID at the organization's sign-in.");
  if (a.emailClaim && !(sso(a) && aws)) need.push("--email-claim is only for --sign-in sso on AWS: leave it out.");
  if (a.signInDays && !(sso(a) && aws))
    need.push("--sign-in-days is only for --sign-in sso on AWS: leave it out. An admin sets it on the server's Settings page.");
  if (aws && !pagesOf(a)) need.push("--pages <domain>: a second Route 53 domain of the account, for the documents' pages.");
  if (a.where && !a.deploys)
    need.push("--deploys cloud or --deploys local: who deploys each new release: a deployer in your account, or you with bun erga deploy.");
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
  if (s.adopt) return { at: "adopt", worker: s.adopt };
  // Who deploys, against the answer: only for an instance that runs (the deployer binds its database).
  const deployer: State | null =
    a.deploys == "cloud" && !s.deployer
      ? { at: "deployer", do: "install" }
      : a.deploys == "local" && s.deployer
        ? { at: "deployer", do: "remove" }
        : null;
  if (s.admin) return deployer ?? { at: "done" };
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
  if (sso(a) && aws && !s.app) return { at: "app", kind: "oidc" };
  if (!(s.live?.healthy && s.live.version && s.live.signIn == "ok")) return { at: "build" };
  const changed = changedVars(a, s);
  if (changed.length) return { at: "update", vars: changed };
  // A new server on Cloudflare takes the deployer's token on its setup page: the install is a part of that step.
  const token = !aws && deployer?.do == "install";
  return deployer && !token ? deployer : { at: "page", token };
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
  // (The deployer's install is the user's step only where it has a token: on Cloudflare.)
  const theirs =
    state.at == "login" || state.at == "app" || state.at == "page" || (state.at == "deployer" && state.do == "install" && a.where != "aws");
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
 * Who deploys each new release, as the plan says it. `worker`: the instance's Worker, when it is not a new instance's
 * (an instance that runs has its entry's name: store.ts, namesAt). The user makes the token for that name. `where`:
 * where the user pastes it, when not on a new server's setup page.
 */
export const deploysText = (a: Answers, worker = namesOf(a.host).worker, where = "on the server's setup page") =>
  a.deploys == "cloud" && a.where == "aws"
    ? `• a deployer (the Lambda function ${stackOf(a)}-deployer, in a stack of its own) in your AWS account: it deploys each new release by itself. It holds no token: its role may only put a release in the instance's bucket, and run the instance's fixed script on its machine`
    : a.deploys == "cloud"
      ? `• a deployer (the Worker ${worker}-deployer) in your account: it deploys each new release by itself. It holds a token for the one Worker ${worker}, which you make on Cloudflare and paste ${where}`
      : `• no deployer: no credential stays in the cloud, and you deploy each new release with bun erga deploy ${a.host}`;

/** The plan, as the agent says it before the user's yes. */
export function planText(a: Answers, s: Seen): string[] {
  const email = emailOf(a);
  const signIn = sso(a)
    ? a.where == "aws"
      ? `• your organization's sign-in, at the gate in front of Erga (you type its client secret ${a.remote ? "in your terminal" : "on a page that opens"})${email ? `; the email address in ${email.claim}, after "${email.prefix}"` : ""}${a.signInDays ? `; a sign-in lasts ${a.signInDays} days` : ""}`
      : "• your organization's sign-in, with Cloudflare Access"
    : `• no sign-in yet: when the server runs, its setup page opens ${a.remote ? "from a link on your terminal" : "in your browser"}. You set up GitHub or Google sign-in there, and you sign in: you become the admin`;
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
