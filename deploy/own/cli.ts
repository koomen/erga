#!/usr/bin/env bun
// Your own Erga, deployed by your coding agent: `bun own <command>`. DEPLOY.md is the manual.
// Each command says what it saw, PASS or FAIL, and the next step. The person decides; the agent runs these.
//
//   bun own status [--json]          every step, done or not, and the next one (who does it, and how)
//   bun own ask                      the person's questions, with the defaults, to ask in one message
//   bun own set key=value ...        records answers (host, staging, providers, preset, admin, company, pages, account)
//   bun own start [--port N]         the checklist page on localhost: steps, live checks, the person's forms, a chat
//   bun own signin github|google --from-file <file>   an existing app's values (KEY=value lines), never printed
//   bun own deploy [production|staging]               build this checkout and deploy it (makes what's missing)
//   bun own token [production|staging]                an admin token for this agent, stored in .erga/secrets.json
//   bun own home <folder> [production|staging]        the folder's files become the homepage project (/_home)
//   bun own preset [production|staging]               the preset's access rule (company)
//   bun own update                   pulls erga.dev's main, then deploys each server
//   bun own inbox [--wait]           the person's new messages from the checklist page; bun own say "<text>" answers
//   bun own remove <production|staging> --yes         deletes that server: its Workers, database and bucket

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { DeployError, findDatabase, runPipeline, type Target, Unhealthy } from "../../control/deploys/pipeline";
import { d1 } from "../../control/deploys/account";
import { buildHere } from "../run";
import { ACCOUNT, PRODUCTION } from "../targets";
import { Tokens } from "../../server/identity/tokens";
import type { Sql } from "../../server/directory/index";
import { deployedSettings } from "../../server/directory/settings";
import {
  type Answers,
  hostOf,
  namesOf,
  nextStep,
  parseAnswer,
  PRESETS,
  QUESTIONS,
  type Step,
  steps,
  summary,
  type TargetName,
  targetsOf,
  varsOf,
} from "./plan";
import { cloudflare, gitOf, observe, signInCheck, site, UPSTREAM, upstreamHead } from "./facts";
import { addMessage, answersOf, DIR, loadOwn, loadSecrets, messages, readEnvFile, ROOT, saveOwn, saveSecrets, type Secrets } from "./store";

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
  const list = steps(a, f, { port: o.port ?? pagePort(), ids: { github: own.github?.clientId, google: own.google?.clientId } });
  return { own, answers: a, facts: f, steps: list, next: nextStep(list) };
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
  say("Ask the person these in ONE message, with the defaults. Record the answers with: bun own set key=value ...");
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
    fail(`No sign-in called ${provider}.`, "bun own signin github --from-file <file>, or google.");
  if (!file)
    fail(
      "No file given.",
      `bun own signin ${provider} --from-file <file with ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET>`
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
  say(`NEXT  Make sure the app's callback URL is https://<your host>/auth/${provider}/callback, then: bun own deploy`);
}

const random = () => randomBytes(32).toString("hex");

/** The pipeline's target for one of the person's servers. */
function targetOf(
  a: Answers,
  t: TargetName,
  account: string,
  zones: string[],
  subdomain: string | null,
  own: ReturnType<typeof loadOwn>,
  s: Secrets
): Target {
  const host = hostOf(a, t),
    n = namesOf(host);
  const zoneName = zones.filter((z) => host == z || host.endsWith(`.${z}`)).sort((x, y) => y.length - x.length)[0];
  const server = s.servers?.[t]!;
  return {
    label: t,
    accountId: account,
    workerName: n.worker,
    databaseName: n.database,
    ...(a.pages == "shared" ? { subdomain: subdomain ?? n.worker.slice(0, 40), createSubdomain: !subdomain } : {}),
    app: { kind: "domain", zoneName, hostname: host },
    pages: a.pages == "shared" ? { kind: "shared" } : { kind: "zone", zoneName: a.pages },
    vars: varsOf(a, { github: own.github?.clientId, google: own.google?.clientId }),
    secrets: {
      SESSION_SECRET: server.SESSION_SECRET,
      FACTORY_KEY: server.FACTORY_KEY,
      ...(s.GITHUB_CLIENT_SECRET ? { GITHUB_CLIENT_SECRET: s.GITHUB_CLIENT_SECRET } : {}),
      ...(s.GOOGLE_CLIENT_SECRET ? { GOOGLE_CLIENT_SECRET: s.GOOGLE_CLIENT_SECRET } : {}),
    },
    keepSecrets: true,
    checkVersion: true,
    // Erga's own erga.dev names stay out of reach, in Erga's own account.
    guard: { ...PRODUCTION, accountId: ACCOUNT },
  };
}

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
      t == "staging" ? "Answer the staging question first: bun own set staging=<host>" : "bun own deploy production"
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
      "The person decides: free the address, or pick another one (bun own set host=...)."
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
  if (!s.servers[t]) {
    s.servers[t] = { SESSION_SECRET: random(), FACTORY_KEY: random() };
    saveSecrets(s);
  }
  const c = cloudflare();
  if ("why" in c) return fail(c.why, "bunx cf auth login");
  const target = targetOf(a, t, f.account, f.zones, f.workersSubdomain, own, s);
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
  say(`NEXT  (person) Open https://${hostOf(a, t)}/auth/sign-in and sign in with GitHub as ${a.admin}. Then: bun own status`);
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
  if (!db) return fail(`${t} has no database yet.`, `bun own deploy ${t}`);
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
      `bun own deploy ${t} makes one (a server deployed elsewhere: its token comes from https://${hostOf(a, t)}/tokens).`
    );
  const { sql, host } = await sqlOf(t);
  const dir = { users: { isAdmin: async () => true }, publish: async () => {} } as unknown as ConstructorParameters<typeof Tokens>[2];
  const made = await new Tokens(sql, secret!, dir).mint(
    { login: a.admin, name: a.admin } as Parameters<Tokens["mint"]>[0],
    "bun own (your coding agent)",
    { scope: "admin", expires: Date.now() + 30 * 86400_000 }
  );
  s.tokens = { ...s.tokens, [t]: made.token };
  saveSecrets(s);
  const r = await api(t, "GET", "/api/tools");
  if (!r.ok) fail(`The token doesn't work on ${host}: ${r.status}.`, `Is ${a.admin} in ADMINS? bun own status`);
  pass(
    `An admin token for ${a.admin} on ${host}, for 30 days, is in .erga/secrets.json (tokens.${t}; not shown). Revoke it on https://${host}/settings.`
  );
}

/** Calls the server's API as the agent's admin token. */
async function api(t: TargetName, method: string, path: string, body?: unknown): Promise<Response> {
  const own = loadOwn(),
    a = answersOf(own),
    tok = loadSecrets().tokens?.[t];
  if (!tok) return fail(`No token for ${t}.`, `bun own token ${t}`);
  return site(`https://${hostOf(a, t)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function tool(t: TargetName, name: string, args: Record<string, unknown>) {
  const r = await api(t, "POST", `/api/tools/${name}`, args);
  const j = (await r.json().catch(() => ({ ok: false, error: `${r.status}` }))) as { ok: boolean; result?: unknown; error?: string };
  if (!j.ok) fail(`${name} ${JSON.stringify(args).slice(0, 120)}: ${j.error}`, "Read the error; bun own status.");
  return j.result;
}

async function home(folder: string | undefined, t: TargetName) {
  if (!folder) fail("No folder given.", "bun own home <folder>: its index.html becomes the homepage.");
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
  await tool(t, "edit", { op: "write", document: "/_home", files, replace: true });
  // A new version of the homepage serves only once it's deployed (server/home/deploys.ts).
  await tool(t, "deploys", { op: "redeploy", target: "homepage" });
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

async function update() {
  const head = upstreamHead();
  if (!head) fail(`Can't read ${UPSTREAM}.`, "Check the network, then bun own update again.");
  const run = (cmd: string[]) => {
    const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    return r.exitCode == 0;
  };
  if (!run(["git", "fetch", UPSTREAM, "main"])) fail("git fetch failed.", "Read git's error above.");
  if (gitOf("merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD") != null) pass(`Already up to date with erga.dev (${head!.slice(0, 12)}).`);
  else if (!run(["git", "merge", "--no-edit", "FETCH_HEAD"]))
    fail("The update from erga.dev conflicts with your changes.", "Resolve the conflicts (git status), commit, then bun own deploy.");
  if (!run(["bun", "install", "--frozen-lockfile"])) fail("bun install failed.", "Read its error above.");
  const a = answersOf(loadOwn());
  for (const t of a.staging ? (["staging", "production"] as const) : (["production"] as const)) {
    const r = Bun.spawnSync(["bun", "deploy/own/cli.ts", "deploy", t], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode != 0) fail(`The deploy of ${t} failed.`, "Read its error above.");
  }
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
      `Only if the person said yes: bun own remove ${t} --yes`
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

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
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
        say("NEXT  bun own status");
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
      case "inbox":
        await inbox(flag("--wait"));
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
            .filter((l) => l.startsWith("//"))
            .slice(0, 16)
            .map((l) => l.slice(3))
            .join("\n")
        );
        process.exit(cmd ? 2 : 0);
    }
  } catch (e) {
    fail((e as Error).message, "Read the error above; bun own status shows where things are.");
  }
}
