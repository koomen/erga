// Your own Erga: what the person decides, the names that follow from it, and the steps from a clone to a server
// that answers. Pure: no network, no files (deploy/own/facts.ts observes; deploy/own/cli.ts acts). `bun erga own skill` is the
// manual; `bun erga own status` prints these steps, and the local checklist page (deploy/own/page.ts) shows them.

import type { Target } from "../pipeline/pipeline";
import { ACCOUNT, PRODUCTION } from "../targets";

/** The person's decisions, asked all at once (`bun erga own ask`), with these defaults. No secret is ever in here. */
export interface Answers {
  /** The production address: a hostname on a zone in the account ("erga.example.com"). */
  host: string;
  /** A staging server too, at its own address (empty: none). */
  staging: string;
  /** Who may sign in with what: GitHub always (the first admin signs in with it); Google too if chosen. */
  providers: ("github" | "google")[];
  /** What the server is for: its settings' defaults (PRESETS). */
  preset: PresetName;
  /** The first admin's GitHub login. */
  admin: string;
  /** "company" only: a Google Workspace domain or GitHub organization whose people may sign in. */
  company: string;
  /** Documents' pages: "shared" (one workers.dev host) or a second zone of the account's, never the app's own. */
  pages: string;
}

export type PresetName = "website" | "company";

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

export const QUESTIONS: { key: keyof Answers; ask: string; help: string }[] = [
  {
    key: "host",
    ask: "Production address",
    help: "A name on a domain that is on your Cloudflare account, e.g. erga.example.com. Nothing may use it yet.",
  },
  {
    key: "staging",
    ask: "Staging server (address, or no)",
    help: "A second server for trying updates first, e.g. erga-staging.example.com. Default: no.",
  },
  { key: "providers", ask: "Sign-in", help: "github, or github,google. The first admin signs in with GitHub." },
  { key: "preset", ask: "Server preset", help: `website (${PRESETS.website.summary}) or company (${PRESETS.company.summary})` },
  { key: "admin", ask: "Admin (your GitHub login)", help: "You become the first admin." },
  {
    key: "company",
    ask: "Company domain or GitHub org (company preset only)",
    help: "e.g. example.com or my-org. Empty: only people an admin adds.",
  },
  {
    key: "pages",
    ask: "Documents' pages",
    help: "shared (one workers.dev address: no domain needed) or a second domain on your account (never the app's).",
  },
];

export const defaultAnswers = (admin = ""): Answers => ({
  host: "",
  staging: "",
  providers: ["github"],
  preset: "website",
  admin,
  company: "",
  pages: "shared",
});

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

/** Reads one answer as the person typed it: the value, or why it isn't one. */
export function parseAnswer(key: keyof Answers, raw: string): { value: Answers[keyof Answers] } | { problem: string } {
  const v = raw.trim();
  const off = /^(no|none|off|false|-)?$/i.test(v);
  switch (key) {
    case "host":
      return HOST.test(v.toLowerCase()) ? { value: v.toLowerCase() } : { problem: `"${v}" isn't a hostname like erga.example.com.` };
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
      return LOGIN.test(v) ? { value: v.toLowerCase() } : { problem: `"${v}" isn't a GitHub login.` };
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
  }
}

/** What's still wrong with the answers as a whole (each one on its own is parsed already); null if nothing. */
export function answersProblem(a: Answers, zones: string[]): string | null {
  if (!a.host) return "Answer the questions first (bun erga own ask).";
  if (!a.admin) return "Name the first admin: your GitHub login.";
  const zoneOf = (h: string) => zones.filter((z) => h == z || h.endsWith(`.${z}`)).sort((x, y) => y.length - x.length)[0] ?? null;
  for (const h of [a.host, a.staging].filter(Boolean))
    if (!zoneOf(h))
      return `${h} isn't on a domain of this Cloudflare account (${zones.join(", ") || "it has none"}). Add the domain to Cloudflare first, or pick a name on one of these.`;
  if (a.staging && a.staging == a.host) return "Staging needs an address of its own.";
  if (a.pages != "shared") {
    if (!zones.includes(a.pages)) return `${a.pages} isn't a domain of this account: pages need a whole zone of their own.`;
    if ([a.host, a.staging].some((h) => h && zoneOf(h) == a.pages))
      return "Documents' pages need a different domain from the app's: a page's scripts must not share the app's site.";
  }
  return null;
}

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
export const hostOf = (a: Answers, t: TargetName) => (t == "production" ? a.host : a.staging);
export const targetsOf = (a: Answers): TargetName[] => (a.staging ? ["production", "staging"] : ["production"]);
export const callbackOf = (host: string, provider: "github" | "google") => `https://${host}/auth/${provider}/callback`;

/** The bindings of a target that aren't secrets: the admins, the sign-in apps' ids, the preset. */
export function varsOf(a: Answers, ids: { github?: string; google?: string }): Record<string, string> {
  return {
    ADMINS: a.admin,
    GITHUB_CLIENT_ID: ids.github ?? "",
    ...(a.providers.includes("google") && ids.google ? { GOOGLE_CLIENT_ID: ids.google } : {}),
    SERVER_CONFIG: "{}",
    SERVER_DEFAULTS: JSON.stringify(PRESETS[a.preset].defaults),
    CLOUDFLARE_OAUTH_CLIENT_ID: "",
    DEPLOY_TARGET: "",
  };
}

/**
 * The pipeline's target for one of the person's servers: `bun erga own deploy` sends the secrets it has; a GitHub Actions
 * deploy (deploy/actions.ts) sends none, and the Worker keeps the ones it has (keepSecrets).
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
    // Erga's own erga.dev names stay out of reach, in Erga's own account.
    guard: { ...PRODUCTION, accountId: ACCOUNT },
  };
}

// ------------------------------------------------------------------ the steps

/** What the CLI observed (deploy/own/facts.ts): each field is a thing it looked at, or null if it couldn't look. */
export interface Facts {
  bun: string | null;
  /** The checkout's origin, and whether node_modules matches the lockfile. */
  origin: string | null;
  installed: boolean;
  /** Tracked files changed and not committed (a deploy builds a commit). */
  dirty: boolean;
  head: string | null;
  /** The cf CLI's login: its accounts, or why not. */
  login: { ok: true; accounts: { id: string; name: string }[] } | { ok: false; why: string };
  account: string | null;
  zones: string[];
  workersSubdomain: string | null;
  /** By target: what's there now. */
  targets: Partial<Record<TargetName, TargetFacts>>;
  /** Which secrets the secrets file holds (names only). */
  secrets: string[];
  /** The person's fork on GitHub, as gh sees it (deploy/own/facts.ts, githubFacts). Absent: not looked at. */
  github?: GitHubFacts;
}

/** The repository GitHub Actions deploys from: the person's fork of Erga, its variables, its secrets and its last run. */
export interface GitHubFacts {
  /** gh's login, or null: gh is missing or not logged in. */
  login: string | null;
  /** The checkout's origin on GitHub (owner/name), and the repository it is a fork of. */
  repo: string | null;
  parent: string | null;
  /** The Actions variables and the secrets' names (null: not readable). */
  variables: Record<string, string> | null;
  secrets: string[] | null;
  /** The last workflow run of a push to main. */
  run: { sha: string; status: string; conclusion: string; url: string } | null;
}

/** Erga's own repository on GitHub, which a person forks. */
export const UPSTREAM_REPO = "koomen/erga";

/**
 * The Actions variables that make the fork deploy the person's servers (deploy/actions-plan.ts reads them): the same
 * answers as .erga/own.json, and the account. Nothing secret.
 */
export function actionVars(a: Answers, ids: { github?: string; google?: string }, account: string): Record<string, string> {
  return {
    CLOUDFLARE_ACCOUNT_ID: account,
    ERGA_HOST: a.host,
    ...(a.staging ? { ERGA_STAGING: a.staging } : {}),
    ERGA_PROVIDERS: a.providers.join(","),
    ERGA_PRESET: a.preset,
    ERGA_ADMIN: a.admin,
    ...(a.company ? { ERGA_COMPANY: a.company } : {}),
    ERGA_PAGES: a.pages,
    ERGA_GITHUB_CLIENT_ID: ids.github ?? "",
    ...(a.providers.includes("google") && ids.google ? { ERGA_GOOGLE_CLIENT_ID: ids.google } : {}),
  };
}

/** The variables that are missing or different on GitHub. */
export const varsToSet = (want: Record<string, string>, have: Record<string, string> | null) =>
  Object.fromEntries(Object.entries(want).filter(([k, v]) => have?.[k] != v));

/** The permissions the Actions deploy's Cloudflare token needs, as Cloudflare's template link takes them. */
export const TOKEN_PERMISSIONS = [
  { key: "account_settings", type: "read" },
  { key: "workers_scripts", type: "edit" },
  { key: "d1", type: "edit" },
  { key: "workers_r2", type: "edit" },
  { key: "workers_routes", type: "edit" },
  { key: "zone", type: "read" },
  { key: "dns", type: "edit" },
];

/** Cloudflare's "Create API token" page, filled in with exactly what the deploy needs. */
export const tokenTemplateUrl = () =>
  `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(TOKEN_PERMISSIONS))}&accountId=*&zoneId=all&name=${encodeURIComponent("Erga deploy (GitHub Actions)")}`;

/** Why forking failed, in words, from gh's error. */
export function forkProblem(err: string): string {
  if (/auth login|not logged|authentication/i.test(err)) return "gh is not logged in. The person runs: gh auth login";
  if (/HTTP 404|Not Found|Could not resolve/i.test(err))
    return `GitHub did not find ${UPSTREAM_REPO}, or this login cannot read it. Check that gh is logged in as the person (gh auth status).`;
  return `gh repo fork failed: ${err.slice(0, 300)}`;
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
  /** The first admin has signed in (an identity is linked to their login). */
  adminIn: boolean | null;
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

/**
 * Every step, in order, with its state from what was observed. The first step that isn't done is the next one; each
 * says who does it (the agent, or the person) and exactly how.
 */
/** The secret is in the secrets file, or on a server's Worker already: a deploy keeps a secret it doesn't send. */
export const hasSecret = (f: Facts, key: string) =>
  f.secrets.includes(key) || Object.values(f.targets).some((t) => t?.held?.secrets.includes(key));

export function steps(a: Answers | null, f: Facts, o: { port?: number; ids: { github?: string; google?: string } }): Step[] {
  const out: Step[] = [];
  const page = o.port ? `http://localhost:${o.port}` : "the checklist page (bun erga own start)";
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
  add({
    id: "login",
    title: "Log in to Cloudflare",
    who: "person",
    ok: f.login.ok && !!f.account,
    detail: f.login.ok ? `${f.login.accounts.length} account(s)${f.account ? `; using ${f.account}` : ""}` : f.login.why,
    next: !f.login.ok
      ? "The agent runs `bunx cf auth login`: a browser opens; the person signs in to Cloudflare and clicks Allow."
      : "Several accounts: the agent asks which one, then runs: bun erga own set account=<id>",
  });
  const problem = a ? answersProblem(a, f.zones) : "Answer the questions first.";
  add({
    id: "decide",
    title: "The person's decisions",
    who: "person",
    ok: !problem,
    detail: a && !problem ? summary(a) : (problem ?? ""),
    next: `The agent asks all of them in one message (bun erga own ask shows them, with defaults), then records the answers with bun erga own set key=value ... The person can also answer on ${page}.`,
  });
  if (!a || problem) return out;
  const ghSecret = hasSecret(f, "GITHUB_CLIENT_SECRET");
  add({
    id: "github",
    title: "GitHub sign-in app",
    who: "person",
    ok: !!o.ids.github && ghSecret,
    detail: o.ids.github ? `client id ${o.ids.github}${ghSecret ? ", secret stored" : ", no secret yet"}` : "none yet",
    next: `On ${page}, the person clicks "Create the GitHub App", then "Create GitHub App" on GitHub. Erga stores its id and secret by itself. (Already have an app? bun erga own signin github --from-file <file with GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET>, and add the callback ${targetsOf(
      a
    )
      .map((t) => callbackOf(hostOf(a, t), "github"))
      .join(" and ")} to it.)`,
  });
  if (a.providers.includes("google"))
    add({
      id: "google",
      title: "Google sign-in client",
      who: "person",
      ok: !!o.ids.google && hasSecret(f, "GOOGLE_CLIENT_SECRET"),
      detail: o.ids.google ? `client id ${o.ids.google}` : "none yet",
      next: `The person makes an OAuth client at https://console.cloud.google.com/auth/clients/create (type: Web application; authorized redirect URI${a.staging ? "s" : ""}: ${targetsOf(
        a
      )
        .map((t) => callbackOf(hostOf(a, t), "google"))
        .join(", ")}), then types its id and secret on ${page} (never in the chat).`,
    });
  for (const t of targetsOf(a)) {
    const host = hostOf(a, t),
      tf = f.targets[t];
    const n = namesOf(host);
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
            ? `release ${tf.version}${f.head && tf.version != f.head.slice(0, 12) ? ` (the checkout is at ${f.head.slice(0, 12)})` : ""}, health ${tf.health == "ok" ? "ok" : ((tf.health as { bad: string } | null)?.bad ?? "unknown")}`
            : "not deployed yet"),
      next: clash
        ? `The person decides: free ${host} or pick another address (bun erga own set host=...).`
        : f.dirty
          ? "Commit or stash the changed files first: a deploy builds a commit."
          : `Run: bun erga own deploy ${t}`,
    });
    add({
      id: `signin-${t}`,
      target: t,
      title: `Sign-in works on ${host}`,
      who: "agent",
      ok: tf?.signIn == "ok",
      detail:
        tf?.signIn == "ok"
          ? "/auth/github goes to GitHub with your app"
          : typeof tf?.signIn == "object" && tf.signIn
            ? tf.signIn.bad
            : "not checked",
      next: `Run: bun erga own deploy ${t} (it sends the sign-in app's values), then bun erga own status.`,
    });
    add({
      id: `admin-${t}`,
      target: t,
      title: `${a.admin} signs in to ${host}`,
      who: "person",
      ok: !!tf?.adminIn,
      detail: tf?.adminIn ? "signed in" : "not yet",
      next: `The person opens https://${host}/auth/sign-in and signs in with GitHub as ${a.admin} (GitHub asks to authorize the app once).`,
    });
  }
  githubSteps(a, f, o.ids, add);
  if (a.preset == "company" && a.company)
    add({
      id: "rule",
      title: `People of ${a.company} may sign in`,
      who: "agent",
      ok: !!f.targets.production?.rule,
      detail: f.targets.production?.rule ? "the access rule is there" : "no rule yet",
      next: "Run: bun erga own preset (it adds the access rule with your admin token).",
    });
  return out;
}

/** After the first deploy: the fork on GitHub, and GitHub Actions deploys each push to main (and staging). */
function githubSteps(
  a: Answers,
  f: Facts,
  ids: { github?: string; google?: string },
  add: (s: Omit<Step, "state"> & { ok: boolean | null; failed?: boolean }) => void
) {
  const g = f.github;
  const own = !!g?.repo && g.repo.toLowerCase() != UPSTREAM_REPO;
  add({
    id: "fork",
    title: "Your fork on GitHub",
    who: "agent",
    ok: own,
    detail: !g
      ? "not looked at"
      : !g.login
        ? "gh is not logged in"
        : own
          ? `${g.repo}${g.parent ? `, a fork of ${g.parent}` : ""}`
          : `origin is ${g.repo ?? "not on GitHub"}`,
    next: !g?.login ? "The person runs: gh auth login. Then: bun erga own fork" : "Run: bun erga own fork",
  });
  const missing = f.account ? Object.keys(varsToSet(actionVars(a, ids, f.account), g?.variables ?? null)) : ["CLOUDFLARE_ACCOUNT_ID"];
  add({
    id: "actions-vars",
    title: "GitHub Actions knows your servers",
    who: "agent",
    ok: own && !!g?.variables && !missing.length,
    detail: !g?.variables ? "variables not read" : missing.length ? `to set: ${missing.join(", ")}` : "every variable is set",
    next: "Run: bun erga own actions (it sets the variables, and turns Actions on in the fork).",
  });
  add({
    id: "actions-token",
    title: "GitHub Actions may deploy to Cloudflare",
    who: "person",
    ok: !!g?.secrets?.includes("CLOUDFLARE_API_TOKEN"),
    detail: g?.secrets?.includes("CLOUDFLARE_API_TOKEN") ? "the secret CLOUDFLARE_API_TOKEN is set" : "no CLOUDFLARE_API_TOKEN secret yet",
    next: `The person makes a token at ${tokenTemplateUrl()} (Continue to summary, Create Token), then pastes it on the checklist page, or runs bun erga own actions-token in a terminal. Never in the chat.`,
  });
  const live = f.targets.production?.version;
  add({
    id: "actions-run",
    title: "GitHub deploys main",
    who: "agent",
    ok: g?.run?.status == "completed" && g.run.conclusion == "success" && !!live && g.run.sha.slice(0, 12) == live,
    failed: g?.run?.status == "completed" && g.run.conclusion != "success",
    detail: !g?.run ? "no run of main yet" : `the last run of main: ${g.run.conclusion || g.run.status} (${g.run.url})`,
    next: "Run: bun erga own update (it syncs the fork with Erga's main; GitHub then tests and deploys it). A failed run: read its log.",
  });
}

export const summary = (a: Answers) =>
  `https://${a.host}${a.staging ? `, staging https://${a.staging}` : ", no staging"}; sign-in ${a.providers.join(" + ")}; preset ${a.preset}${a.company ? ` (${a.company})` : ""}; admin ${a.admin}; pages ${a.pages == "shared" ? "on one shared workers.dev address" : `on *.${a.pages}`}`;

/** The step to do now: the first that isn't done (null: all done). */
export const nextStep = (s: Step[]) => s.find((x) => x.state != "done") ?? null;

/** The GitHub App's manifest (GitHub makes the app from it in one click): sign-in only, no permissions, every target's callback. */
export function githubManifest(a: Answers, redirect: string): Record<string, unknown> {
  return {
    name: `Erga ${a.host}`.slice(0, 34),
    url: `https://${a.host}`,
    redirect_url: redirect,
    callback_urls: targetsOf(a).map((t) => callbackOf(hostOf(a, t), "github")),
    description: `Sign-in for the Erga at https://${a.host}`,
    public: false,
    request_oauth_on_install: false,
    hook_attributes: { url: `https://${a.host}/`, active: false },
    default_permissions: {},
  };
}
