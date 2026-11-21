// A new Erga instance, set up by a user with their coding agent: `bun erga setup <host>` (deploy/cli/main.ts). The
// agent asks the user every question first (README.md, Setup), then runs this command with each answer as an option:
// first with --dry-run (the checks and the plan; nothing is made), then, after the user's yes, without it. The
// command does all the work: it signs in, makes the GitHub App, builds, and makes the user the admin. It opens the
// browser only for the user's own steps, and waits for each. The agent never makes a resource, sees a secret or
// makes a token.
//
//   bun erga setup <host> --host cloudflare|aws --sign-in invite|organization|sso [<options>] [--dry-run]
//       --repo <repo>          the repository that the instance tracks (default: github.com/koomen/erga)
//       --branch <branch>      the branch of it that the instance tracks (default: main): its first deploy, and each
//                              deploy after, takes that branch's head. bun erga track <host> changes both later.
//       --account <name|id>    Cloudflare: the account, when two hold the domain
//       --profile <name>       AWS: the AWS CLI's profile, when there are several (the region is the profile's)
//       --organization <org|domain>      --sign-in organization: a GitHub organization, or an email domain
//       --team <name> --aud <tag>        --sign-in sso on Cloudflare: Cloudflare Access
//       --issuer <URL> --client <ID>     --sign-in sso on AWS: the organization's sign-in (OpenID Connect)
//       --email-claim <claim>:<prefix>   --sign-in sso on AWS, when the sign-in gives no email claim: where the
//                                        address is, e.g. preferred_username:corp| for "corp|ada@example.com"
//       --sign-in-days <days>            --sign-in sso on AWS: how long a sign-in lasts, from 1 to 90 (default: 30)
//       --pages <domain>       AWS without single sign-on: a second Route 53 domain, for the documents' pages
//       --deploys cloud|local  who deploys each new release. cloud: a deployer in the user's account, by itself. On
//                              Cloudflare the user makes its token (for the instance's Worker only) and pastes it on a
//                              page that opens; on AWS it is a Lambda function whose role is its credential: no token.
//                              local: the user, with bun erga deploy; no credential in the cloud. A run again with
//                              the other answer installs the deployer, or removes it.
//       --egress <way>         AWS: nat-instance (the default), nat-gateway, or <vpc id>/<private subnet id>
//       --no-tests             the build runs no tests
//       --remote               the user is at another computer (on by itself over SSH): no browser opens here. The
//                              user types the client secret in their terminal, and the admin's link shows there.
//   bun erga setup <host> remove --yes       deletes the server: its Workers, database, bucket and the pages' DNS record (AWS: its stacks
//                                            and secrets; the bucket stays, with the data)
//
// Each run ends in one of these lines: DRY RUN (the plan), DONE, WAIT (the user's step is still open: run the same
// command again) or FAIL (what is wrong, and what to do). A run again goes on from where the last one stopped. In a
// clone with no entry for an Erga that runs at the address (another clone set it up), the run first takes it over: it
// writes the entry, as bun erga register does, and goes on from where that instance is. On
// AWS, a run on an instance that is done updates its stacks to this code's template (a deploy changes only the code).
//
// Trap: nothing here prints a secret, or a link that signs someone in: the agent reads this command's output. The
// admin's link goes to the browser only, or with --remote to the user's terminal (/dev/tty), never to stdout.

import { closeSync, readFileSync } from "node:fs";
import { Claim } from "../../server/identity/claim-link";
import { DEFAULT_REPO, entryOf, isAws, originOf, readConfig, repoName } from "../cli/config";
import { fail, pass, ROOT, say } from "../root";
import { askSecret, deployerToken, githubApp, oidcSecret, openBrowser, openTerminal, tellUser } from "./browser";
import { cloudflare, type Connection, observe } from "./facts";
import { adminOn, adoptEntry, firstDeploy, secretsFor } from "./first";
import { accountName, checksOf, deploysText, missing, planText, type Seen, type State, step } from "./flow";
import { type Answers, noAnswers, parseAnswer, type TextAnswer } from "./plan";
import { DIR, githubIdOf, loadSecrets, namesAt, saveSecrets } from "./store";

/** How long one run waits for the user: under the ten minutes that an agent's command may take. */
const WAIT_MS = 8 * 60_000;

/** The options that are answers, by the answer's key. */
const OPTIONS: Record<string, TextAnswer> = {
  "--host": "where",
  "--sign-in": "signIn",
  "--repo": "repo",
  "--branch": "branch",
  "--account": "account",
  "--profile": "profile",
  "--organization": "organization",
  "--team": "team",
  "--aud": "aud",
  "--issuer": "issuer",
  "--client": "client",
  "--email-claim": "emailClaim",
  "--sign-in-days": "signInDays",
  "--pages": "pages",
  "--egress": "egress",
  "--deploys": "deploys",
};
const FLAGS = ["--dry-run", "--no-tests", "--yes", "--remote"];

interface Run {
  dryRun: boolean;
  noTests: boolean;
  /** The command again, for the lines that say to run it. */
  again: string;
}

/** --remote: the loopback page's address, on the user's terminal, with the port forward that brings it to their computer. */
const forwarded = (url: string) => {
  const port = new URL(url).port;
  tellUser(`Open ${url} in your browser. At another computer, first forward its port: ssh -L ${port}:127.0.0.1:${port} <this machine>`);
};

/** Observes, and folds what was seen in, until the code finds nothing more to fill. */
async function look(a: Answers): Promise<{ answers: Answers; seen: Seen; state: State }> {
  for (;;) {
    const seen = { ...(await observe(a)), terminal: a.remote && hasTerminal() };
    const r = step(a, seen);
    a = r.answers;
    if (!r.look) return { answers: a, seen, state: r.state };
  }
}

const hasTerminal = () => {
  const tty = openTerminal();
  if (tty != null) closeSync(tty);
  return tty != null;
};

/** --remote: the user types the client secret in their terminal, and AWS keeps it. "": done; else a failure. */
async function oidcInTerminal(a: Answers): Promise<string> {
  const { putOidcSecret } = await import("../aws/setup");
  for (;;) {
    const secret = askSecret(`The client secret of Erga's client ${a.client} at ${a.issuer} (it does not show as you type):`);
    if (secret == null) return "The prompt in the terminal ended.";
    if (!secret) continue;
    await putOidcSecret(a, secret);
    return "";
  }
}

/**
 * Cloud deploys on Cloudflare: the user gives the deployer's token (on a page; --remote: in their terminal), the
 * command checks it and installs the deployer with it, and turns auto-deploy on. The result: "" (done), a failure, or
 * null (the wait ended). The token goes to Cloudflare only: this command prints none of it.
 */
async function installWithToken(a: Answers): Promise<string | null> {
  const c = await connect();
  const { installWithToken: install } = await import("../pipeline/deployer");
  const target = { account: a.account, worker: namesAt(a.host).worker };
  const take = async (token: string) => {
    const unconfirmed = await install(c.net, c.cf, target, token);
    for (const u of unconfirmed) say(`NOTE  Erga could not confirm about the token: ${u}`);
    return unconfirmed;
  };
  if (!a.remote) return deployerToken({ ...target, take }, WAIT_MS);
  for (;;) {
    const token = askSecret(
      `A token for the deployer: on Cloudflare (Manage account, Account API tokens, Create Token), with one permission: Workers, for the Worker ${target.worker} only, with the role Editor. Paste it here (it does not show):`
    );
    if (token == null) return "The prompt in the terminal ended.";
    if (!token) continue;
    const refused = await take(token).then(
      () => "",
      (e: Error) => e.message
    );
    if (!refused) return "";
    // Not always the token's fault (the user's own login, or Cloudflare): the reason says which.
    tellUser(`The deployer is not installed:\n${refused}`);
  }
}

/** The instance's entry on AWS, from the answers and what its stack has now: the deployer's install names these. */
async function awsEntryOf(a: Answers, seen: Seen) {
  const { awsEntry } = await import("../aws/setup");
  if (!seen.stack?.outputs.Machine) return fail(`The stack of ${a.host} has no machine: setup has not made the instance yet.`);
  return awsEntry(a, seen.account, seen.stack.outputs, githubIdOf(a.host, DIR) || undefined);
}

/** The Cloudflare API and the servers, or a FAIL. */
const connect = async (): Promise<Connection> => {
  const c = await cloudflare();
  return "why" in c ? fail(c.why, "bunx cf auth login") : c;
};

/** The host's own login, which the user finishes in the browser. --remote: its link shows on their terminal. */
function login(a: Answers) {
  const tty = a.remote ? openTerminal() : null;
  const out = tty ?? "inherit";
  const where = a.remote ? "Its link shows on the user's terminal" : "A tab opens";
  try {
    if (a.where == "aws") {
      say(`WAIT  ${where}: AWS sign-in. The user signs in there. (aws sso login --profile ${a.profile})`);
      Bun.spawnSync(["aws", "sso", "login", "--profile", a.profile, ...(a.remote ? ["--no-browser"] : [])], {
        stdio: ["ignore", out, out],
        timeout: WAIT_MS,
      });
    } else {
      say(`WAIT  ${where}: Cloudflare. The user signs in there, then clicks Allow. (bunx cf auth login)`);
      Bun.spawnSync(["bunx", "cf", "auth", "login"], { cwd: ROOT, stdio: ["ignore", out, out], timeout: WAIT_MS });
    }
  } finally {
    if (tty != null) closeSync(tty);
  }
}

/** The build: the stack (AWS), the first deploy with its secrets, and the first rows. The next look sees its health and its sign-in settings. */
async function build(a: Answers, seen: Seen, o: Run) {
  const print = (line: string) => say(`  ${line.slice(0, 200)}`);
  const github = githubIdOf(a.host) || undefined;
  const started = Date.now();
  try {
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
        noTests: o.noTests,
        print,
      });
    } else {
      const c = await connect();
      await firstDeploy({ dir: DIR, answers: a, seen, github, net: c.net, token: c.token, noTests: o.noTests, print });
    }
    pass(`Deployed ${a.host} in ${Math.round((Date.now() - started) / 1000)} s.`);
  } catch (e) {
    fail(
      (e as Error).message,
      `Fix what it names (the user decides anything about the account), then: ${o.again}. Every step is safe to run again.`
    );
  }
}

/**
 * The admin's step: the browser opens the one-time link, and the user signs in there: they become the server's admin
 * (server/identity/claim.ts). Setup then sees the admin in the database, which it reads through the platform (the
 * Cloudflare D1 API; on AWS, the machine): it asks the server nothing. The result: the admin's login, or "" when the
 * wait ended first.
 */
async function admin(a: Answers, o: Run): Promise<string> {
  const secret = loadSecrets(DIR)[a.host]?.SESSION_SECRET;
  if (!secret)
    return fail(
      `This machine does not hold the SESSION_SECRET of ${a.host} (.erga/secrets.json), so it can't make the admin's link.`,
      `Run the command on the machine that set ${a.host} up: ${o.again}`
    );
  const entry = entryOf(readConfig(DIR), a.host);
  if (!entry) return fail(`${a.host} has no entry in .erga/config.json yet: its first deploy writes it.`, o.again);
  let found: () => Promise<string | null>;
  if (isAws(entry)) {
    const { awsCli } = await import("../aws/cli");
    const { adminOnAws } = await import("../aws/setup");
    const aws = awsCli({ profile: entry.profile, region: entry.aws.region });
    found = () => adminOnAws(aws, entry.aws);
  } else {
    const { cf } = await connect();
    found = () => adminOn(cf, `/accounts/${entry.account}`, entry.worker);
  }
  const to = `https://${a.host}/auth/claim?t=${encodeURIComponent(await Claim.seal(secret, {}))}`;
  if (a.remote) tellUser(`Open this link in your browser. It works one time; never give it to your agent.\n${to}`);
  else openBrowser(to);
  say(
    a.remote
      ? `WAIT  The user's terminal shows a link to ${a.host}. The user opens it in their browser, and signs in there: they become the admin.`
      : `WAIT  A tab opens on ${a.host}, with a link that works one time. The user signs in there, and becomes the admin.`
  );
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await Bun.sleep(isAws(entry) ? 10_000 : 3000);
    const who = await found().catch((e: Error) => fail(e.message, o.again));
    if (who) return who;
  }
  return "";
}

/** Prints what the dry run found: the checks, and the plan. */
function printPlan(a: Answers, seen: Seen, resources: string[]) {
  for (const c of checksOf(a, seen)) pass(c);
  for (const l of planText(a, seen)) say(`PLAN  ${l}`);
  if (resources.length) say(`PLAN  The stack's resources (${resources.length}): ${resources.join(", ")}`);
}

/**
 * One instance, from where its setup is: each step, until it is done, the user's step is still open (the wait
 * ended), or (a dry run) the first step that would make something.
 */
async function setUp(a: Answers, o: Run): Promise<"done" | "dry" | "wait"> {
  const did = new Set<string>();
  for (;;) {
    const r = await look(a);
    const { seen } = r;
    let state = r.state;
    a = r.answers;
    const again = did.has(state.at);
    did.add(state.at);
    // The instance's Worker: its entry's, or the Worker that setup takes over.
    const worker = seen.adopt ?? namesAt(a.host).worker;
    if (o.dryRun && seen.login?.ok) {
      if (state.at == "adopt")
        say(
          `PLAN  ${a.host} runs already: it is the Erga of the Worker ${state.worker}, in the Cloudflare account ${accountName(a, seen)}. I will take it over as it is: its entry goes into this clone's .erga/config.json, as bun erga register writes it. Its Worker, its database and its documents stay.`
        );
      // A dry run writes no entry, and does no step of the user's (it needs no terminal): its plan is the step after those.
      state = step(a, { ...seen, adopt: null, terminal: true }).state;
    }
    if (o.dryRun && state.at == "update") {
      for (const c of checksOf(a, seen)) pass(c);
      say(
        `PLAN  ${a.host} runs. The answers change its settings ${state.vars.join(", ")}: I will write them into .erga/config.json and deploy it again.`
      );
      return "dry";
    }
    if (o.dryRun && state.at == "deployer") {
      for (const c of checksOf(a, seen)) pass(c);
      if (a.where == "aws") {
        const { deployerName, deployerResources } = await import("../aws/deployer");
        const stack = deployerName(worker);
        say(
          state.do == "install"
            ? `PLAN  ${a.host} runs. I will install its deployer, as the stack ${stack}, and turn auto-deploy on:\nPLAN  ${deploysText(a)}\nPLAN  The stack's resources (${deployerResources().length}): ${deployerResources().join(", ")}`
            : `PLAN  ${a.host} runs. I will remove its deployer (the stack ${stack}: the Lambda function, its role, its schedule and the instance's document):\nPLAN  ${deploysText(a)}`
        );
        return "dry";
      }
      say(
        state.do == "install"
          ? `PLAN  ${a.host} runs. I will install its deployer:\nPLAN  ${deploysText(a, worker)}`
          : `PLAN  ${a.host} runs. I will remove its deployer (the Worker ${worker}-deployer, with the token that it holds):\nPLAN  ${deploysText(a)}`
      );
      return "dry";
    }
    if (o.dryRun && (state.at == "app" || state.at == "build" || state.at == "admin" || state.at == "terminal")) {
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
        return fail(state.why, `Ask the user, then: ${o.again}`);
      case "terminal":
        return fail(
          "The next step is the user's own, in their terminal (--remote), and this shell has no terminal.",
          `Give the user this command, to run in their own terminal session, not through you: ${o.again}. Ask them to tell you only its last line.`
        );
      case "login":
        if (again) return fail(state.why ?? "The sign-in did not finish.", o.again);
        login(a);
        break;
      case "adopt": {
        if (again) return fail(`${a.host} still has no entry in .erga/config.json.`, o.again);
        const c = await connect();
        const entry = await adoptEntry({ dir: DIR, answers: a, net: c.net, token: c.token });
        // The instance tracks what it tracked: bun erga track changes it, never setup's options.
        a = { ...a, repo: entry.repo, branch: entry.branch };
        pass(
          `${a.host} runs already, as the Worker ${state.worker}: this clone has its entry now (.erga/config.json). It tracks ${a.branch} of ${a.repo}.`
        );
        break;
      }
      case "app": {
        if (again) return fail("The app step did not finish.", o.again);
        const ended =
          state.kind == "github"
            ? a.remote
              ? (say("WAIT  The user's terminal shows a page's address. The user opens it, and clicks Create GitHub App on GitHub."),
                await githubApp(a, WAIT_MS, { open: forwarded }))
              : (say("WAIT  A GitHub tab opens. The user clicks Create GitHub App there. Its secret goes to this command, never to you."),
                await githubApp(a, WAIT_MS))
            : a.remote
              ? (say(
                  "WAIT  The user types the client secret of the organization's sign-in in their terminal. It goes to AWS, never to you."
                ),
                await oidcInTerminal(a))
              : (say("WAIT  A page opens. The user types the client secret of the organization's sign-in there, and clicks Save."),
                await oidcSecret(a, async (v) => (await import("../aws/setup")).putOidcSecret(a, v), WAIT_MS));
        if (ended == null) return "wait";
        if (ended) return fail(ended, o.again);
        pass(state.kind == "github" ? "GitHub made the app." : "AWS has the client secret.");
        break;
      }
      case "build":
        if (again)
          return fail(
            `${a.host} is deployed, but setup does not see it healthy yet${seen.live?.signIn && seen.live.signIn != "ok" ? `: ${seen.live.signIn.bad}` : ""}.`,
            o.again
          );
        await build(a, seen, o);
        break;
      case "update":
        if (again)
          return fail(
            `${a.host} is deployed again, but its entry still has other settings than the answers: ${state.vars.join(", ")}.`,
            o.again
          );
        say(
          `NOTE  The answers change the settings ${state.vars.join(", ")} of ${a.host}: setup writes them into its entry and deploys again.`
        );
        await build(a, seen, o);
        break;
      case "deployer": {
        if (again) return fail(`${a.host}'s deployer is not ${state.do == "install" ? "there" : "gone"} yet.`, o.again);
        if (a.where == "aws") {
          // No token and no step of the user's: the deployer's role is its credential, and this login makes its stack.
          const { installWithAuto, removeDeployer } = await import("../aws/deployer");
          const entry = await awsEntryOf(a, seen);
          const log = (line: string) => say(`  ${line.slice(0, 200)}`);
          if (state.do == "remove") {
            await removeDeployer(
              (await import("../aws/cli")).awsCli({ profile: entry.profile, region: entry.aws.region }),
              entry.aws.stack,
              log
            );
            pass(`The deployer of ${a.host} is removed, with its role: no credential stays in the cloud.`);
          } else {
            await installWithAuto(DIR, entry, log);
            pass(`The deployer of ${a.host} is installed: it deploys each new release of ${a.branch} by itself (auto-deploy is on).`);
          }
          break;
        }
        if (state.do == "remove") {
          const c = await connect();
          await (await import("../pipeline/deployer")).removeDeployer(c.cf, { account: a.account, worker });
          pass(`The deployer of ${a.host} is removed, with its token: no credential stays in the cloud.`);
          break;
        }
        say(
          a.remote
            ? "WAIT  The user makes a token for the deployer on Cloudflare, and pastes it in their terminal. It goes to Cloudflare, never to you."
            : "WAIT  A page opens. The user makes a token for the deployer on Cloudflare, and pastes it there. It goes to Cloudflare, never to you."
        );
        const ended = await installWithToken(a);
        if (ended == null) return "wait";
        if (ended) return fail(ended, o.again);
        pass(`The deployer of ${a.host} is installed: it deploys each new release of ${a.branch} by itself (auto-deploy is on).`);
        break;
      }
      case "admin": {
        if (again) return fail(`${a.host} has no admin yet.`, o.again);
        const who = await admin(a, o);
        if (!who) return "wait";
        pass(`${who} is the admin of https://${a.host}.`);
        break;
      }
      case "done":
        if (o.dryRun) pass(`${a.host} runs already, with an admin.`);
        if (a.where == "aws") {
          // Its stacks, to this code's template: a new rule of the proxy reaches AWS only this way (a deploy doesn't).
          const aws = await import("../aws/setup");
          await aws.writePlan(DIR, a);
          if (o.dryRun) say("PLAN  Its stacks change to this code's template, if it differs (each change shows as it's made).");
          else await aws.applyStacks(DIR, a, (line) => say(`  ${line.slice(0, 200)}`));
          // Its deployer too: only a person's login changes the deployer's stack and code. The switch stays as it is.
          if (seen.deployer && a.deploys == "cloud" && !did.has("deployer")) {
            if (o.dryRun)
              say("PLAN  Its deployer changes to this code's too: its stack, and the function's code. Auto-deploy stays as it is.");
            else
              await (await import("../aws/deployer")).installDeployer(DIR, await awsEntryOf(a, seen), (line) =>
                say(`  ${line.slice(0, 200)}`)
              );
          }
        }
        // On Cloudflare too: only a person's login changes the deployer's code. It keeps the token that it holds, its
        // store and its switch: the user makes no new token for a newer deployer.
        if (a.where != "aws" && seen.deployer && a.deploys == "cloud" && !did.has("deployer")) {
          if (o.dryRun)
            say("PLAN  Its deployer's code changes to this code's. It keeps the token that it holds; auto-deploy stays as it is.");
          else {
            const c = await connect();
            await (await import("../pipeline/deployer")).installDeployer(c.cf, { account: a.account, worker }, null);
            pass(`The deployer of ${a.host} has this code now. It holds the same token; auto-deploy is as it was.`);
          }
        }
        return o.dryRun ? "dry" : "done";
    }
  }
}

/** `bun erga setup <host> --host ... --sign-in ...`: the instance. */
async function run(a: Answers, o: Run) {
  const need = missing(a);
  if (need.length)
    return fail(`The command needs: ${need.join(" ")}`, "Ask the user what the README's setup asks, then run the command again.");
  const end = await setUp(a, o);
  if (end == "wait") return say(`WAIT  The user's step is still open. Run the same command again: ${o.again}`);
  if (o.dryRun)
    return say(
      "DRY RUN  Nothing is made. Tell the user the plan, and ask: Shall I make it? On yes, run the same command without --dry-run."
    );
  // What it tracks is its entry's: a run on an instance that is there already does not change that (bun erga track does).
  const { repo, branch } = entryOf(readConfig(DIR), a.host) ?? a;
  say(
    `DONE  Tell the user: Erga is live at https://${a.host}, and they are the admin. It tracks ${branch} of ${repo}: ${a.deploys == "cloud" ? "its deployer, in their own account, deploys each new release of that branch by itself (an admin turns that off on the server's ops page)" : `bun erga deploy ${a.host} gives it that branch's newest commit`}. .erga/secrets.json in this folder holds the server's secrets: keep a copy in a password manager, and share it with no one. Later deploys: bun erga (the ops page). Settings has the rest: Google sign-in, a feedback repository, the homepage.`
  );
  // A repository of the user's own (a fork): Erga's main is the upstream to compare it with. Setup sets none itself.
  if (repoName(repo) != DEFAULT_REPO)
    say(
      `NOTE  It tracks a repository of your own. To see which of Erga's commits it lacks (bun erga status, and the ops page): bun erga track ${a.host} --upstream main --upstream-repo ${DEFAULT_REPO}`
    );
}

async function remove(host: string, yes: boolean) {
  const entry = entryOf(readConfig(DIR), host);
  const only = `Only if the user said yes: bun erga setup ${host} remove --yes`;
  if (entry && isAws(entry)) {
    const { awsCli } = await import("../aws/cli");
    const { CERT_REGION, stackState } = await import("../aws/stack");
    const { idpSecretParam, paramPath } = await import("../aws/template");
    const name = entry.aws.stack,
      where = { profile: entry.profile, region: entry.aws.region };
    if (!yes)
      fail(
        `This deletes ${host} on AWS: the stack ${name} (the machine, the addresses, the network, the key), its deployer if it has one, its certificates and its secrets. The bucket stays, with the documents in it.`,
        only
      );
    const aws = awsCli(where);
    const bucket = (await stackState(aws, name)).outputs.Bucket;
    // The deployer first: its role names the machine and the bucket of the stack that goes.
    if (await (await import("../aws/deployer")).removeDeployer(aws, name, (line) => say(`  ${line}`)))
      pass(`stack ${name}-deployer deleted`);
    // Trap: with the gate in front, CloudFront keeps copies of the Lambda@Edge function for a time after its
    // distributions are gone, and refuses to delete the function until then. The us-east-1 stack is tried again each
    // two minutes, for half an hour; after that the secrets go all the same, and the command says what is left.
    let left = "";
    for (const [w, s, tries] of [
      [where, name, 1],
      [{ ...where, region: CERT_REGION }, `${name}-certs`, entry.aws.gate ? 15 : 1],
    ] as const) {
      const cli = awsCli(w);
      for (let i = 0; i < tries && (await stackState(cli, s)).status; i++) {
        if (i) await Bun.sleep(120_000);
        await cli("cloudformation", "delete-stack", "--stack-name", s);
        say(`  ${s}: AWS deletes it (it takes minutes)...`);
        await cli("cloudformation", "wait", "stack-delete-complete", "--stack-name", s).catch(() => {});
      }
      if ((await stackState(cli, s)).status) left = s;
      else pass(`stack ${s} deleted`);
      if (left) break;
    }
    const params =
      (await aws<{ Parameters: { Name: string }[] }>("ssm", "get-parameters-by-path", "--path", paramPath(name)).catch(() => null))
        ?.Parameters ?? [];
    for (const p of params) await aws("ssm", "delete-parameter", "--name", p.Name);
    if (params.length) pass(`${params.length} secrets deleted from Parameter Store`);
    if (entry.aws.gate)
      await awsCli({ ...where, region: CERT_REGION })("ssm", "delete-parameter", "--name", idpSecretParam(name)).then(
        () => pass("the sign-in's client secret deleted from Parameter Store"),
        () => {}
      );
    if (left) say(`NOTE  The stack ${left} is still there. Run the command again later: it deletes what is left.`);
    if (bucket)
      say(
        `NOTE  The bucket ${bucket} stays, with the documents. Delete it by hand if they are gone for good: aws s3 rb s3://${bucket} --force`
      );
  } else {
    const { removalText, removeOnCloudflare } = await import("./remove");
    if (!yes) fail(removalText(host, entry), only);
    const { cf } = await connect();
    if (!entry) return fail(`${host} has no entry in .erga/config.json.`);
    await removeOnCloudflare(cf, host, entry, { done: pass, skipped: (what, why) => say(`SKIP  ${what}: ${why}`) });
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
    } else if (x.startsWith("--") && !FLAGS.includes(x)) problems.push(`${x} isn't an option of bun erga setup.`);
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
  const remote = flag("--remote") || !!process.env.SSH_CONNECTION;
  try {
    if (rest[0] == "remove") return await remove(host, flag("--yes"));
    // An unknown option first: its value is no setup command.
    if (problems.length) return fail(problems.join(" "), "bun erga setup --help lists the options.");
    if (rest.length) {
      say(`No setup command ${rest[0]}.`);
      return usage(2);
    }
    // Single sign-on needs the gate in front of the server (gate/mounts/). On AWS the stacks make it
    // (deploy/aws/template.ts, deploy/aws/gate.ts), and the verify suite deploys it (bun erga verify 5). No run on a
    // real account has passed yet, and this flow still writes the old proxy's setting: refused here, before anything
    // is made, until one has. On Cloudflare, setup does not make the gate's Worker yet.
    if (answers.signIn == "sso")
      return fail(
        "Single sign-on is not available in this version: the gate in front of the server is not verified on a real account yet.",
        "Choose --sign-in invite or --sign-in organization."
      );
    const again = ["bun erga setup", host, ...args, ...(remote && !flag("--remote") ? ["--remote"] : [])].join(" ");
    await run({ ...answers, remote }, { dryRun: flag("--dry-run"), noTests: flag("--no-tests"), again });
  } catch (e) {
    fail((e as Error).message, `bun erga setup ${host}`);
  }
}
