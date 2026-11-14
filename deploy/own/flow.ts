// The setup of a new instance, as one state machine (`bun erga setup <host> --host ... --sign-in ...`). Pure: no
// network, no files.
//
//   login > (stop) > app > build > admin > done
//
// The answers are the command's options (plan.ts): the agent asked the person every question first (README, Setup),
// and `missing` says which option is still needed. The state is the first step that the answers and what the command
// observed (Seen) leave open. `step` folds an observation in: it fills what the code can find (the one account that
// holds the domain, the profile's region) and gives the state. The owner (cli.ts) observes, does the state's step, and
// observes again; a run again goes on from where the last one stopped. A dry run stops before the first step that
// makes something, and prints the plan.

import { type Answers, namesOf, pagesOf, pagesProblem, sso, zoneOf } from "./plan";

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
  /** The app step's secret is there: the GitHub App's, or (single sign-on on AWS) the client's in Secrets Manager. */
  app: boolean;
  /** The server as the world sees it: the commit it answers with, its health, and whether a browser gets to the sign-in. */
  live: { version: string | null; healthy: boolean; signIn: "ok" | { bad: string } | null } | null;
  /** The secrets the server holds already (their names). */
  held: string[];
  /** The instance is registered: its entry has an ops token (an admin approved it). */
  admin: boolean;
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
};

export type State =
  /** The command runs the host's login; the person finishes it in the browser. */
  | { at: "login"; why?: string }
  /** Only the person can go on: the command says why, and ends. */
  | { at: "stop"; why: string }
  /** The person's step in the browser: the GitHub App, or (single sign-on on AWS) the client's secret. */
  | { at: "app"; kind: "github" | "oidc" }
  | { at: "build" }
  /** The person signs in to the new server with a one-time link: they become its admin, and approve the ops token. */
  | { at: "admin" }
  | { at: "done" };

/** Each option that the answers still need, with what it is for. */
export function missing(a: Answers): string[] {
  const aws = a.where == "aws";
  const need: string[] = [];
  if (!a.where) need.push("--host cloudflare or --host aws: where Erga runs.");
  if (!a.signIn) need.push("--sign-in invite, company or sso: who may sign in.");
  if (a.signIn == "company" && !a.company) need.push("--company <GitHub organization or email domain>: whose people may sign in.");
  if (sso(a) && !aws && !a.team) need.push("--team <name>: the Cloudflare Zero Trust team, the part before .cloudflareaccess.com.");
  if (sso(a) && !aws && !a.aud) need.push("--aud <tag>: the Access application's Audience tag.");
  if (sso(a) && aws && !a.issuer) need.push("--issuer <URL>: the issuer URL of the company's sign-in (OpenID Connect).");
  if (sso(a) && aws && !a.client) need.push("--client <ID>: Erga's client ID at the company's sign-in.");
  if (aws && !pagesOf(a)) need.push("--pages <domain>: a second Route 53 domain of the account, for the documents' pages.");
  if (aws && a.staging) need.push("Staging is not on AWS yet: leave out --staging.");
  if (a.staging && a.staging == a.host) need.push("--staging needs an address of its own.");
  return need;
}

/** What the code can find, so the person need not say it: the one account or profile that fits, the profile's region. */
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
  return { at: "admin" };
}

/** Folds what was seen in: the answers with what the code found, and the state. `look`: an answer changed, so observe again. */
export function step(a: Answers, s: Seen): { answers: Answers; state: State; look: boolean } {
  const fill = filled(a, s);
  const answers = { ...a, ...fill };
  return { answers, state: stateOf(answers, s), look: Object.keys(fill).length > 0 };
}

/** The answers of the staging instance of `a`: on its primary's account, with its sign-in. */
export const stagingOf = (a: Answers): Answers => ({
  ...a,
  host: a.staging,
  stagingOf: a.host,
  staging: "",
});

/** The name of the account that Erga goes into, for the person. */
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

/** The plan, as the agent says it before the person's yes. */
export function planText(a: Answers, s: Seen): string[] {
  const signIn = sso(a)
    ? a.where == "aws"
      ? "• your company's sign-in, at a load balancer in front (you type its client secret on a page that opens)"
      : "• your company's sign-in, with Cloudflare Access"
    : a.stagingOf
      ? `• sign-in with the GitHub App of ${a.stagingOf}`
      : "• a GitHub App, for sign-in (you click one button)";
  if (a.where == "aws")
    return [
      `I will make Erga at ${a.host}, in your AWS account ${accountName(a, s)} (profile ${a.profile}, region ${a.region}), as one CloudFormation stack:`,
      a.egress.includes("/")
        ? "• your own network"
        : `• a new network, with a ${a.egress == "nat-gateway" ? "NAT gateway" : "small NAT machine"}`,
      "• one machine (t4g.small), with no public address",
      sso(a) ? "• an S3 bucket, a load balancer and its certificate" : "• an S3 bucket, 2 CloudFront distributions and the certificates",
      `• the documents' pages on ${pagesOf(a)}`,
      signIn,
      "AWS bills it by use.",
    ];
  const n = namesOf(a.host);
  return [
    a.stagingOf
      ? `I will make its staging instance at ${a.host}, in the same account: a copy of ${a.stagingOf}'s data, for admins only:`
      : `I will make Erga at ${a.host}, in the Cloudflare account ${accountName(a, s)}:`,
    `• a Worker (${n.worker}), a D1 database, an R2 bucket and a DNS record`,
    signIn,
    a.stagingOf ? "It is in the same Workers Paid plan." : "It costs $5 a month: the Workers Paid plan.",
  ];
}
