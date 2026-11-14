// A new Erga instance, set up by a person with their coding agent: `bun erga setup <host>` (deploy/cli/main.ts). This
// command does all the work, and owns the flow's state (deploy/own/flow.ts): it observes, steps the flow, and does
// the effect. The agent only runs it, asks the person each question it prints (ASK), and gives the answer back (the
// THEN line). It never makes a resource, sees a secret or makes a token.
//
//   bun erga setup skill                       the agent's manual
//   bun erga setup <host> [--no-tests] [--no-open] [--staging-of <primary>] [--commit <ref>]
//                                              opens the setup page (the ops page's Setup tab), then goes on from where
//                                              the setup is: it runs the logins, the build and the first deploy; it prints
//                                              one question for the person and ends; or it waits, until the person's step
//                                              on the page is done, and goes on by itself. --staging-of: the new instance
//                                              is a staging instance of a registered one on Cloudflare
//                                              --commit <ref>: deploys that commit, not origin/main; main never moves
//   bun erga setup <host> set key=value ...    records the person's answer, and prints what comes next
//   bun erga setup <host> remove --yes         deletes the server: its Workers, database and bucket (AWS: its stacks
//                                              and secrets; the bucket stays, with the data)
//
// Trap: nothing here prints a secret, or a link that signs someone in. The admin's link is the setup page's alone
// (page.ts, /setup/claim): the agent reads this command's output.

import { spawn } from "node:child_process";
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { entryOf, isAws, originOf, readConfig } from "../cli/config";
import { findDatabase } from "../pipeline/account";
import { fail, pass, ROOT, say } from "../root";
import { checkSignIn, cloudflare, type Connection, observe, site } from "./facts";
import { firstDeploy, register, secretsFor } from "./first";
import { type Effect, partsAfter, progress, stepsOf } from "./flow";
import { type Answers, parseAnswer, planKey, sso } from "./plan";
import { SETUP_SKILL } from "./skill";
import { DIR, loadSecrets, loadSetup, namesAt, newSetup, saveSecrets, saveSetup, type Setup, stepSetup, updateSetup } from "./store";

/** How long one run waits for the person: under the ten minutes that an agent's command may take. */
const WAIT_MS = 8 * 60_000;

const appName = (s: Setup) => s.github?.slug || s.github?.clientId || "";

/** The setup of `host`: the one in progress, or a new one (another host's setup ends: its server and secrets stay). */
function open(host: string): Setup {
  const had = loadSetup();
  if (had?.flow.answers.host == host) return had;
  if (had) say(`NOTE  The setup of ${had.flow.answers.host} was in progress: this setup, of ${host}, takes its place.`);
  const setup = newSetup(host);
  saveSetup(setup);
  return setup;
}

/** Observes, and steps the flow with what was seen, until the flow asks for no other look. */
async function look(): Promise<{ setup: Setup; effect: Effect }> {
  for (;;) {
    const r = stepSetup([{ type: "seen", seen: await observe(loadSetup()!) }]);
    if (r.effect.do != "look") return r;
  }
}

/**
 * The ops page at the setup's tab: one that runs already (.erga/page.port), or a new one, in a process of its own. It
 * opens in the browser when the setup or the page is new (`show`).
 */
async function page(host: string, show: boolean, fresh: boolean): Promise<string> {
  const port = () => {
    try {
      return Number(readFileSync(join(DIR, "page.port"), "utf8")) || 0;
    } catch {
      return 0;
    }
  };
  const runs = (p: number) =>
    p > 0 &&
    fetch(`http://127.0.0.1:${p}/view`, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.ok,
      () => false
    );
  const was = port();
  const started = !(await runs(was));
  if (started) {
    // No tests' queue: the person sets up a server, and merges no branch.
    spawn(process.execPath, [join(ROOT, "deploy/cli/main.ts"), "--no-open", "--no-queue"], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    }).unref();
    // The new page writes its port when it listens.
    const until = Date.now() + 15_000;
    while ((port() == was || !(await runs(port()))) && Date.now() < until) await Bun.sleep(200);
    if (!(await runs(port()))) fail("The setup page did not start.", "Run bun erga in another terminal, then this command again.");
  }
  const url = `http://127.0.0.1:${port()}/#${encodeURIComponent(host)}/setup`;
  if (show && (fresh || started))
    Bun.spawn([process.platform == "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  return url;
}

/** Ends when a file of .erga/ changes (the page recorded the person's step), or after `ms`. */
const changed = (ms: number) =>
  new Promise<void>((done) => {
    const end = () => {
      w.close();
      clearTimeout(t);
      done();
    };
    const w = watch(DIR, end);
    const t = setTimeout(end, Math.max(0, ms));
  });

const printAsk = (e: Extract<Effect, { do: "ask" }>) => {
  e.text.forEach((l, i) => say(`${i ? "      " : "ASK   "}${l}`));
  e.answer.forEach((l, i) => say(`${i ? "      " : "THEN  "}${l}`));
};

/** The Cloudflare API and the servers, or a FAIL. */
const connect = async (): Promise<Connection> => {
  const c = await cloudflare();
  return "why" in c ? fail(c.why, "bunx cf auth login") : c;
};

/** The host's own login, which the person finishes in the browser. */
function login(a: Answers) {
  if (a.where == "aws") {
    say(`WAIT  An AWS sign-in tab opens. The person signs in there. (aws sso login --profile ${a.profile})`);
    Bun.spawnSync(["aws", "sso", "login", "--profile", a.profile], { stdio: ["ignore", "inherit", "inherit"], timeout: WAIT_MS });
  } else {
    say("WAIT  A Cloudflare tab opens. The person signs in there, then clicks Allow. (bunx cf auth login)");
    Bun.spawnSync(["bunx", "cf", "auth", "login"], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], timeout: WAIT_MS });
  }
}

/** The build: the stack (AWS), the first deploy with its secrets, the first rows, and the sign-in's check. Each part shows on the page. */
async function build(setup: Setup, noTests: boolean, commit: string | undefined) {
  const { answers: a, seen } = setup.flow;
  let parts = updateSetup((s) => ({ ...s, build: { parts: [], failed: "" } }))!.build.parts;
  const print = (line: string) => {
    say(`  ${line.slice(0, 200)}`);
    const next = partsAfter(parts, line, Date.now());
    if (next != parts) updateSetup((s) => ({ ...s, build: { ...s.build, parts: (parts = next) } }));
  };
  const github = setup.github?.clientId;
  const started = Date.now();
  try {
    let net = site as Connection["net"];
    if (a.where == "aws") {
      const { applyStacks, firstDeployAws } = await import("../aws/setup");
      const applied = { ...setup.applied };
      const outputs = await applyStacks(DIR, a, applied, print).finally(() => updateSetup((s) => ({ ...s, applied })));
      await firstDeployAws({
        dir: DIR,
        answers: a,
        account: seen.account,
        outputs,
        github,
        secrets: secretsFor(DIR, a, seen.held),
        net,
        noTests,
        commit,
        print,
      });
    } else {
      const c = await connect();
      net = c.net;
      await firstDeploy({ dir: DIR, answers: a, seen, github, net, token: c.token, noTests, commit, print });
    }
    print("Check the sign-in...");
    const check = await checkSignIn(net, a, github);
    if (check != "ok") throw new Error(`Sign-in does not work yet: ${check ? check.bad : `https://${a.host} did not answer`}.`);
    print("Check the sign-in: done");
    pass(`Deployed ${a.host} in ${Math.round((Date.now() - started) / 1000)} s.`);
  } catch (e) {
    updateSetup((s) => ({ ...s, build: { ...s.build, failed: (e as Error).message } }));
    fail(
      (e as Error).message,
      `Fix what it names (the person decides anything about the account), then: bun erga setup ${a.host}. Every step is safe to run again.`
    );
  }
}

/** The admin's step: the server asks for the ops token, the page's link carries its code, and this waits for the person. */
async function admin(a: Answers, until: number): Promise<boolean> {
  const net = a.where == "aws" ? site : (await connect()).net;
  const approved = register(DIR, a.host, { site: net, asked: (code) => void updateSetup((s) => ({ ...s, approve: code })) });
  const who = await Promise.race([approved, Bun.sleep(Math.max(0, until - Date.now())).then(() => null)]).catch((e: Error) =>
    fail(e.message, `bun erga setup ${a.host}: the page gets a new link.`)
  );
  if (!who) return false;
  updateSetup((s) => ({ ...s, approve: "", flow: { ...s.flow, seen: { ...s.flow.seen, admin: who } } }));
  return true;
}

/**
 * `bun erga setup <host>`: from where the setup is, each effect of the flow, until a question for the person (it ends:
 * the agent asks), the end of the wait for the person's step on the page, or the end of the setup.
 */
async function run(host: string, o: { noTests: boolean; show: boolean; fresh: boolean; commit?: string }) {
  open(host);
  say(`PAGE  ${await page(host, o.show, o.fresh)}`);
  const until = Date.now() + WAIT_MS;
  const did = new Set<string>();
  let said = "";
  for (;;) {
    const { setup, effect } = await look();
    const { answers: a, state } = setup.flow;
    const where = progress(stepsOf(setup.flow, appName(setup)));
    if (where != said) say((said = where));
    // AWS: the review shows the stack's resources, from the templates of the answers.
    if (a.where == "aws" && state.at == "review" && setup.planned != planKey(a)) {
      const { writePlan } = await import("../aws/setup");
      const files = await writePlan(DIR, a).catch((e: Error) =>
        fail(e.message, `Fix the answer that it names: bun erga setup ${host} set <key>=<value>`)
      );
      updateSetup((s) => ({ ...s, planned: planKey(a) }));
      say(`  Wrote the stack's template${files.length > 1 ? "s" : ""}: ${files.join(", ")}`);
      continue;
    }
    const key = effect.do == "wait" ? effect.text : effect.do;
    const again = did.has(key);
    did.add(key);
    switch (effect.do) {
      case "ask":
        return printAsk(effect);
      case "stop":
        return fail(effect.text);
      case "done":
        pass(`${setup.flow.seen.admin} is the admin of https://${host}. The page is connected for deploys.`);
        say(
          "DONE  Tell the person: the address; that .erga/secrets.json in this folder holds the server's secrets (keep a copy in a password manager, and share it with no one); and that Settings has the rest: Google sign-in, a feedback repository, the homepage."
        );
        return;
      case "login":
        if (again)
          return fail(
            setup.flow.seen.login?.ok == false ? setup.flow.seen.login.why : "The login did not finish.",
            `bun erga setup ${host}`
          );
        login(a);
        break;
      case "build":
        if (again) return fail(`${host} is deployed, but the setup does not see it healthy yet.`, `bun erga setup ${host}`);
        await build(setup, o.noTests, o.commit);
        break;
      case "wait": {
        if (!again) say(`WAIT  ${effect.text}`);
        // A look again each 20 s too: a step that ended between the look and the watch is not lost.
        const went =
          Date.now() < until &&
          (state.at == "admin" ? await admin(a, until) : (await changed(Math.min(20_000, until - Date.now())), Date.now() < until));
        if (!went) return say(`WAIT  The person's step is still open. Run this command again: bun erga setup ${host}`);
        break;
      }
    }
  }
}

/** `set key=value ...`: each answer into the flow, then what comes next (without doing it). */
async function set(host: string, pairs: [string, string][]) {
  open(host);
  const keys = Object.keys(newSetup(host).flow.answers);
  const unknown = pairs.filter(([k]) => !keys.includes(k) || k == "host" || k == "stagingOf" || k == "aud");
  for (const [k] of unknown) say(`FAIL  ${k} isn't an answer of the setup.`);
  const sent = stepSetup(
    pairs.filter((p) => !unknown.includes(p)).map(([key, value]) => ({ type: "set", key: key as keyof Answers, value }))
  );
  for (const p of sent.problems) say(`FAIL  ${p}`);
  const { setup, effect } = await look();
  if (!sent.problems.length && !unknown.length) pass("Recorded.");
  say(progress(stepsOf(setup.flow, appName(setup))));
  if (effect.do == "ask" && !(setup.flow.answers.where == "aws" && setup.flow.state.at == "review")) printAsk(effect);
  else say(`NEXT  bun erga setup ${host}`);
  if (sent.problems.length || unknown.length) process.exit(1);
}

/** --staging-of: the new instance takes its primary's host, account and sign-in. Asked one time, before the first answer. */
function stagingOf(host: string, primary: string) {
  const e = entryOf(readConfig(DIR), new URL(originOf(primary)).host);
  if (!e || isAws(e) || e.stagingOf)
    return fail(
      `${primary} is not a registered primary on Cloudflare in .erga/config.json.`,
      `bun erga register ${primary}, then this command again.`
    );
  const proxy = e.vars.PROXY_SIGN_IN ? (JSON.parse(e.vars.PROXY_SIGN_IN) as { team?: string }) : null;
  const setup = newSetup(host);
  saveSetup({
    ...setup,
    flow: {
      ...setup.flow,
      answers: {
        ...setup.flow.answers,
        stagingOf: e.host,
        where: "cloudflare",
        account: e.account,
        signIn: proxy ? "sso" : "invite",
        team: proxy?.team ?? "",
      },
    },
  });
}

async function remove(host: string, yes: boolean) {
  const entry = entryOf(readConfig(DIR), host);
  const a = loadSetup()?.flow.answers;
  const only = `Only if the person said yes: bun erga setup ${host} remove --yes`;
  if (entry ? isAws(entry) : a?.host == host && a.where == "aws") {
    if (a?.host != host)
      return fail(`The setup of ${host} is not in .erga/setup.json any more.`, "Delete its stacks in the CloudFormation console.");
    const { stackOf } = await import("./plan");
    const { awsCli } = await import("../aws/cli");
    const { whereOf } = await import("../aws/setup");
    const { CERT_REGION, stackState } = await import("../aws/stack");
    const { oidcSecretName, paramPath } = await import("../aws/template");
    const name = stackOf(a),
      where = whereOf(a);
    if (!yes)
      fail(
        `This deletes ${host} on AWS: the stack ${name} (the machine, the addresses, the network, the key), its certificates and its secrets. The bucket stays, with the documents in it.`,
        only
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
      say(`  ${s}: AWS deletes it (it takes minutes)...`);
      await cli("cloudformation", "wait", "stack-delete-complete", "--stack-name", s);
      pass(`stack ${s} deleted`);
    }
    const params =
      (await aws<{ Parameters: { Name: string }[] }>("ssm", "get-parameters-by-path", "--path", paramPath(name)).catch(() => null))
        ?.Parameters ?? [];
    for (const p of params) await aws("ssm", "delete-parameter", "--name", p.Name);
    if (params.length) pass(`${params.length} secrets deleted from Parameter Store`);
    if (sso(a))
      await aws("secretsmanager", "delete-secret", "--secret-id", oidcSecretName(name), "--force-delete-without-recovery").then(
        () => pass("the sign-in's client secret deleted from Secrets Manager"),
        () => {}
      );
    if (bucket)
      say(
        `NOTE  The bucket ${bucket} stays, with the documents. Delete it by hand if they are gone for good: aws s3 rb s3://${bucket} --force`
      );
  } else {
    const n = namesAt(host);
    if (!yes)
      fail(
        `This deletes ${host}: the Workers ${n.worker} and ${n.pagesWorker}, the database ${n.database} and the bucket ${n.bucket}, with every document on it.`,
        only
      );
    const { cf } = await connect();
    const account = (entry && !isAws(entry) ? entry.account : a?.host == host ? a.account : "") || fail(`No account is known for ${host}.`);
    const acc = `/accounts/${account}`;
    const part = async (what: string, f: () => Promise<unknown>) =>
      f().then(
        () => pass(what),
        (e: Error) => say(`SKIP  ${what}: ${e.message}`)
      );
    const domains =
      (await cf
        .call<{ id: string; hostname: string; service: string }[]>("GET", `${acc}/workers/domains?hostname=${host}`, "read custom domains")
        .catch(() => [])) ?? [];
    for (const d of domains.filter((d) => d.service == n.worker))
      await part(`custom domain ${host} removed`, () => cf.call("DELETE", `${acc}/workers/domains/${d.id}`, "remove the custom domain"));
    for (const w of [n.pagesWorker, n.worker])
      await part(`Worker ${w} deleted`, () =>
        cf.call("DELETE", `${acc}/workers/scripts/${w}?force=true`, "delete the Worker", undefined, { allow404: true })
      );
    const db = await findDatabase(cf, acc, n.database).catch(() => null);
    if (db) await part(`database ${n.database} deleted`, () => cf.call("DELETE", `${acc}/d1/database/${db}`, "delete the database"));
    await part(`bucket ${n.bucket} deleted (only if empty)`, () =>
      cf.call("DELETE", `${acc}/r2/buckets/${n.bucket}`, "delete the bucket", undefined, { allow404: true })
    );
  }
  const secrets = loadSecrets();
  delete secrets[host];
  saveSecrets(secrets);
  say(`NOTE  ${host}'s entry stays in .erga/config.json. Take it out by hand if the server is gone for good.`);
}

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
export async function setupMain(argv: string[]) {
  const [first, ...rest] = argv;
  if (first == "skill") return say(SETUP_SKILL);
  if (!first || first == "help" || first == "--help" || first == "-h") return usage(0);
  const parsed = parseAnswer("host", new URL(originOf(first)).host);
  if ("problem" in parsed) return fail(parsed.problem, "bun erga setup <host>: the new server's address, e.g. erga.example.com.");
  const host = parsed.value;
  const flag = (f: string) => rest.includes(f);
  const opt = (f: string) => (flag(f) ? rest[rest.indexOf(f) + 1] : undefined);
  const primary = opt("--staging-of");
  const plain = rest.filter((x, i) => !x.startsWith("--") && rest[i - 1] != "--staging-of" && rest[i - 1] != "--commit");
  try {
    const fresh = loadSetup()?.flow.answers.host != host;
    if (primary && fresh) stagingOf(host, primary);
    if (!plain.length) await run(host, { noTests: flag("--no-tests"), show: !flag("--no-open"), fresh, commit: opt("--commit") });
    else if (plain[0] == "set")
      await set(
        host,
        plain.slice(1).map((p): [string, string] => {
          const i = p.indexOf("=");
          return i > 0 ? [p.slice(0, i), p.slice(i + 1)] : [p, ""];
        })
      );
    else if (plain[0] == "remove") await remove(host, flag("--yes"));
    else {
      say(`No setup command ${plain[0]}.`);
      usage(2);
    }
  } catch (e) {
    fail((e as Error).message, `bun erga setup ${host}`);
  }
}
