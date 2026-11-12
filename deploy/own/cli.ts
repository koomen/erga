// A new Erga instance, set up by a coding agent: `bun erga setup <host> [<command>]` (deploy/cli/main.ts). Each command
// says what it saw, PASS or FAIL, and the next step. The person decides; the agent runs these.
//
//   bun erga setup skill                       the agent's manual: the steps, the rules, what to do when one fails
//   bun erga setup <host> [--no-tests] [--home <domain>]
//                                              every step, then the agent's next ones: the first deploy of each server
//                                              (the entries, the secrets one time, the first admin), then the ops token
//                                              that the admin approves; it stops at a step of the person's. --home: the
//                                              production server serves the homepage's site on that domain too
//   bun erga setup <host> status [--json]      every step, done or not, and the next one (who does it, and how)
//   bun erga setup <host> ask                  the person's questions, with the defaults, to ask in one message
//   bun erga setup <host> set key=value ...    records answers (staging, providers, preset, admin, company, pages,
//                                              feedback, account)
//   bun erga setup <host> start [--port N]     the ops page's Setup tab: steps, live checks, the person's forms, a chat
//   bun erga setup <host> signin github|google --from-file <file>   an existing app's values (KEY=value lines), never printed
//   bun erga setup <host> token [production|staging]                an admin token for this agent, in .erga/secrets.json
//   bun erga setup <host> home <folder> [production|staging]        the folder's files become the homepage project (/_home)
//   bun erga setup <host> preset [production|staging]               the preset's access rule (company)
//   bun erga setup <host> inbox [--wait]       the person's new messages from the Setup tab; ... say "<text>" answers
//   bun erga setup <host> stack [--yes]        AWS: writes the templates into .erga/aws/ (once), shows AWS's change sets;
//                                              --yes (after the person's yes) applies them
//   bun erga setup <host> remove <production|staging> --yes         deletes that server: its Workers, database and bucket
//                                              (AWS: its stacks and secrets; the bucket stays, with the data)

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findDatabase } from "../pipeline/pipeline";
import { d1 } from "../pipeline/account";
import { SETUP_SKILL } from "./skill";
import { Tokens } from "../../server/identity/tokens";
import type { Sql } from "../../server/directory/index";
import { deployedSettings } from "../../server/directory/settings";
import {
  type Answers,
  type Facts,
  hostOf,
  namesOf,
  nextStep,
  parseAnswer,
  PRESETS,
  QUESTIONS,
  proxySignIn,
  type Step,
  steps,
  summary,
  type TargetName,
  targetsOf,
} from "./plan";
import { checkSignIn, cloudflare, type Connection, observe, site } from "./facts";
import { fail, pass, say } from "../root";
import { firstDeploy, registerSetup } from "./first";
import { addMessage, answersOf, DIR, loadOwn, loadSecrets, messages, putSecret, readEnvFile, saveOwn, saveSecrets } from "./store";


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
 * A checkout without .erga/setup.json's app ids (a new machine) takes them from the server's Worker: they're public, and
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
  say(`Ask the person these in ONE message, with the defaults. Record the answers with: bun erga setup ${a.host} set key=value ...`);
  say();
  for (const q of QUESTIONS) {
    const v = a[q.key];
    const shown = Array.isArray(v)
      ? v.join(",")
      : v || (q.key == "staging" || q.key == "feedback" ? "no" : q.key == "company" ? "(none)" : "(no default: must answer)");
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

/** The setup's host is the command's: a new host keeps the other answers, and says so. */
function setHost(host: string) {
  const own = loadOwn();
  const had = own.answers?.host;
  if (had == host) return;
  if (had) say(`NOTE  The setup was for ${had}; it is for ${host} now. The other answers stay (bun erga setup ${host} status).`);
  own.answers = { ...answersOf(own, ghLogin()), host };
  saveOwn(own);
}

function signin(provider: string, file: string | undefined) {
  const host = answersOf(loadOwn()).host;
  if (provider != "github" && provider != "google")
    fail(`No sign-in called ${provider}.`, `bun erga setup ${host} signin github --from-file <file>, or google.`);
  if (!file)
    fail(
      "No file given.",
      `bun erga setup ${host} signin ${provider} --from-file <file with ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET>`
    );
  const env = readEnvFile(file!);
  const P = provider.toUpperCase();
  const id = env[`${P}_CLIENT_ID`]?.trim(),
    secret = env[`${P}_CLIENT_SECRET`]?.trim();
  if (!id || !secret) fail(`${file} has no ${P}_CLIENT_ID and ${P}_CLIENT_SECRET lines.`, "Put both in it as KEY=value lines.");
  const own = loadOwn();
  if (provider == "github") own.github = { clientId: id! };
  else own.google = { clientId: id! };
  saveOwn(own);
  putSecret(host, `${P}_CLIENT_SECRET`, secret!);
  pass(`${provider} sign-in: client id ${id}; its secret is in .erga/secrets.json (not shown).`);
  say(`NEXT  Make sure the app's callback URL is https://<your host>/auth/${provider}/callback, then: bun erga setup ${host}`);
}

/** The Cloudflare API and the servers, or a FAIL. */
const connect = async (): Promise<Connection> => {
  const c = await cloudflare();
  return "why" in c ? fail(c.why, "bunx cf auth login") : c;
};

type Status = Awaited<ReturnType<typeof status>>;

/** The first deploy of `t`: the entries, the secrets the Worker doesn't hold, the deploy, the first admin and feedback's repository. */
async function deployStep(s: Status, t: TargetName, noTests: boolean, home: string | undefined) {
  const { own, answers: a, facts: f } = s;
  if (!a || !f.account) return;
  try {
    deployedSettings(PRESETS[a.preset].defaults);
  } catch (e) {
    fail(`The preset's settings don't parse: ${(e as Error).message}`, "Report this to Erga.");
  }
  if (a.provider == "aws") return deployStepAws(s, t, noTests, home);
  const c = await connect();
  const host = hostOf(a, t);
  say(`Deploy ${t}: https://${host} (Worker ${namesOf(host).worker}, database ${namesOf(host).database}, bucket ${namesOf(host).bucket}).`);
  say(`  ${summary(a)}`);
  const started = Date.now();
  const ids = { github: own.github?.clientId, google: own.google?.clientId };
  try {
    const sha = await firstDeploy(
      {
        dir: DIR,
        answers: a,
        account: f.account,
        zones: f.zones,
        subdomain: f.workersSubdomain,
        ids,
        net: c.net,
        token: c.token,
        noTests,
        ...(home ? { home } : {}),
        print: (l) => say(`  ${l.slice(0, 200)}`),
      },
      t
    );
    pass(`${t} answers at https://${host}, release ${sha.slice(0, 12)}, healthy. (${Math.round((Date.now() - started) / 1000)} s)`);
  } catch (e) {
    fail(
      (e as Error).message,
      `Fix what it names (the person decides anything about the account), then: bun erga setup ${a.host}. Every step is safe to run again.`
    );
  }
  const check = await checkSignIn(c.net, host, a, ids.github);
  if (check == "ok") pass(SIGN_IN_OK(a, host));
  else say(`FAIL  Sign-in: ${check && typeof check == "object" ? check.bad : "no answer"}`);
}

/** The first deploy on AWS: the entry, the secrets into Parameter Store, the machine's programs, the deploy, the first admin. */
async function deployStepAws({ own, answers: a, facts: f }: Status, t: TargetName, noTests: boolean, home: string | undefined) {
  if (!a) return;
  if (home) fail("--home is only for an instance on Cloudflare.", `bun erga setup ${a.host}`);
  const { firstDeployAws } = await import("../aws/setup");
  const { secretsFor } = await import("./first");
  const started = Date.now();
  say(`Deploy ${t} on AWS: stack ${f.stack?.name}, https://${f.stack?.outputs.AppHost}.`);
  say(`  ${summary(a)}`);
  const ids = { github: own.github?.clientId, google: own.google?.clientId };
  try {
    const sha = await firstDeployAws({
      dir: DIR,
      answers: a,
      facts: f,
      ids,
      secrets: secretsFor(DIR, a, t, f.targets[t]?.held?.secrets ?? []),
      net: site,
      noTests,
      print: (l) => say(`  ${l.slice(0, 200)}`),
    });
    pass(
      `${t} answers at https://${f.stack?.outputs.AppHost}, release ${sha.slice(0, 12)}, healthy. (${Math.round((Date.now() - started) / 1000)} s)`
    );
  } catch (e) {
    fail(
      (e as Error).message,
      `Fix what it names (the person decides anything about the account), then: bun erga setup ${a.host}. Every step is safe to run again.`
    );
  }
  const host = f.stack!.outputs.AppHost;
  const check = await checkSignIn(site, host, a, ids.github);
  if (check == "ok") pass(SIGN_IN_OK(a, host));
  else say(`FAIL  Sign-in: ${check && typeof check == "object" ? check.bad : "no answer"}`);
}

/** `stack [--yes]` (AWS): the templates, AWS's change sets, and with --yes (the person said yes) the stacks. */
async function stack(yes: boolean) {
  const own = loadOwn(),
    a = answersOf(own);
  if (a.provider != "aws")
    fail("stack is for an instance on AWS.", `bun erga setup ${a.host} set provider=aws, or go on: bun erga setup ${a.host}`);
  const { stackStep } = await import("../aws/setup");
  const applied = { ...(own.applied ?? {}) };
  let done = false;
  try {
    done = await stackStep(DIR, a, yes, applied, (l) => say(`  ${l}`));
  } finally {
    // What was applied stays recorded, even when a later stack failed.
    saveOwn({ ...loadOwn(), applied });
  }
  if (done) pass("The stacks are made, as the templates say.");
  else
    say(
      `NEXT  The person reads the templates in ${join(DIR, "aws")} and the change set above. They may change a template, then: bun erga setup ${a.host} stack. After their yes: bun erga setup ${a.host} stack --yes`
    );
}

/** register's ops token for `t`: the admin signs in and approves it in the browser, and the entry gets it. */
/** What a working sign-in is, in the setup's mode. */
const SIGN_IN_OK = (a: Answers, host: string) =>
  proxySignIn(a)
    ? `Sign-in: the proxy in front of https://${host} sends a browser to your company's sign-in.`
    : `Sign-in: https://${host}/auth/github goes to GitHub with your app.`;

async function registerStep({ answers: a }: Status, t: TargetName) {
  if (!a) return;
  const host = hostOf(a, t);
  const c = a.provider == "aws" ? { net: site } : await connect();
  say(
    `Register ${host}: ${a.admin} signs in with ${proxySignIn(a) ? "the company's sign-in" : "GitHub"} and approves an ops token (an admin only, 90 days at most).`
  );
  try {
    const login = await registerSetup(DIR, host, { site: c.net, say: (l) => say(`      ${l}`) });
    pass(`${login} approved the ops token: ${host} is registered in .erga/config.json.`);
  } catch (e) {
    fail((e as Error).message, `Run bun erga setup ${a.host} again: it asks for a new token.`);
  }
}

/**
 * `bun erga setup <host>`: every step, then the agent's next ones (a first deploy, an ops token), until a step of the
 * person's or the end. A step that is still not done after its run stops it.
 */
async function run(noTests: boolean, home: string | undefined) {
  let ran = "";
  for (;;) {
    const s = await status();
    printStatus(s);
    const n = s.next;
    if (!n) {
      // Deployed before: --home goes with the next deploy.
      if (home && !ran) say(`NOTE  The first deploy is done. bun erga deploy ${s.answers?.host} --home ${home} puts the homepage there.`);
      say(
        `NEXT  A new commit: bun erga deploy <commit> ${s.answers?.host}${s.answers?.staging ? ` (and ${s.answers.staging} first)` : ""}.`
      );
      return;
    }
    if (n.id == ran) fail(`${n.title} is still not done: ${n.detail}`, n.next);
    if (n.id.startsWith("deploy-") && n.state == "todo") await deployStep(s, n.target!, noTests, home);
    else if (n.id.startsWith("register-") && n.state == "todo") await registerStep(s, n.target!);
    else return;
    ran = n.id;
    say();
  }
}

/** The server's database as the token code's Sql, over Cloudflare's D1 API. */
async function sqlOf(t: TargetName): Promise<{ sql: Sql; host: string }> {
  const own = loadOwn(),
    a = answersOf(own);
  const { cf } = await connect();
  const account = own.account ?? (await cf.call<{ id: string }[]>("GET", "/accounts", "list your accounts"))?.[0]?.id;
  const host = hostOf(a, t),
    acc = `/accounts/${account}`;
  const db = await findDatabase(cf, acc, namesOf(host).database);
  if (!db) return fail(`${t} has no database yet.`, `bun erga setup ${a.host}`);
  const all = async <T>(q: string, ...p: (string | number | null)[]) => ((await d1(cf, acc, db, q, p, "read the database")) ?? []) as T[];
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
  const a = answersOf(loadOwn());
  if (a.provider == "aws")
    fail("An agent's admin token is only made this way on Cloudflare.", `Make one on the server's Settings page as ${a.admin}.`);
  const secret = loadSecrets()[hostOf(a, t)]?.SESSION_SECRET;
  if (!secret)
    fail(
      `No SESSION_SECRET for ${hostOf(a, t)} in .erga/secrets.json.`,
      `bun erga setup ${a.host} makes one before the first deploy (a server set up elsewhere: its token comes from https://${hostOf(a, t)}/tokens).`
    );
  const { sql, host } = await sqlOf(t);
  const dir = { users: { isAdmin: async () => true }, publish: async () => {} } as unknown as ConstructorParameters<typeof Tokens>[2];
  const made = await new Tokens(sql, secret!, dir).mint(
    { login: a.admin, name: a.admin } as Parameters<Tokens["mint"]>[0],
    "bun erga setup (your coding agent)",
    { scope: "admin", expires: Date.now() + 30 * 86400_000 }
  );
  putSecret(host, "ADMIN_TOKEN", made.token);
  const r = await api(t, "GET", "/api/tools");
  if (!r.ok) fail(`The token doesn't work on ${host}: ${r.status}.`, `Is ${a.admin} an admin there? bun erga setup ${a.host} status`);
  pass(
    `An admin token for ${a.admin} on ${host}, for 30 days, is in .erga/secrets.json (${host}: ADMIN_TOKEN; not shown). Revoke it on https://${host}/settings.`
  );
}

/** Calls the server's API as the agent's admin token. */
async function api(t: TargetName, method: string, path: string, body?: unknown): Promise<Response> {
  const a = answersOf(loadOwn()),
    host = hostOf(a, t),
    tok = loadSecrets()[host]?.ADMIN_TOKEN;
  if (!tok) return fail(`No admin token for ${host}.`, `bun erga setup ${a.host} token ${t}`);
  return (await connect()).net(`https://${host}${path}`, {
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
  if (!j.ok) fail(`${name} ${JSON.stringify(args).slice(0, 120)}: ${j.error}`, "Read the error; bun erga setup <host> status.");
  return j.result;
}

async function home(folder: string | undefined, t: TargetName) {
  if (!folder) fail("No folder given.", "bun erga setup <host> home <folder>: its index.html becomes the homepage.");
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
  const host = hostOf(answersOf(loadOwn()), t);
  await (await connect()).net(`https://${host}/`, { redirect: "manual" }); // The server makes the homepage project at its first visit.
  // It makes it in the background: until it's there, the write says there's no such document.
  await tool(t, "edit", { op: "write", document: "/_home", files, replace: true }, /no document|not found|isn't there/i);
  // A new version of the homepage serves only once it's deployed (server/home/deploys.ts).
  await tool(t, "deploy_homepage", {});
  pass(`${Object.keys(files).length} files are the homepage project now: https://${host}/ (edit it at https://${host}/_home).`);
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
  if (a.provider == "aws") return removeAws(t, yes);
  const host = hostOf(a, t),
    n = namesOf(host);
  if (!yes)
    fail(
      `This deletes ${t} (${host}): the Workers ${n.worker} and ${n.pagesWorker}, the database ${n.database} and the bucket ${n.bucket}, with every document on it.`,
      `Only if the person said yes: bun erga setup ${a.host} remove ${t} --yes`
    );
  const { cf } = await connect();
  const acc = `/accounts/${own.account ?? (await cf.call<{ id: string }[]>("GET", "/accounts", "list your accounts"))?.[0]?.id}`;
  const step = async (what: string, f: () => Promise<unknown>) => {
    try {
      await f();
      pass(what);
    } catch (e) {
      say(`SKIP  ${what}: ${(e as Error).message}`);
    }
  };
  const domains =
    (await cf
      .call<{ id: string; hostname: string; service: string }[]>("GET", `${acc}/workers/domains?hostname=${host}`, "read custom domains")
      .catch(() => [])) ?? [];
  for (const d of domains.filter((d) => d.service == n.worker))
    await step(`custom domain ${host} removed`, () => cf.call("DELETE", `${acc}/workers/domains/${d.id}`, "remove the custom domain"));
  await step(`Worker ${n.pagesWorker} deleted`, () =>
    cf.call("DELETE", `${acc}/workers/scripts/${n.pagesWorker}?force=true`, "delete the pages Worker", undefined, { allow404: true })
  );
  await step(`Worker ${n.worker} deleted`, () =>
    cf.call("DELETE", `${acc}/workers/scripts/${n.worker}?force=true`, "delete the Worker", undefined, { allow404: true })
  );
  const db = await findDatabase(cf, acc, n.database).catch(() => null);
  if (db) await step(`database ${n.database} deleted`, () => cf.call("DELETE", `${acc}/d1/database/${db}`, "delete the database"));
  await step(`bucket ${n.bucket} deleted (only if empty)`, () =>
    cf.call("DELETE", `${acc}/r2/buckets/${n.bucket}`, "delete the bucket", undefined, { allow404: true })
  );
  const s = loadSecrets();
  delete s[host];
  saveSecrets(s);
  say(`NOTE  ${host}'s entry stays in .erga/config.json. Take it out by hand if the server is gone for good.`);
}

/** Deletes an AWS server's stacks and secrets. The bucket stays (the stack retains it): the documents are in it. */
async function removeAws(t: TargetName, yes: boolean) {
  const a = answersOf(loadOwn());
  const { stackOf } = await import("./plan");
  const { awsCli } = await import("../aws/cli");
  const { whereOf } = await import("../aws/setup");
  const { CERT_REGION, stackState } = await import("../aws/stack");
  const { paramPath } = await import("../aws/template");
  const name = stackOf(a, t),
    where = whereOf(a);
  if (!yes)
    fail(
      `This deletes ${t} (${a.host}) on AWS: the stack ${name} (the machine, CloudFront, the network, the key), its certificates and its secrets. The bucket stays, with the documents in it.`,
      `Only if the person said yes: bun erga setup ${a.host} remove ${t} --yes`
    );
  const aws = awsCli(where);
  const bucket = (await stackState(aws, name)).outputs.Bucket;
  for (const [w, s] of [
    [where, name],
    [{ ...where, region: CERT_REGION }, `${name}-certs`],
  ] as const) {
    const cli = awsCli(w);
    if (!(await stackState(cli, s)).status) continue;
    await cli("cloudformation", "delete-stack", "--stack-name", s);
    say(`  ${s}: AWS deletes it (CloudFront takes minutes)...`);
    await cli("cloudformation", "wait", "stack-delete-complete", "--stack-name", s);
    pass(`stack ${s} deleted`);
  }
  const params =
    (await aws<{ Parameters: { Name: string }[] }>("ssm", "get-parameters-by-path", "--path", paramPath(name)).catch(() => null))
      ?.Parameters ?? [];
  for (const p of params) await aws("ssm", "delete-parameter", "--name", p.Name);
  if (params.length) pass(`${params.length} secrets deleted from Parameter Store`);
  if (bucket)
    say(
      `NOTE  The bucket ${bucket} stays, with the documents. Delete it by hand if they are gone for good: aws s3 rb s3://${bucket} --force`
    );
  say(`NOTE  ${a.host}'s entry stays in .erga/config.json. Take it out by hand if the server is gone for good.`);
}

const targetArg = (v: string | undefined): TargetName =>
  v == "staging"
    ? "staging"
    : v == undefined || v == "production"
      ? "production"
      : fail(`No server called ${v}.`, "production or staging.");

const usage = (code: number): never => {
  say(
    readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .filter((l, i, all) => i < all.findIndex((x) => !x.startsWith("//")))
      .map((l) => l.slice(3))
      .join("\n")
  );
  process.exit(code);
};

/** `bun erga setup <host> [<command> ...]`, or `bun erga setup skill`. */
export async function setupMain(all: string[]) {
  // --home <domain> goes with the first deploy, whatever its place.
  const at = all.indexOf("--home");
  const homeDomain = at >= 0 ? all[at + 1] : undefined;
  if (at >= 0 && !homeDomain) fail("--home needs a domain.", "bun erga setup <host> --home example.com");
  const argv = at >= 0 ? all.filter((_, i) => i != at && i != at + 1) : all;
  const [first, cmd, ...rest] = argv;
  if (first == "skill") return say(SETUP_SKILL);
  if (!first || first == "help" || first == "--help" || first == "-h") return usage(0);
  const { originOf } = await import("../cli/config");
  const host = new URL(originOf(first)).host;
  const parsed = parseAnswer("host", host);
  if ("problem" in parsed) fail(parsed.problem, "bun erga setup <host>: the new server's address, e.g. erga.example.com.");
  const flag = (f: string) => rest.includes(f) || cmd == f;
  const opt = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const plain = rest.filter((x, i) => !x.startsWith("--") && !rest[i - 1]?.startsWith("--from-file") && !rest[i - 1]?.startsWith("--port"));
  setHost(host);
  try {
    switch (cmd) {
      case undefined:
      case "--no-tests":
        await run(flag("--no-tests"), homeDomain);
        break;
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
        if ("host" in pairs) fail("The host is the command's: bun erga setup <host> ...", `bun erga setup ${pairs.host} status`);
        const problems = setAnswers(pairs);
        for (const p of problems) say(`FAIL  ${p}`);
        const a = answersOf(loadOwn());
        if (!problems.length) pass(`Recorded. ${summary(a)}`);
        say(`NEXT  bun erga setup ${host} status`);
        process.exit(problems.length ? 1 : 0);
        break;
      }
      case "start": {
        const { startPage } = await import("./page");
        await startPage(Number(opt("--port")) || 4801, flag("--open"));
        break;
      }
      case "signin":
        signin(plain[0] ?? "", opt("--from-file"));
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
      case "inbox":
        await inbox(flag("--wait"));
        break;
      case "say":
        addMessage("agent", plain.join(" "));
        pass("Sent to the Setup tab of the ops page.");
        break;
      case "remove":
        await remove(targetArg(plain[0]), flag("--yes"));
        break;
      case "stack":
        await stack(flag("--yes"));
        break;
      default:
        say(`No setup command ${cmd}.`);
        usage(2);
    }
  } catch (e) {
    fail((e as Error).message, `Read the error above; bun erga setup ${host} status shows where things are.`);
  }
}
