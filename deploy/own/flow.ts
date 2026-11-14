// The setup of a new instance, as one state machine (`bun erga setup <host>`). Pure: no network, no files.
//
//   where > connect > who > review > app > build > admin > done
//
// The state is where the setup is now: the first step that the answers (plan.ts) and what was observed (Seen) leave
// open. An event is a new answer, or a new observation. `step` gives the new state and one effect: what the owner
// does next. The owners are thin: the command (cli.ts) observes, runs the logins and the build, prints a question
// for the agent to ask, and waits on .erga/ for the person's step on the page; the page (page.ts, view.ts) draws the
// same state, and records what the person does there.
//
// One actor for each step. The person answers their agent (where, who, review); the person acts on a page (connect,
// app, admin); the agent's command works (build). Nothing is made before the yes of review.

import { type Answers, namesOf, pagesOf, pagesProblem, parseAnswer, planKey, sso, type Where, zoneOf } from "./plan";

/** What the command observed (facts.ts). The page reads it from .erga/setup.json: it never looks itself. */
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
  stack: { status: string | null; outputs: Record<string, string>; resources: string[]; applied: boolean } | null;
  /** The app step's secret is there: the GitHub App's, or (single sign-on on AWS) the client's in Secrets Manager. */
  app: boolean;
  /** The server as the world sees it: the commit it answers with, its health, and whether a browser gets to the sign-in. */
  live: { version: string | null; healthy: boolean; signIn: "ok" | { bad: string } | null } | null;
  /** The secrets the server holds already (their names). */
  held: string[];
  /** The person who claimed the server (its entry has their ops token), or "". */
  admin: string;
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
  admin: "",
};

export type At = "where" | "connect" | "who" | "review" | "app" | "build" | "admin" | "done";

export type State =
  | { at: "where" }
  /** login: the person signs in to the host. choose: two accounts (or profiles) fit. fix: the person decides (`why`). */
  | { at: "connect"; need: "login" | "choose" | "fix"; why?: string }
  | { at: "who"; need: "signIn" | "company" | "team" | "issuer" | "client" | "pages"; why?: string }
  | { at: "review" }
  | { at: "app"; kind: "github" | "access" | "oidc" }
  | { at: "build" }
  | { at: "admin" }
  | { at: "done" };

export interface Flow {
  answers: Answers;
  seen: Seen;
  state: State;
}

export type Event = { type: "set"; key: keyof Answers; value: string } | { type: "seen"; seen: Seen };

export type Effect =
  /** An answer changed what there is to see: observe, then send what was seen. */
  | { do: "look" }
  /** The agent asks the person these words, and runs the line of `answer` that fits. */
  | { do: "ask"; text: string[]; answer: string[] }
  /** The command runs the host's login; the person finishes it in the browser. */
  | { do: "login"; where: Where }
  /** The person's step on the setup page (or, for the admin, on the new server): the command waits for it. */
  | { do: "wait"; text: string }
  | { do: "build" }
  /** Only the person can go on: the command says why, and ends. */
  | { do: "stop"; text: string }
  | { do: "done" };

/** The answers that an answer decides: a new one makes them open again. */
const CLEARS: Partial<Record<keyof Answers, (keyof Answers)[]>> = {
  where: ["account", "profile", "region", "signIn", "company", "team", "aud", "issuer", "client", "pages"],
  profile: ["region"],
  signIn: ["company", "team", "aud", "issuer", "client", "pages"],
};

/** The first step that is still open. */
export function stateOf(a: Answers, s: Seen): State {
  if (!a.where) return { at: "where" };
  const aws = a.where == "aws";
  if (aws && !a.profile) return { at: "connect", need: "choose" };
  if (!s.login?.ok) return { at: "connect", need: "login", ...(s.login ? { why: s.login.why } : {}) };
  const domain = a.host.split(".").slice(-2).join(".");
  if (!aws && !a.account)
    return s.choices.length > 1
      ? { at: "connect", need: "choose" }
      : {
          at: "connect",
          need: "fix",
          why: `None of your Cloudflare accounts has the domain of ${a.host}. Add ${domain} to Cloudflare, or set up another address: bun erga setup <address>.`,
        };
  if (!zoneOf(a.host, s.zones))
    return {
      at: "connect",
      need: "fix",
      why: `${a.host} isn't on a ${aws ? "Route 53 hosted zone of this AWS account" : "domain of this Cloudflare account"} (${s.zones.join(", ") || "it has none"}). Add ${domain} there, or set up another address: bun erga setup <address>.`,
    };
  if (s.taken)
    return {
      at: "connect",
      need: "fix",
      why: `${a.host} is in use: ${s.taken}. Free it, or set up another address: bun erga setup <address>.`,
    };
  if (!a.signIn) return { at: "who", need: "signIn" };
  if (a.signIn == "company" && !a.company) return { at: "who", need: "company" };
  if (sso(a) && !aws && !a.team) return { at: "who", need: "team" };
  if (sso(a) && aws && !a.issuer) return { at: "who", need: "issuer" };
  if (sso(a) && aws && !a.client) return { at: "who", need: "client" };
  const pages = pagesProblem(a, s.zones);
  if (aws && (!pagesOf(a) || pages)) return { at: "who", need: "pages", ...(pages ? { why: pages } : {}) };
  if (a.confirm != planKey(a)) return { at: "review" };
  const kind = !sso(a) ? "github" : aws ? "oidc" : "access";
  if (kind == "access" ? !a.aud : !s.app) return { at: "app", kind };
  if (!(s.live?.healthy && s.live.version && s.live.signIn == "ok")) return { at: "build" };
  return s.admin ? { at: "done" } : { at: "admin" };
}

/** The new state after an event, and what its owner does next. `problem`: why an answer was not taken. */
export function step(f: Flow, e: Event): { flow: Flow; effect: Effect; problem?: string } {
  let { answers, seen } = f;
  if (e.type == "seen") {
    seen = e.seen;
    // Ask only what the code can't find: one account that holds the domain, one profile, the profile's region.
    const fill: Partial<Answers> = {};
    if (answers.where == "cloudflare" && seen.login?.ok && !answers.account && seen.choices.length == 1) fill.account = seen.choices[0].id;
    if (answers.where == "aws" && !answers.profile && seen.choices.length <= 1) fill.profile = seen.choices[0]?.id ?? "default";
    if (answers.where == "aws" && answers.profile && !answers.region) fill.region = seen.region || "us-east-1";
    if (Object.keys(fill).length) return { flow: { answers: { ...answers, ...fill }, seen, state: f.state }, effect: { do: "look" } };
  } else {
    const r = parseAnswer(e.key, e.value);
    if ("problem" in r) return { flow: f, effect: effectOf(f), problem: r.problem };
    if (e.key == "host") return { flow: f, effect: effectOf(f), problem: "The address is the command's: bun erga setup <address>." };
    if (e.key == "confirm") {
      if (f.state.at != "review") return { flow: f, effect: effectOf(f), problem: "There is no plan to say yes to yet." };
      answers = { ...answers, confirm: planKey(answers) };
    } else if (answers[e.key] != r.value) {
      answers = { ...answers, [e.key]: r.value, ...Object.fromEntries((CLEARS[e.key] ?? []).map((k) => [k, ""])) };
      // Another host: nothing that was seen is about it.
      if (e.key == "where" || e.key == "account" || e.key == "profile")
        return { flow: { answers, seen: nothingSeen, state: f.state }, effect: { do: "look" } };
    }
  }
  const flow = { answers, seen, state: stateOf(answers, seen) };
  return { flow, effect: effectOf(flow) };
}

const cmd = (a: Answers) => `bun erga setup ${a.host}`;
const hostName = (w: Where | "") => (w == "aws" ? "AWS" : "Cloudflare");
/** The name of the account that Erga goes into, for the person. */
export const accountName = ({ answers: a, seen: s }: Flow) =>
  a.where == "aws"
    ? s.account || s.choices.find((c) => c.id == a.profile)?.name || ""
    : (s.choices.find((c) => c.id == a.account)?.name ?? a.account);

/** What the state's owner does: the question's exact words, the wait, or the work. */
export function effectOf(f: Flow): Effect {
  const { answers: a, seen: s, state } = f;
  const set = (pair: string, note = "") => `${cmd(a)} set ${pair}${note ? `    (${note})` : ""}`;
  const aws = a.where == "aws";
  switch (state.at) {
    case "where":
      return {
        do: "ask",
        text: [
          "Where should Erga run?",
          "1. Cloudflare (recommended): the Workers Paid plan, $5 a month.",
          "2. AWS: in your own AWS account.",
        ],
        answer: [set("where=cloudflare", "1"), set("where=aws", "2")],
      };
    case "connect":
      if (state.need == "login") return { do: "login", where: a.where as Where };
      if (state.need == "fix") return { do: "stop", text: state.why! };
      return aws
        ? {
            do: "ask",
            text: [
              "Which AWS profile should hold Erga?",
              ...s.choices.map((c, i) => `${i + 1}. ${c.id}${c.name ? ` (account ${c.name})` : ""}`),
            ],
            answer: [set("profile=<the profile's name>")],
          }
        : {
            do: "ask",
            text: [
              `${zoneOf(a.host, s.zones) ?? a.host.split(".").slice(-2).join(".")} is on ${s.choices.length} of your Cloudflare accounts. Which one should hold Erga?`,
              ...s.choices.map((c, i) => `${i + 1}. ${c.name}`),
            ],
            answer: s.choices.map((c, i) => set(`account=${c.id}`, `${i + 1}`)),
          };
    case "who":
      switch (state.need) {
        case "signIn":
          return {
            do: "ask",
            text: [
              `Who may sign in to ${a.host}?`,
              "1. Only people you invite (recommended)",
              "2. Anyone in your company: a GitHub organization or an email domain",
              "3. Your company's single sign-on",
              "You can change this later in Settings.",
            ],
            answer: [set("signIn=invite", "1"), set("signIn=company", "2"), set("signIn=sso", "3")],
          };
        case "company":
          return {
            do: "ask",
            text: [
              "Which GitHub organization or email domain? For example acme-inc or acme.com.",
              "A GitHub organization's people may sign in with GitHub. An email domain's people may sign in after you turn on Google sign-in in Settings. Other people need an invitation.",
            ],
            answer: [set("company=<the organization or the domain>")],
          };
        case "team":
          return {
            do: "ask",
            text: ["What is your Cloudflare Zero Trust team name? It is the part before .cloudflareaccess.com."],
            answer: [set("team=<the team's name>")],
          };
        case "issuer":
          return {
            do: "ask",
            text: ["What is the issuer URL of your company's sign-in (OpenID Connect)? For example https://login.example.com."],
            answer: [set("issuer=<the URL>")],
          };
        case "client":
          return {
            do: "ask",
            text: [
              `What is Erga's client ID at your company's sign-in? The sign-in's admin makes a client for Erga, with the callback https://${a.host}/oauth2/idpresponse. You type the client's secret later, on the setup page only.`,
            ],
            answer: [set("client=<the client ID>")],
          };
        case "pages":
          return {
            do: "ask",
            text: [
              ...(state.why ? [state.why] : []),
              `Which second domain should hold the documents' pages? It must be a Route 53 zone of this account that is not the domain of ${a.host}: each document's page gets an address of its own there.`,
            ],
            answer: [set("pages=<the domain>")],
          };
      }
      break;
    case "review":
      return {
        do: "ask",
        text: [...planText(f), "Shall I make it?"],
        answer: [set("confirm=yes", "yes"), set("<key>=<value>", `a change: ${CHANGEABLE(a).join(", ")}`)],
      };
    case "app":
      return {
        do: "wait",
        text:
          state.kind == "github"
            ? "Your turn, on the setup page: click Create the GitHub App on GitHub, then click Create on GitHub. The app's secret goes to the page, never to me. I go on by myself after that."
            : state.kind == "access"
              ? "Your turn, on the setup page: add the application in Cloudflare Zero Trust, then paste its Audience tag and click Save. I go on by myself after that."
              : "Your turn, on the setup page: type the client secret of your company's sign-in, and click Save. It goes to AWS Secrets Manager, never to me. I go on by myself after that.",
      };
    case "build":
      return { do: "build" };
    case "admin":
      return {
        do: "wait",
        text: a.stagingOf
          ? `Erga is deployed. The last step is yours: on the setup page, click Open ${a.host} and approve, and approve there as an admin.`
          : `Erga is deployed. The last step is yours: on the setup page, click Open ${a.host} and sign in. That sign-in makes you the admin.`,
      };
    case "done":
      return { do: "done" };
  }
  return { do: "done" };
}

/** The answers a person can still change at the review. */
const CHANGEABLE = (a: Answers) => ["where", "signIn", ...(a.where == "aws" ? ["profile", "region", "egress", "pages"] : ["account"])];

/** The plan, as the agent says it before the person's yes. */
export function planText(f: Flow): string[] {
  const { answers: a } = f;
  const signIn = sso(a)
    ? a.where == "aws"
      ? "• your company's sign-in, at a load balancer in front (you type its client secret on the setup page)"
      : "• your company's sign-in, with Cloudflare Access (you add one application there)"
    : "• a GitHub App, for sign-in (you click one button)";
  if (a.where == "aws")
    return [
      `I will make Erga at ${a.host}, in your AWS account ${accountName(f)} (profile ${a.profile}, region ${a.region}), as one CloudFormation stack:`,
      a.egress.includes("/")
        ? "• your own network"
        : `• a new network, with a ${a.egress == "nat-gateway" ? "NAT gateway" : "small NAT machine"}`,
      "• one machine (t4g.small), with no public address",
      sso(a) ? "• an S3 bucket, a load balancer and its certificate" : "• an S3 bucket, 2 CloudFront distributions and the certificates",
      `• the documents' pages on ${pagesOf(a)}`,
      signIn,
      "AWS bills it by use. Each resource is on the setup page.",
    ];
  const n = namesOf(a.host);
  return [
    `I will make Erga at ${a.host}, in the Cloudflare account ${accountName(f)}${a.stagingOf ? `, as a staging instance of ${a.stagingOf} (a copy of its data, for admins only)` : ""}:`,
    `• a Worker (${n.worker}), a D1 database, an R2 bucket and a DNS record`,
    signIn,
    "It costs $5 a month: the Workers Paid plan. The plan is on the setup page too.",
  ];
}

// ------------------------------------------------------------------ the steps, for the page and the terminal

export interface StepView {
  id: Exclude<At, "done">;
  title: string;
  /** answer: the person answers their agent. you: the person acts on a page. agent: the command works. */
  who: "answer" | "you" | "agent";
  state: "done" | "now" | "blocked";
  /** One line: what was decided or made (done), or what the step is (now). */
  detail: string;
}

const ORDER: Exclude<At, "done">[] = ["where", "connect", "who", "review", "app", "build", "admin"];

/** The seven steps, with the one that is open now. `app`: the GitHub App's name, once made. */
export function stepsOf(f: Flow, app = ""): StepView[] {
  const { answers: a, seen: s, state } = f;
  const at = state.at == "done" ? ORDER.length : ORDER.indexOf(state.at);
  const aws = a.where == "aws";
  const who =
    a.signIn == "invite"
      ? "People you invite"
      : a.signIn == "company"
        ? `People of ${a.company || "your company"}`
        : `Single sign-on${aws ? (a.issuer ? `, ${a.issuer}` : "") : a.team ? `, team ${a.team}` : ""}`;
  const rows: Record<Exclude<At, "done">, [title: string, who: StepView["who"], done: string, now: string]> = {
    where: ["Where it runs", "answer", hostName(a.where), "Your agent asked this in your terminal. Answer it there: this page follows."],
    connect: [
      `Connect ${a.where ? hostName(a.where) : "your account"}`,
      "you",
      aws ? `Profile ${a.profile}, region ${a.region}` : `Account ${accountName(f)}`,
      state.at != "connect"
        ? ""
        : state.need == "fix"
          ? state.why!
          : state.need == "choose"
            ? `Your agent asked which ${aws ? "AWS profile" : "account"}. Answer it in your terminal.`
            : aws
              ? `An AWS sign-in tab is open. Sign in there. Then this page finds the Route 53 zone of ${a.host}.`
              : `A Cloudflare tab is open. Sign in there, then click Allow. Then this page finds the account that holds ${a.host}.`,
    ],
    who: [
      "Who signs in",
      "answer",
      who,
      state.at == "who" && state.need != "signIn"
        ? "Your agent asked one more question in your terminal. Answer it there."
        : "Your agent asked this in your terminal. You can change it later in Settings.",
    ],
    review: ["Review the plan", "answer", "You said yes", "Nothing is made yet. Answer your agent: yes, or the answer to change."],
    app: sso(a)
      ? [
          "Single sign-on",
          "you",
          aws ? "The client secret is in AWS Secrets Manager" : "The Audience tag is saved",
          `Your company's sign-in will guard ${a.host}.`,
        ]
      : ["GitHub App", "you", `The app ${app}`, `People sign in to ${a.host} with GitHub. Click the button, then click Create on GitHub.`],
    build: [
      "Build",
      "agent",
      `Live at https://${a.host}${s.live?.version ? `, release ${s.live.version}` : ""}`,
      "Your agent does this step. You have nothing to do.",
    ],
    admin: a.stagingOf
      ? [
          "Connect this page",
          "you",
          `${s.admin} approved`,
          `Open the link and approve as an admin of ${a.stagingOf}. This page then connects to the server for later deploys.`,
        ]
      : [
          "Become the admin",
          "you",
          `${s.admin} is the admin`,
          "Open the link and sign in. You become the first admin, and this page connects to the server for later deploys.",
        ],
  };
  return ORDER.map((id, i) => {
    const [title, w, done, now] = rows[id];
    return { id, title, who: w, state: i < at ? "done" : i == at ? "now" : "blocked", detail: i < at ? done : i == at ? now : "" };
  });
}

/** A part of the build, as the command's lines tell it: when it started, and how long it took (null: it runs). */
export interface Part {
  title: string;
  at: number;
  ms: number | null;
}

/**
 * The build's parts after one more line of its log. "<title>..." starts a part; "<title>: done" (or skipped, with a
 * detail after a comma) ends it. Every other line changes nothing.
 */
export function partsAfter(parts: Part[], line: string, now: number): Part[] {
  const started = /^([A-Z][^:]*?)\.\.\.$/.exec(line);
  if (started) return parts.some((p) => p.title == started[1]) ? parts : [...parts, { title: started[1], at: now, ms: null }];
  const ended = /^([A-Z][^:]*): (?:done|skipped)\b/.exec(line);
  return ended ? parts.map((p) => (p.title == ended[1] && p.ms == null ? { ...p, ms: now - p.at } : p)) : parts;
}

/** "3 of 7 steps done. Next: Review the plan (you, to your agent)." */
export function progress(steps: StepView[]): string {
  const now = steps.find((x) => x.state == "now");
  if (!now) return "Every step is done.";
  const who = now.who == "answer" ? "you, to your agent" : now.who == "you" ? "you" : "your agent";
  return `${steps.filter((x) => x.state == "done").length} of ${steps.length} steps done. Next: ${now.title} (${who}).`;
}
