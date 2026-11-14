// A new Erga instance, set up by a person with their coding agent: `bun erga setup <host>` (deploy/cli/main.ts). The
// agent asks the person every question first (README.md, Setup), then runs this command with each answer as an option:
// first with --dry-run (the checks and the plan; nothing is made), then, after the person's yes, without it. The
// command does all the work: it signs in, makes the GitHub App, builds, and makes the person the admin. It opens the
// browser only for the person's own steps, and waits for each. The agent never makes a resource, sees a secret or
// makes a token.
//
//   bun erga setup <host> --host cloudflare|aws --sign-in invite|company|sso [<options>] [--dry-run]
//       --staging <address>    a staging instance too, on a copy of the data, for admins only (Cloudflare only).
//                              On a registered instance it makes only the staging instance.
//       --account <name|id>    Cloudflare: the account, when two hold the domain
//       --profile <name>       AWS: the AWS CLI's profile, when there are several (the region is the profile's)
//       --company <org|domain> --sign-in company: a GitHub organization, or an email domain
//       --team <name> --aud <tag>        --sign-in sso on Cloudflare: Cloudflare Access
//       --issuer <URL> --client <ID>     --sign-in sso on AWS: the company's sign-in (OpenID Connect)
//       --pages <domain>       AWS without single sign-on: a second Route 53 domain, for the documents' pages
//       --egress <way>         AWS: nat-instance (the default), nat-gateway, or <vpc id>/<private subnet id>
//       --commit <ref>         deploys that commit, not origin/main; main never moves
//       --no-tests             the build runs no tests
//   bun erga setup <host> remove --yes       deletes the server: its Workers, database and bucket (AWS: its stacks
//                                            and secrets; the bucket stays, with the data)
//
// Each run ends in one of these lines: DRY RUN (the plan), DONE, WAIT (the person's step is still open: run the same
// command again) or FAIL (what is wrong, and what to do). A run again goes on from where the last one stopped.
//
// Trap: nothing here prints a secret, or a link that signs someone in: the agent reads this command's output. The
// admin's link goes to the browser only.

import { readFileSync } from "node:fs";
import { Claim } from "../../server/identity/claim";
import { entryOf, isAws, originOf, readConfig } from "../cli/config";
import { findDatabase } from "../pipeline/account";
import { fail, pass, ROOT, say } from "../root";
import { githubApp, oidcSecret, openBrowser } from "./browser";
import { checkSignIn, cloudflare, type Connection, observe, site } from "./facts";
import { firstDeploy, register, secretsFor } from "./first";
import { checksOf, missing, planText, type Seen, type State, stagingOf, step } from "./flow";
import { type Answers, noAnswers, parseAnswer } from "./plan";
import { DIR, githubIdOf, loadSecrets, namesAt, saveSecrets } from "./store";

/** How long one run waits for the person: under the ten minutes that an agent's command may take. */
const WAIT_MS = 8 * 60_000;

/** The options that are answers, by the answer's key. */
const OPTIONS: Record<string, keyof Answers> = {
  "--host": "where",
  "--sign-in": "signIn",
  "--staging": "staging",
  "--account": "account",
  "--profile": "profile",
  "--company": "company",
  "--team": "team",
  "--aud": "aud",
  "--issuer": "issuer",
  "--client": "client",
  "--pages": "pages",
  "--egress": "egress",
};
const FLAGS = ["--dry-run", "--no-tests", "--yes"];

interface Run {
  dryRun: boolean;
  noTests: boolean;
  commit?: string;
  /** The command again, for the lines that say to run it. */
  again: string;
}

/** Observes, and folds what was seen in, until the code finds nothing more to fill. */
async function look(a: Answers): Promise<{ answers: Answers; seen: Seen; state: State }> {
  for (;;) {
    const seen = await observe(a);
    const r = step(a, seen);
    a = r.answers;
    if (!r.look) return { answers: a, seen, state: r.state };
  }
}

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

/** The build: the stack (AWS), the first deploy with its secrets, the first rows, and the sign-in's check. */
async function build(a: Answers, seen: Seen, o: Run) {
  const print = (line: string) => say(`  ${line.slice(0, 200)}`);
  const github = githubIdOf(a.host) || undefined;
  const started = Date.now();
  try {
    let net = site as Connection["net"];
    if (a.where == "aws") {
      const { applyStacks, firstDeployAws, writePlan } = await import("../aws/setup");
      await writePlan(DIR, a);
      const outputs = await applyStacks(DIR, a, print);
      await firstDeployAws({
        dir: DIR,
        answers: a,
        account: seen.account,
        outputs,
        github,
        secrets: secretsFor(DIR, a, seen.held),
        net,
        noTests: o.noTests,
        commit: o.commit,
        print,
      });
    } else {
      const c = await connect();
      net = c.net;
      await firstDeploy({ dir: DIR, answers: a, seen, github, net, token: c.token, noTests: o.noTests, commit: o.commit, print });
    }
    print("Check the sign-in...");
    const check = await checkSignIn(net, a, github);
    if (check != "ok") throw new Error(`Sign-in does not work yet: ${check ? check.bad : `https://${a.host} did not answer`}.`);
    pass(`Deployed ${a.host} in ${Math.round((Date.now() - started) / 1000)} s.`);
  } catch (e) {
    fail(
      (e as Error).message,
      `Fix what it names (the person decides anything about the account), then: ${o.again}. Every step is safe to run again.`
    );
  }
}

/**
 * The admin's step: the server asks for the ops token, and the browser opens the one-time link that carries its code.
 * A new server: the link makes the person its admin as they sign in (server/identity/claim.ts). A staging instance
 * has its primary's people: an admin approves. The result: the person's login, or "" when the wait ended first.
 */
async function admin(a: Answers, o: Run): Promise<string> {
  const net = a.where == "aws" ? site : (await connect()).net;
  const secret = a.stagingOf ? "" : loadSecrets(DIR)[a.host]?.SESSION_SECRET;
  const opened = async (code: string) => {
    const to = secret
      ? `https://${a.host}/auth/claim?t=${encodeURIComponent(await Claim.seal(secret, {}))}&approve=${encodeURIComponent(code)}`
      : `https://${a.host}/tokens/approve?code=${encodeURIComponent(code)}`;
    openBrowser(to);
  };
  say(
    a.stagingOf
      ? `WAIT  A tab opens on ${a.host}. The person approves there, as an admin of ${a.stagingOf}.`
      : `WAIT  A tab opens on ${a.host}, with a link that works one time. The person signs in there, and becomes the admin.`
  );
  const approved = register(DIR, a.host, { site: net, asked: (code) => void opened(code) });
  return Promise.race([approved, Bun.sleep(WAIT_MS).then(() => "")]).catch((e: Error) => fail(e.message, o.again));
}

/** Prints what the dry run found: the checks, and the plan. */
function printPlan(a: Answers, seen: Seen, resources: string[]) {
  for (const c of checksOf(a, seen)) pass(c);
  for (const l of planText(a, seen)) say(`PLAN  ${l}`);
  if (resources.length) say(`PLAN  The stack's resources (${resources.length}): ${resources.join(", ")}`);
}

/**
 * One instance, from where its setup is: each step, until it is done, the person's step is still open (the wait
 * ended), or (a dry run) the first step that would make something.
 */
async function setUp(a: Answers, o: Run): Promise<"done" | "dry" | "wait"> {
  const did = new Set<string>();
  for (;;) {
    const r = await look(a);
    const { seen, state } = r;
    a = r.answers;
    const again = did.has(state.at);
    did.add(state.at);
    if (o.dryRun && (state.at == "app" || state.at == "build" || state.at == "admin")) {
      let resources: string[] = [];
      if (a.where == "aws") {
        await (await import("../aws/setup")).writePlan(DIR, a);
        resources = (await look(a)).seen.stack?.resources ?? [];
      }
      printPlan(a, seen, resources);
      return "dry";
    }
    switch (state.at) {
      case "stop":
        return fail(state.why, `Ask the person, then: ${o.again}`);
      case "login":
        if (again) return fail(state.why ?? "The sign-in did not finish.", o.again);
        login(a);
        break;
      case "app": {
        if (again) return fail("The app step did not finish.", o.again);
        const ended =
          state.kind == "github"
            ? (say("WAIT  A GitHub tab opens. The person clicks Create GitHub App there. Its secret goes to this command, never to you."),
              await githubApp(a, WAIT_MS))
            : (say("WAIT  A page opens. The person types the client secret of the company's sign-in there, and clicks Save."),
              await oidcSecret(a, async (v) => (await import("../aws/setup")).putOidcSecret(a, v), WAIT_MS));
        if (ended == null) return "wait";
        if (ended) return fail(ended, o.again);
        pass(state.kind == "github" ? "GitHub made the app." : "AWS has the client secret.");
        break;
      }
      case "build":
        if (again) return fail(`${a.host} is deployed, but setup does not see it healthy yet.`, o.again);
        await build(a, seen, o);
        break;
      case "admin": {
        if (again) return fail(`${a.host} has no admin yet.`, o.again);
        const who = await admin(a, o);
        if (!who) return "wait";
        pass(`${who} is the admin of https://${a.host}.`);
        break;
      }
      case "done":
        if (o.dryRun) pass(`${a.host} runs already, with an admin.`);
        return o.dryRun ? "dry" : "done";
    }
  }
}

/** `bun erga setup <host> --host ... --sign-in ...`: the instance, then its staging instance. */
async function run(a: Answers, o: Run) {
  const need = missing(a);
  if (need.length)
    return fail(`The command needs: ${need.join(" ")}`, "Ask the person what the README's setup asks, then run the command again.");
  const end = await setUp(a, o);
  if (end == "wait") return say(`WAIT  The person's step is still open. Run the same command again: ${o.again}`);
  if (a.staging) {
    const primary = entryOf(readConfig(DIR), a.host);
    const s = stagingOf({ ...a, account: primary && !isAws(primary) ? primary.account : a.account });
    // The staging instance shares the GitHub App when it was made with both addresses; else it makes one of its own.
    const sEnd = await setUp(s, o);
    if (sEnd == "wait") return say(`WAIT  The person's step is still open. Run the same command again: ${o.again}`);
  }
  if (o.dryRun)
    return say(
      "DRY RUN  Nothing is made. Tell the person the plan, and ask: Shall I make it? On yes, run the same command without --dry-run."
    );
  say(
    `DONE  Tell the person: Erga is live at https://${a.host}${a.staging ? `, and staging at https://${a.staging}` : ""}, and they are the admin. .erga/secrets.json in this folder holds the server's secrets: keep a copy in a password manager, and share it with no one. Later deploys: bun erga (the ops page). Settings has the rest: Google sign-in, a feedback repository, the homepage.`
  );
}

async function remove(host: string, yes: boolean) {
  const entry = entryOf(readConfig(DIR), host);
  const only = `Only if the person said yes: bun erga setup ${host} remove --yes`;
  if (entry && isAws(entry)) {
    const { awsCli } = await import("../aws/cli");
    const { CERT_REGION, stackState } = await import("../aws/stack");
    const { oidcSecretName, paramPath } = await import("../aws/template");
    const name = entry.aws.stack,
      where = { profile: entry.profile, region: entry.aws.region };
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
    if (entry.vars.PROXY_SIGN_IN)
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
    const account = (entry && !isAws(entry) ? entry.account : "") || fail(`${host} has no entry in .erga/config.json.`);
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

/** Reads the options into the answers: the answers, and why each option that isn't one isn't. */
export function readOptions(host: string, args: string[]): { answers: Answers; problems: string[]; rest: string[] } {
  let answers = noAnswers(host);
  const problems: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    const key = OPTIONS[x];
    if (key) {
      const r = parseAnswer(key, args[++i] ?? "");
      if ("problem" in r) problems.push(`${x}: ${r.problem}`);
      else answers = { ...answers, [key]: r.value };
    } else if (x == "--commit") i++;
    else if (x.startsWith("--") && !FLAGS.includes(x)) problems.push(`${x} isn't an option of bun erga setup.`);
    else if (!x.startsWith("--")) rest.push(x);
  }
  return { answers, problems, rest };
}

/** `bun erga setup <host> [<options>]`, or `bun erga setup <host> remove --yes`. */
export async function setupMain(argv: string[]) {
  const [first, ...args] = argv;
  if (!first || first == "help" || first == "--help" || first == "-h") return usage(0);
  const parsed = parseAnswer("host", new URL(originOf(first)).host);
  if ("problem" in parsed) return fail(parsed.problem, "bun erga setup <host>: the new server's address, e.g. erga.example.com.");
  const host = parsed.value;
  const { answers, problems, rest } = readOptions(host, args);
  const flag = (f: string) => args.includes(f);
  try {
    if (rest[0] == "remove") return await remove(host, flag("--yes"));
    if (rest.length) {
      say(`No setup command ${rest[0]}.`);
      return usage(2);
    }
    if (problems.length) return fail(problems.join(" "), "bun erga setup --help lists the options.");
    const commit = flag("--commit") ? args[args.indexOf("--commit") + 1] : undefined;
    const again = ["bun erga setup", host, ...args].join(" ");
    await run(answers, { dryRun: flag("--dry-run"), noTests: flag("--no-tests"), commit, again });
  } catch (e) {
    fail((e as Error).message, `bun erga setup ${host}`);
  }
}
