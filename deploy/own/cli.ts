// Your own Erga, deployed by your coding agent: `bun erga own <command>` (deploy/cli/main.ts).
// Each command says what it saw, PASS or FAIL, and the next step. The person decides; the agent runs these.
//
//   bun erga own skill               the agent's manual: the steps, the rules, what to do when one fails
//   bun erga own status [--json]     every step, done or not, and the next one (who does it, and how)
//   bun erga own ask                 the person's questions, with the defaults, to ask in one message
//   bun erga own set key=value ...   records answers (host, staging, providers, preset, admin, company, pages, account)
//   bun erga own start [--port N]    the checklist page on localhost: steps, live checks, the person's forms, a chat
//   bun erga own signin github|google --from-file <file>   an existing app's values (KEY=value lines), never printed
//   bun erga own deploy [production|staging]               build this checkout and deploy it (makes what's missing)
//   bun erga own fork [--dry-run]    forks koomen/erga to the person's GitHub, and makes the fork this checkout's origin
//   bun erga own actions [--dry-run] sets the fork's Actions variables and turns Actions on: GitHub deploys main then
//   bun erga own actions-token       reads a Cloudflare API token in the terminal (hidden) and stores it as the fork's secret
//   bun erga own update              syncs the fork's main with Erga's (gh repo sync); GitHub then tests and deploys it
//   bun erga own token [production|staging]                an admin token for this agent, stored in .erga/secrets.json
//   bun erga own home <folder> [production|staging]        the folder's files become the homepage project (/_home)
//   bun erga own preset [production|staging]               the preset's access rule (company)
//   bun erga own inbox [--wait]      the person's new messages from the checklist page; bun erga own say "<text>" answers
//   bun erga own remove <production|staging> --yes         deletes that server: its Workers, database and bucket

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { DeployError, findDatabase, runPipeline, Unhealthy } from "../pipeline/pipeline";
import { d1 } from "../pipeline/account";
import { buildHere } from "../run";
import { OWN_SKILL } from "./skill";
import { PRODUCTION } from "../targets";
import { Tokens } from "../../server/identity/tokens";
import type { Sql } from "../../server/directory/index";
import { deployedSettings } from "../../server/directory/settings";
import {
  type Answers,
  type Facts,
  hostOf,
  namesOf,
  nextStep,
  ownTarget,
  actionVars,
  forkProblem,
  parseAnswer,
  PRESETS,
  QUESTIONS,
  type Step,
  steps,
  summary,
  type TargetName,
  targetsOf,
  tokenTemplateUrl,
  UPSTREAM_REPO,
  varsToSet,
} from "./plan";
import { cloudflare, gh, githubFacts, observe, originRepo, signInCheck, site } from "./facts";
import { addMessage, answersOf, DIR, loadOwn, loadSecrets, messages, readEnvFile, ROOT, saveOwn, saveSecrets } from "./store";

const say = (s = "") => console.log(s);
const pass = (s: string) => say(`PASS  ${s}`);
const fail = (s: string, next: string): never => {
  say(`FAIL  ${s}`);
  say(`NEXT  ${next}`);
  process.exit(1);
};

/** The person's GitHub login, if gh is logged in here: the default admin. */
const ghLogin = () => {
  const r = Bun.spawnSync(["gh", "api", "user", "--jq", ".login"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode == 0 ? r.stdout.toString().trim() : "";
};

const icon: Record<Step["state"], string> = { done: "[x]", todo: "[ ]", blocked: "[ ]", fail: "[!]" };

export async function status(o: { json?: boolean; port?: number } = {}) {
  const own = loadOwn();
  const a = own.answers ? answersOf(own) : null;
  const f = await observe(own, a);
  adoptIds(own, f);
  const list = steps(a, f, { port: o.port ?? pagePort(), ids: { github: own.github?.clientId, google: own.google?.clientId } });
  return { own, answers: a, facts: f, steps: list, next: nextStep(list) };
}

/**
 * A checkout without .erga/own.json's app ids (a new machine) takes them from the server's Worker: they're public, and
 * a deploy without them would drop GITHUB_CLIENT_ID.
 */
function adoptIds(own: ReturnType<typeof loadOwn>, f: Facts) {
  const vars = Object.values(f.targets).map((t) => t?.held?.vars ?? {});
  const github = vars.map((v) => v.GITHUB_CLIENT_ID).find(Boolean),
    google = vars.map((v) => v.GOOGLE_CLIENT_ID).find(Boolean);
  if ((own.github || !github) && (own.google || !google)) return;
  if (!own.github && github) own.github = { clientId: github };
  if (!own.google && google) own.google = { clientId: google };
  saveOwn(own);
}

function printStatus(s: Awaited<ReturnType<typeof status>>) {
  for (const x of s.steps) say(`${icon[x.state]} ${x.title} (${x.who}): ${x.detail}`);
  if (s.facts.secrets.length) say(`    secrets stored (names only): ${s.facts.secrets.join(", ")}`);
  const n = s.next;
  say();
  if (!n) {
    say("PASS  Every step is done.");
    return;
  }
  say(`NEXT  (${n.who}) ${n.title}: ${n.next}`);
}

const pagePort = () => {
  try {
    return Number(readFileSync(join(DIR, "page.port"), "utf8")) || undefined;
  } catch {
    return undefined;
  }
};

function ask() {
  const own = loadOwn();
  const a = answersOf(own, ghLogin());
  say("Ask the person these in ONE message, with the defaults. Record the answers with: bun erga own set key=value ...");
  say();
  for (const q of QUESTIONS) {
    const v = a[q.key];
    const shown = Array.isArray(v)
      ? v.join(",")
      : v || (q.key == "staging" ? "no" : q.key == "company" ? "(none)" : "(no default: must answer)");
    say(`- ${q.key}: ${q.ask}. Default: ${shown}. ${q.help}`);
  }
  say();
  say("Presets:");
  for (const [k, p] of Object.entries(PRESETS))
    say(`- ${k} (${p.title}): ${p.summary} Sets: ${JSON.stringify(p.defaults)}. Who may sign in: ${p.open}`);
}

export function setAnswers(pairs: Record<string, string>): string[] {
  const own = loadOwn();
  const a: Answers = answersOf(own, ghLogin());
  const problems: string[] = [];
  for (const [k, raw] of Object.entries(pairs)) {
    if (k == "account") {
      if (/^[0-9a-f]{32}$/.test(raw.trim())) own.account = raw.trim();
      else problems.push("account is the account's id: 32 hex digits (bunx cf auth whoami lists them).");
      continue;
    }
    if (!QUESTIONS.some((q) => q.key == k)) {
      problems.push(`${k} isn't a question: ${QUESTIONS.map((q) => q.key).join(", ")}, account.`);
      continue;
    }
    const r = parseAnswer(k as keyof Answers, raw);
    if ("problem" in r) problems.push(`${k}: ${r.problem}`);
    else (a as unknown as Record<string, unknown>)[k] = r.value;
  }
  own.answers = a;
  saveOwn(own);
  return problems;
}

function signin(provider: string, file: string | undefined) {
  if (provider != "github" && provider != "google")
    fail(`No sign-in called ${provider}.`, "bun erga own signin github --from-file <file>, or google.");
  if (!file)
    fail(
      "No file given.",
      `bun erga own signin ${provider} --from-file <file with ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET>`
    );
  const env = readEnvFile(file!);
  const P = provider.toUpperCase();
  const id = env[`${P}_CLIENT_ID`]?.trim(),
    secret = env[`${P}_CLIENT_SECRET`]?.trim();
  if (!id || !secret) fail(`${file} has no ${P}_CLIENT_ID and ${P}_CLIENT_SECRET lines.`, "Put both in it as KEY=value lines.");
  const own = loadOwn(),
    s = loadSecrets();
  if (provider == "github") {
    own.github = { clientId: id! };
    s.GITHUB_CLIENT_SECRET = secret;
  } else {
    own.google = { clientId: id! };
    s.GOOGLE_CLIENT_SECRET = secret;
  }
  saveOwn(own);
  saveSecrets(s);
  pass(`${provider} sign-in: client id ${id}; its secret is in .erga/secrets.json (not shown).`);
  say(`NEXT  Make sure the app's callback URL is https://<your host>/auth/${provider}/callback, then: bun erga own deploy`);
}

const random = () => randomBytes(32).toString("hex");

async function deploy(t: TargetName) {
  const st = await status();
  const { own, answers: a, facts: f } = st;
  const before = st.steps.find(
    (x) => x.state != "done" && !x.id.startsWith("deploy-") && !x.id.startsWith("signin-") && !x.id.startsWith("admin-") && x.id != "rule"
  );
  if (before) fail(`${before.title} isn't done: ${before.detail}`, `(${before.who}) ${before.next}`);
  if (!a || !f.account) return;
  if (!targetsOf(a).includes(t))
    fail(
      `This Erga has no ${t} server.`,
      t == "staging" ? "Answer the staging question first: bun erga own set staging=<host>" : "bun erga own deploy production"
    );
  const tf = f.targets[t];
  if (tf?.worker == "other")
    fail(
      `A Worker called ${namesOf(hostOf(a, t)).worker} is there, and it isn't Erga.`,
      "The person decides: delete that Worker, or pick another address."
    );
  if (tf && typeof tf.address == "object")
    fail(
      `${hostOf(a, t)} is taken: ${tf.address.taken}.`,
      "The person decides: free the address, or pick another one (bun erga own set host=...)."
    );
  if (f.dirty)
    fail("Tracked files have changes that aren't committed: a deploy builds a commit.", "Commit them (or git stash), then deploy again.");
  try {
    deployedSettings(PRESETS[a.preset].defaults);
  } catch (e) {
    fail(`The preset's settings don't parse: ${(e as Error).message}`, "Report this to Erga.");
  }
  const s = loadSecrets();
  s.servers ??= {};
  // A server's own secrets are made once, before its first deploy. A Worker that has them keeps them: new ones would
  // sign everyone out, and make the values encrypted with the old FACTORY_KEY unreadable.
  const held = tf?.held?.secrets ?? [];
  if (!s.servers[t] && !(held.includes("SESSION_SECRET") && held.includes("FACTORY_KEY"))) {
    s.servers[t] = { SESSION_SECRET: random(), FACTORY_KEY: random() };
    saveSecrets(s);
  }
  const c = cloudflare();
  if ("why" in c) return fail(c.why, "bunx cf auth login");
  const server = s.servers[t];
  const target = ownTarget(a, t, {
    account: f.account,
    zones: f.zones,
    subdomain: f.workersSubdomain,
    ids: { github: own.github?.clientId, google: own.google?.clientId },
    // No server secrets in the file (a new machine): the Worker keeps the ones it has (keepSecrets).
    secrets: {
      ...(server ? { SESSION_SECRET: server.SESSION_SECRET, FACTORY_KEY: server.FACTORY_KEY } : {}),
      ...(s.GITHUB_CLIENT_SECRET ? { GITHUB_CLIENT_SECRET: s.GITHUB_CLIENT_SECRET } : {}),
      ...(s.GOOGLE_CLIENT_SECRET ? { GOOGLE_CLIENT_SECRET: s.GOOGLE_CLIENT_SECRET } : {}),
    },
  });
  const commit = f.head!;
  say(
    `Deploy ${commit.slice(0, 12)} to ${t}: https://${hostOf(a, t)} (Worker ${target.workerName}, database ${target.databaseName}, bucket ${namesOf(hostOf(a, t)).bucket}).`
  );
  say(`  ${summary(a)}`);
  const started = Date.now();
  const release = await buildHere(commit, (l) => {
    if (!/^build: (\s|$)/.test(l)) say(`  ${l.slice(0, 200)}`);
  });
  const carry = {};
  try {
    const done = await runPipeline(c.cf, release, target, {
      carry,
      site,
      report: (id, state, detail) => say(`  ${id}${state == "running" ? "..." : `: ${state}${detail ? `, ${detail}` : ""}`}`),
    });
    pass(
      `${t} answers at ${done.url}, release ${commit.slice(0, 12)}, healthy. Pages: ${done.pages}. (${Math.round((Date.now() - started) / 1000)} s)`
    );
  } catch (e) {
    const restore = (carry as { restore?: { versionId: string | null } }).restore?.versionId;
    if (e instanceof Unhealthy && restore) {
      await c.cf
        .call("POST", `/accounts/${f.account}/workers/scripts/${target.workerName}/deployments`, "roll back to the version before", {
          strategy: "percentage",
          versions: [{ version_id: restore, percentage: 100 }],
        })
        .catch(() => null);
      fail(`${e.message} It is rolled back to the version before (${restore}).`, "Read the error, fix it, commit, deploy again.");
    }
    fail(
      e instanceof DeployError ? e.message : String(e),
      "Read the error: fix what it names (the person decides anything about the account), then deploy again. Every step is safe to run again."
    );
  }
  const check = await signInCheck(hostOf(a, t), own.github?.clientId);
  if (check == "ok") pass(`Sign-in: https://${hostOf(a, t)}/auth/github goes to GitHub with your app.`);
  else say(`FAIL  Sign-in: ${check && typeof check == "object" ? check.bad : "no answer"}`);
  say(`NEXT  (person) Open https://${hostOf(a, t)}/auth/sign-in and sign in with GitHub as ${a.admin}. Then: bun erga own status`);
}

/** The server's database as the token code's Sql, over Cloudflare's D1 API. */
async function sqlOf(t: TargetName): Promise<{ sql: Sql; host: string }> {
  const own = loadOwn(),
    a = answersOf(own);
  const c = cloudflare();
  if ("why" in c) return fail(c.why, "bunx cf auth login");
  const account = own.account ?? (await c.cf.call<{ id: string }[]>("GET", "/accounts", "list your accounts"))?.[0]?.id;
  const host = hostOf(a, t),
    acc = `/accounts/${account}`;
  const db = await findDatabase(c.cf, acc, namesOf(host).database);
  if (!db) return fail(`${t} has no database yet.`, `bun erga own deploy ${t}`);
  const all = async <T>(q: string, ...p: (string | number | null)[]) => ((await d1(c.cf, acc, db, q, p, "read the database")) ?? []) as T[];
  return {
    host,
    sql: {
      all,
      run: async (q, ...p) => {
        await all(q, ...p);
      },
      batch: async (list) => {
        for (const [q, ...p] of list) await all(q, ...p);
      },
    },
  };
}

async function token(t: TargetName) {
  const own = loadOwn(),
    a = answersOf(own),
    s = loadSecrets();
  const secret = s.servers?.[t]?.SESSION_SECRET;
  if (!secret)
    fail(
      `No SESSION_SECRET for ${t} in .erga/secrets.json.`,
      `bun erga own deploy ${t} makes one (a server deployed elsewhere: its token comes from https://${hostOf(a, t)}/tokens).`
    );
  const { sql, host } = await sqlOf(t);
  const dir = { users: { isAdmin: async () => true }, publish: async () => {} } as unknown as ConstructorParameters<typeof Tokens>[2];
  const made = await new Tokens(sql, secret!, dir).mint(
    { login: a.admin, name: a.admin } as Parameters<Tokens["mint"]>[0],
    "bun erga own (your coding agent)",
    { scope: "admin", expires: Date.now() + 30 * 86400_000 }
  );
  s.tokens = { ...s.tokens, [t]: made.token };
  saveSecrets(s);
  const r = await api(t, "GET", "/api/tools");
  if (!r.ok) fail(`The token doesn't work on ${host}: ${r.status}.`, `Is ${a.admin} in ADMINS? bun erga own status`);
  pass(
    `An admin token for ${a.admin} on ${host}, for 30 days, is in .erga/secrets.json (tokens.${t}; not shown). Revoke it on https://${host}/settings.`
  );
}

/** Calls the server's API as the agent's admin token. */
async function api(t: TargetName, method: string, path: string, body?: unknown): Promise<Response> {
  const own = loadOwn(),
    a = answersOf(own),
    tok = loadSecrets().tokens?.[t];
  if (!tok) return fail(`No token for ${t}.`, `bun erga own token ${t}`);
  return site(`https://${hostOf(a, t)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function tool(t: TargetName, name: string, args: Record<string, unknown>, retry?: RegExp) {
  let j: { ok: boolean; result?: unknown; error?: string } = { ok: false };
  for (let i = 0; i < 15; i++) {
    const r = await api(t, "POST", `/api/tools/${name}`, args);
    j = (await r.json().catch(() => ({ ok: false, error: `${r.status}` }))) as typeof j;
    if (j.ok || !retry?.test(j.error ?? "")) break;
    await Bun.sleep(2000);
  }
  if (!j.ok) fail(`${name} ${JSON.stringify(args).slice(0, 120)}: ${j.error}`, "Read the error; bun erga own status.");
  return j.result;
}

async function home(folder: string | undefined, t: TargetName) {
  if (!folder) fail("No folder given.", "bun erga own home <folder>: its index.html becomes the homepage.");
  const files: Record<string, string | { base64: string }> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e.startsWith(".")) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(folder!, p),
          bytes = readFileSync(p);
        files[rel] = /\.(html|css|js|json|svg|txt|md)$/i.test(e) ? bytes.toString("utf8") : { base64: bytes.toString("base64") };
      }
    }
  };
  walk(folder!);
  if (!files["index.html"]) fail(`${folder} has no index.html.`, "The homepage starts at index.html.");
  const a = answersOf(loadOwn());
  await site(`https://${hostOf(a, t)}/`, { redirect: "manual" }); // The server makes the homepage project at its first visit.
  // It makes it in the background: until it's there, the write says there's no such document.
  await tool(t, "edit", { op: "write", document: "/_home", files, replace: true }, /no document|not found|isn't there/i);
  // A new version of the homepage serves only once it's deployed (server/home/deploys.ts).
  await tool(t, "deploy_homepage", {});
  pass(
    `${Object.keys(files).length} files are the homepage project now: https://${hostOf(a, t)}/ (edit it at https://${hostOf(a, t)}/_home).`
  );
}

async function preset(t: TargetName) {
  const a = answersOf(loadOwn());
  if (a.preset != "company" || !a.company) {
    pass(`The ${a.preset} preset has nothing to add after the deploy: its settings came with it.`);
    return;
  }
  const kind = a.company.includes(".") ? "workspace" : "github_org";
  await tool(t, "people", { op: "set_access", action: "add", kind, value: a.company, access: "write" });
  pass(`People of ${a.company} (${kind}) may sign in and write on ${hostOf(a, t)}.`);
}

/** A command's exit and output; with `inherit`, it prints as it runs. */
const run = (cmd: string[], o: { input?: string; inherit?: boolean } = {}) => {
  const r = Bun.spawnSync(cmd, {
    cwd: ROOT,
    stdin: o.input != null ? new TextEncoder().encode(o.input) : "ignore",
    stdout: o.inherit ? "inherit" : "pipe",
    stderr: o.inherit ? "inherit" : "pipe",
  });
  return { ok: r.exitCode == 0, out: r.stdout?.toString().trim() ?? "", err: r.stderr?.toString().trim() ?? "" };
};

/** Forks Erga to the person's GitHub account; the fork becomes `origin`, Erga's repository `upstream`. */
function fork(dry: boolean) {
  const g = githubFacts();
  if (!g.login) fail("gh is not logged in here.", "The person runs: gh auth login");
  if (g.repo && g.repo.toLowerCase() != UPSTREAM_REPO) {
    pass(`origin is ${g.repo} already${g.parent ? `, a fork of ${g.parent}` : ""}.`);
    say("NEXT  bun erga own status");
    return;
  }
  if (g.login!.toLowerCase() == UPSTREAM_REPO.split("/")[0])
    fail(`${g.login} owns ${UPSTREAM_REPO}: it has no fork of its own.`, "Fork with another GitHub account.");
  const cmd = ["gh", "repo", "fork", UPSTREAM_REPO, "--remote", "--remote-name", "origin"];
  if (dry) {
    say(`Would run: ${cmd.join(" ")}`);
    say(`It makes ${g.login}/erga on GitHub (with main and staging), points origin at it, and keeps ${UPSTREAM_REPO} as upstream.`);
    return;
  }
  const r = run(cmd);
  if (!r.ok) fail(forkProblem(`${r.err} ${r.out}`), "Fix what it names, then bun erga own fork again.");
  const repo = originRepo();
  pass(`Your fork: https://github.com/${repo}. origin points at it; upstream is ${UPSTREAM_REPO}.`);
  say("NEXT  bun erga own status");
}

/** The fork's Actions variables (deploy/actions-plan.ts reads them), and Actions turned on (GitHub turns it off on a new fork). */
function actions(dry: boolean) {
  const own = loadOwn(),
    a = answersOf(own);
  const g = githubFacts();
  if (!g.repo || g.repo.toLowerCase() == UPSTREAM_REPO) fail("origin is not your fork.", "bun erga own fork");
  if (!a.host || !own.account || !own.github?.clientId)
    fail("The answers, the account or the GitHub app's id are missing.", "bun erga own status shows which; deploy once first.");
  const want = actionVars(a, { github: own.github?.clientId, google: own.google?.clientId }, own.account!);
  const todo = varsToSet(want, g.variables);
  if (dry) {
    for (const [k, v] of Object.entries(todo)) say(`Would set ${k}=${v} on ${g.repo}`);
    if (!Object.keys(todo).length) say("Every variable is set already.");
    say(`Would turn on Actions: gh api -X PUT repos/${g.repo}/actions/permissions -F enabled=true -f allowed_actions=all`);
    return;
  }
  for (const [k, v] of Object.entries(todo)) {
    const r = run(["gh", "variable", "set", k, "-R", g.repo!, "--body", v]);
    if (!r.ok) fail(`gh variable set ${k} failed: ${r.err}`, "Check that gh may write to the fork (gh auth status).");
  }
  const on = run(["gh", "api", "-X", "PUT", `repos/${g.repo}/actions/permissions`, "-F", "enabled=true", "-f", "allowed_actions=all"]);
  if (!on.ok) say(`NOTE  Actions could not be turned on: ${on.err}. Open https://github.com/${g.repo}/actions and turn workflows on.`);
  pass(`${Object.keys(todo).length} variable(s) set on ${g.repo}; Actions is on. A push to main deploys https://${a.host}.`);
  say(
    g.secrets?.includes("CLOUDFLARE_API_TOKEN") ? "NEXT  bun erga own update" : `NEXT  (person) The Cloudflare token: ${tokenTemplateUrl()}`
  );
}

/** Checks a Cloudflare API token, then stores it as the fork's CLOUDFLARE_API_TOKEN secret. Never printed. */
export async function storeActionsToken(token: string): Promise<string | null> {
  const repo = originRepo();
  if (!repo || repo.toLowerCase() == UPSTREAM_REPO) return "origin is not your fork: bun erga own fork first.";
  const r = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: { Authorization: `Bearer ${token}` } }).catch(
    () => null
  );
  const body = (await r?.json().catch(() => null)) as { success?: boolean; result?: { status?: string } } | null;
  if (!body?.success || body.result?.status != "active")
    return "Cloudflare does not accept this token (it is not active). Make it again with the link.";
  const set = run(["gh", "secret", "set", "CLOUDFLARE_API_TOKEN", "-R", repo], { input: token });
  return set.ok ? null : `gh secret set failed: ${set.err}`;
}

async function actionsToken() {
  say(`Make the token here (the permissions are filled in): ${tokenTemplateUrl()}`);
  const token = await readHidden("Paste the token (it is not shown): ");
  if (!token) fail("No token.", "Run bun erga own actions-token again, and paste the token.");
  const problem = await storeActionsToken(token);
  if (problem) fail(problem, "Fix what it names, then run bun erga own actions-token again.");
  pass(`The secret CLOUDFLARE_API_TOKEN is set on ${originRepo()}.`);
  say("NEXT  bun erga own update");
}

/** A line from the terminal, not echoed. */
async function readHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const tty = process.stdin.isTTY;
  if (tty) Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line.trim();
    return "";
  } finally {
    if (tty) Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stdout.write("\n");
  }
}

/** Syncs the fork's main with Erga's (as "Sync fork" on GitHub does); GitHub Actions then tests and deploys it. */
async function update() {
  const repo = originRepo();
  if (!repo || repo.toLowerCase() == UPSTREAM_REPO) fail("origin is not your fork.", "bun erga own fork");
  const before = gh<{ object: { sha: string } }>("api", `repos/${repo}/git/ref/heads/main`)?.object.sha;
  const r = run(["gh", "repo", "sync", repo!, "--source", UPSTREAM_REPO, "--branch", "main"]);
  if (!r.ok)
    fail(`gh repo sync failed: ${r.err}`, "Your fork's main has commits of its own: merge Erga's main into it on your machine, then push.");
  const after = gh<{ object: { sha: string } }>("api", `repos/${repo}/git/ref/heads/main`)?.object.sha;
  if (before == after) pass(`${repo}'s main is up to date with ${UPSTREAM_REPO} (${after?.slice(0, 12)}).`);
  else pass(`${repo}'s main moved to ${after?.slice(0, 12)}. GitHub tests it, then deploys it: bun erga own status shows the run.`);
  run(["git", "fetch", "--quiet", "origin"]);
}

async function inbox(wait: boolean) {
  const seenFile = join(DIR, "inbox.seen");
  let seen = 0;
  try {
    seen = Number(readFileSync(seenFile, "utf8")) || 0;
  } catch {}
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const fresh = messages().filter((m) => m.from == "person" && m.at > seen);
    if (fresh.length || !wait || Date.now() > deadline) {
      for (const m of fresh) say(`[${new Date(m.at).toLocaleTimeString()}] person: ${m.text}`);
      if (!fresh.length) say("No new messages from the person.");
      if (fresh.length) writeFileSync(seenFile, String(fresh.at(-1)!.at));
      return;
    }
    await Bun.sleep(1000);
  }
}

async function remove(t: TargetName, yes: boolean) {
  const own = loadOwn(),
    a = answersOf(own);
  const host = hostOf(a, t),
    n = namesOf(host);
  if (!yes)
    fail(
      `This deletes ${t} (${host}): the Workers ${n.worker} and ${n.pagesWorker}, the database ${n.database} and the bucket ${n.bucket}, with every document on it.`,
      `Only if the person said yes: bun erga own remove ${t} --yes`
    );
  if (n.worker == PRODUCTION.worker || n.database == PRODUCTION.database) fail("Those are erga.dev's names.", "Never.");
  const c = cloudflare();
  if ("why" in c) return fail(c.why, "bunx cf auth login");
  const acc = `/accounts/${own.account ?? (await c.cf.call<{ id: string }[]>("GET", "/accounts", "list your accounts"))?.[0]?.id}`;
  const step = async (what: string, f: () => Promise<unknown>) => {
    try {
      await f();
      pass(what);
    } catch (e) {
      say(`SKIP  ${what}: ${(e as Error).message}`);
    }
  };
  const domains =
    (await c.cf
      .call<{ id: string; hostname: string; service: string }[]>("GET", `${acc}/workers/domains?hostname=${host}`, "read custom domains")
      .catch(() => [])) ?? [];
  for (const d of domains.filter((d) => d.service == n.worker))
    await step(`custom domain ${host} removed`, () => c.cf.call("DELETE", `${acc}/workers/domains/${d.id}`, "remove the custom domain"));
  await step(`Worker ${n.pagesWorker} deleted`, () =>
    c.cf.call("DELETE", `${acc}/workers/scripts/${n.pagesWorker}?force=true`, "delete the pages Worker", undefined, { allow404: true })
  );
  await step(`Worker ${n.worker} deleted`, () =>
    c.cf.call("DELETE", `${acc}/workers/scripts/${n.worker}?force=true`, "delete the Worker", undefined, { allow404: true })
  );
  const db = await findDatabase(c.cf, acc, n.database).catch(() => null);
  if (db) await step(`database ${n.database} deleted`, () => c.cf.call("DELETE", `${acc}/d1/database/${db}`, "delete the database"));
  await step(`bucket ${n.bucket} deleted (only if empty)`, () =>
    c.cf.call("DELETE", `${acc}/r2/buckets/${n.bucket}`, "delete the bucket", undefined, { allow404: true })
  );
  const s = loadSecrets();
  if (s.servers?.[t]) delete s.servers[t];
  if (s.tokens?.[t]) delete s.tokens[t];
  saveSecrets(s);
}

const targetArg = (v: string | undefined): TargetName =>
  v == "staging"
    ? "staging"
    : v == undefined || v == "production"
      ? "production"
      : fail(`No server called ${v}.`, "production or staging.");

export async function ownMain(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flag = (f: string) => rest.includes(f);
  const opt = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const plain = rest.filter((x, i) => !x.startsWith("--") && !rest[i - 1]?.startsWith("--from-file") && !rest[i - 1]?.startsWith("--port"));
  try {
    switch (cmd) {
      case "status": {
        const s = await status();
        if (flag("--json")) say(JSON.stringify({ steps: s.steps, next: s.next, facts: { ...s.facts, zoneIds: undefined } }, null, 2));
        else printStatus(s);
        break;
      }
      case "ask":
        ask();
        break;
      case "set": {
        const pairs = Object.fromEntries(
          plain.map((p) => {
            const i = p.indexOf("=");
            return i > 0 ? [p.slice(0, i), p.slice(i + 1)] : [p, ""];
          })
        );
        const problems = setAnswers(pairs);
        for (const p of problems) say(`FAIL  ${p}`);
        const a = answersOf(loadOwn());
        if (!problems.length) pass(`Recorded. ${a.host ? summary(a) : ""}`);
        say("NEXT  bun erga own status");
        process.exit(problems.length ? 1 : 0);
        break;
      }
      case "start": {
        const { startPage } = await import("./page");
        await startPage(Number(opt("--port")) || 4747, flag("--open"));
        break;
      }
      case "signin":
        signin(plain[0] ?? "", opt("--from-file"));
        break;
      case "deploy":
        await deploy(targetArg(plain[0]));
        break;
      case "token":
        await token(targetArg(plain[0]));
        break;
      case "home":
        await home(plain[0], targetArg(plain[1]));
        break;
      case "preset":
        await preset(targetArg(plain[0]));
        break;
      case "update":
        await update();
        break;
      case "fork":
        fork(flag("--dry-run"));
        break;
      case "actions":
        actions(flag("--dry-run"));
        break;
      case "actions-token":
        await actionsToken();
        break;
      case "inbox":
        await inbox(flag("--wait"));
        break;
      case "skill":
        say(OWN_SKILL);
        break;
      case "say":
        addMessage("agent", plain.join(" "));
        pass("Sent to the checklist page.");
        break;
      case "remove":
        await remove(targetArg(plain[0]), flag("--yes"));
        break;
      default:
        say(
          readFileSync(new URL(import.meta.url), "utf8")
            .split("\n")
            .filter((l, i, all) => i < all.findIndex((x) => !x.startsWith("//")))
            .map((l) => l.slice(3))
            .join("\n")
        );
        process.exit(cmd && cmd != "help" ? 2 : 0);
    }
  } catch (e) {
    fail((e as Error).message, "Read the error above; bun erga own status shows where things are.");
  }
}
