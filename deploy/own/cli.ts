// A new Erga instance, set up by a user with their coding agent: `bun erga setup <host>` (deploy/cli/main.ts). The
// agent asks the user every question first (README.md, Setup), then runs this command with each answer as an option:
// first with --dry-run (the checks and the plan; nothing is made), then, after the user's yes, without it. The
// command does all the work in the account, in one run: it signs in, builds and deploys the server, and installs its
// deployer. Then it opens the new server's setup page in the user's browser (/setup, server/identity/setup.ts), with a
// link that works one time, and ends: it waits for nothing. The user finishes on the page: GitHub or Google sign-in,
// the deployer's token, and their own sign-in, which makes them the admin. The agent never makes a token, and never
// sees a secret or the link. The command never has the deployer's token either: the server hands it to the deployer.
//
//   bun erga setup <host> --host cloudflare|aws --deploys cloud|local [<options>] [--dry-run]
//       --repo <repo>          the repository that the instance tracks (default: github.com/koomen/erga)
//       --branch <branch>      the branch of it that the instance tracks (default: main): its first deploy, and each
//                              deploy after, takes that branch's head. bun erga track <host> changes both later.
//       --account <name|id>    Cloudflare: the account, when two hold the domain
//       --profile <name>       AWS: the AWS CLI's profile, when there are several (the region is the profile's)
//       --pages <domain>       a second domain of the account, for the documents' pages: each document gets a
//                              subdomain of its own there. AWS needs it (a Route 53 domain), and so does single
//                              sign-on on Cloudflare. Cloudflare without it: one shared workers.dev address, which is
//                              safe for one author.
//       --deploys cloud|local  who deploys each new release. cloud: a deployer in the user's account, by itself. On
//                              Cloudflare it is a second Worker, which the command installs with no token: the user
//                              makes its token (for the instance's Worker and the deployer's) and pastes it on the server (its
//                              setup page; later, its Deploy page). On AWS it is a Lambda function whose role is its
//                              credential: no token. local: the user, with bun erga deploy; no credential in the
//                              cloud. A run again with the other answer installs the deployer, or removes it.
//       --auto-deploy <mode>   with --deploys cloud: what the deployer deploys by itself: off, releases (each
//                              tagged release) or commits (each commit). Without it, an instance that runs keeps the
//                              mode that it has, and a new one gets releases. Setup changes no mode by itself.
//       --sign-in sso          the organization's single sign-on, at Erga's gate (gate/), in the place of GitHub
//                              and Google sign-in. On AWS the gate is in front of the server; on Cloudflare it is
//                              the first call of Erga's Worker:
//         --team <name> --aud <tag>        on Cloudflare: Cloudflare Access is in front of the address, and Erga
//                                          takes only a request with its proof for that application
//         --issuer <URL> --client <ID>     on AWS, or on Cloudflare in place of Access: the organization's own
//                                          sign-in (OpenID Connect). The user types the client's secret
//         --sign-in-days <days>            on AWS: how long a sign-in lasts, from 1 to 90 (default: 30)
//       --egress <way>         AWS: nat-instance (the default), nat-gateway, or <vpc id>/<private subnet id>
//       --no-tests             the build runs no tests
//       --remote               the user is at another computer (on by itself over SSH): no browser opens here. The
//                              setup page's link shows on the user's terminal, and they open it in their own browser.
//   bun erga setup <host> remove --yes       deletes the server: its Workers, database, bucket and the pages' DNS record (AWS: its stacks
//                                            and secrets; the bucket stays, with the data)
//
// Each run ends in one of these lines: DRY RUN (the plan), DONE, WAIT (the user's step is still open: run the same
// command again) or FAIL (what is wrong, and what to do). A run again goes on from where the last one stopped. In a
// clone with no entry for an Erga that runs at the address (another clone set it up), the run first takes it over: it
// writes the entry, as bun erga register does, and goes on from where that instance is. On
// AWS, a run on an instance that is done updates its stacks to this code's template (a deploy changes only the code).
//
// Trap: nothing here prints a secret, or the setup page's link: the agent reads this command's output, and whoever
// opens the link can become the server's admin. The link goes to the browser only, or with --remote to the user's
// terminal (/dev/tty), never to stdout.

import { closeSync, readFileSync } from "node:fs";
import { setupUrl } from "../../server/identity/setup-link";
import { DEFAULT_REPO, entryOf, isAws, originOf, readConfig, repoName } from "../cli/config";
import type { AutoMode } from "../deployer/tags";
import { fail, pass, ROOT, say } from "../root";
import { askSecret, oidcSecret, openBrowser, openTerminal, tellUser } from "./browser";
import { cloudflare, type Connection, observe } from "./facts";
import { adoptEntry, autoOnCloudflare, firstDeploy, secretsFor, setDeployer } from "./first";
import { accountName, autoText, checksOf, deploysText, missing, oldDeployerText, planText, type Seen, type State, step } from "./flow";
import { type Answers, noAnswers, parseAnswer, type TextAnswer } from "./plan";
import { DIR, loadSecrets, namesAt, putSecret, saveSecrets, SSO_SECRET } from "./store";

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
  "--team": "team",
  "--aud": "aud",
  "--issuer": "issuer",
  "--client": "client",
  "--sign-in-days": "signInDays",
  "--pages": "pages",
  "--egress": "egress",
  "--deploys": "deploys",
  "--auto-deploy": "auto",
};
const FLAGS = ["--dry-run", "--no-tests", "--yes", "--remote"];

interface Run {
  dryRun: boolean;
  noTests: boolean;
  /** The command again, for the lines that say to run it. */
  again: string;
  /** What the run's last line says too: a step adds to it what the user must not miss. */
  last: string[];
  /** The instance's auto-deploy mode, when a step of this run set it or read it. */
  auto?: AutoMode;
}

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

/**
 * Keeps the client secret of the organization's sign-in where the gate reads it: on AWS in Parameter Store; on
 * Cloudflare in .erga/secrets.json, from where the first deploy gives it to the Worker as a secret.
 */
const putClientSecret = async (a: Answers, secret: string) =>
  a.where == "aws" ? (await import("../aws/setup")).putOidcSecret(a, secret) : putSecret(a.host, SSO_SECRET, secret);
/** Where the client secret goes, as the user reads it. */
const secretPlace = (a: Answers) => (a.where == "aws" ? "AWS" : "Cloudflare, with the first deploy");

/** --remote: the user types the client secret in their terminal. "": done; else a failure. */
async function oidcInTerminal(a: Answers): Promise<string> {
  for (;;) {
    const secret = askSecret(`The client secret of Erga's client ${a.client} at ${a.issuer} (it does not show as you type):`);
    if (secret == null) return "The prompt in the terminal ended.";
    if (!secret) continue;
    await putClientSecret(a, secret);
    return "";
  }
}

/** The instance's entry on AWS, from the answers and what its stack has now: the deployer's install names these. */
async function awsEntryOf(a: Answers, seen: Seen) {
  const { awsEntry } = await import("../aws/setup");
  if (!seen.stack?.outputs.Machine) return fail(`The stack of ${a.host} has no machine: setup has not made the instance yet.`);
  return awsEntry(a, seen.account, seen.stack.outputs, seen.github || undefined);
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
  const github = seen.github || undefined;
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
 * The page step: the command opens the new server's setup page in the user's browser, with a link that works one time
 * (server/identity/setup.ts). The user finishes there, and the command waits for nothing.
 */
async function page(a: Answers, o: Run) {
  const secret = loadSecrets(DIR)[a.host]?.SESSION_SECRET;
  if (!secret)
    return fail(
      `This machine does not hold the SESSION_SECRET of ${a.host} (.erga/secrets.json), so it can't make the setup page's link.`,
      `Run the command on the machine that set ${a.host} up: ${o.again}`
    );
  const to = await setupUrl(a.host, secret);
  if (a.remote) tellUser(`Open this link in your browser. It works one time, for 30 minutes; never give it to your agent.\n${to}`);
  else openBrowser(to);
  pass(
    a.remote
      ? `The user's terminal shows the link to the setup page of ${a.host}. The user opens it in their browser.`
      : `The command opened the setup page of ${a.host} in the user's browser.`
  );
}

/** Cloudflare: the instance's deployer, installed with no token, or removed (first.ts, setDeployer). */
async function deployerOnCloudflare(a: Answers, seen: Seen, o: Run, to: "install" | "remove", worker: string) {
  const c = await connect();
  return setDeployer({
    dir: DIR,
    host: a.host,
    target: { account: a.account, worker },
    to,
    auto: a.auto || undefined,
    commit: seen.live?.version ?? undefined,
    command: `bun erga setup ${a.host}`,
    ...c,
    print: (line) => say(`  ${line.slice(0, 200)}`),
  }).catch((e: Error) => fail(e.message, `Fix what it names, then: ${o.again}. Every step is safe to run again.`));
}

/** The server's page where the user pastes the deployer's token. */
const tokenPage = (a: Answers, seen: Seen) => (seen.admin ? `https://${a.host}/admin/deploy` : "its setup page");

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
async function setUp(a: Answers, o: Run): Promise<"done" | "dry" | "wait" | "page"> {
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
            ? `PLAN  ${a.host} runs. I will install its deployer, as the stack ${stack}:\nPLAN  ${deploysText(a, undefined, undefined, true)}\nPLAN  The stack's resources (${deployerResources().length}): ${deployerResources().join(", ")}`
            : `PLAN  ${a.host} runs. I will remove its deployer (the stack ${stack}: the Lambda function, its role, its schedule and the instance's document):\nPLAN  ${deploysText(a)}`
        );
        return "dry";
      }
      say(
        state.do == "install"
          ? `PLAN  ${a.host} runs. I will install its deployer, with no token, and deploy ${a.host} again, so that its Worker binds the deployer:\nPLAN  ${deploysText(a, worker, seen.admin ? "its Deploy page (/admin/deploy)" : "its setup page", true)}`
          : `PLAN  ${a.host} runs. I will remove its deployer (the Worker ${worker}-deployer, with the token that it holds), and deploy ${a.host} again without it:\nPLAN  ${deploysText(a)}`
      );
      const { keepsToken } = await import("../pipeline/deployer");
      if (state.do == "install" && seen.deployer && !(await keepsToken((await connect()).cf, { account: a.account, worker })))
        say(`PLAN  ${oldDeployerText(a.host, tokenPage(a, seen), true)}`);
      return "dry";
    }
    if (o.dryRun && (state.at == "app" || state.at == "build" || state.at == "page" || state.at == "terminal")) {
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
        if (again) return fail("The client secret's step did not finish.", o.again);
        say(
          a.remote
            ? `WAIT  The user types the client secret of the organization's sign-in in their terminal. It goes to ${secretPlace(a)}, never to you.`
            : "WAIT  A page opens. The user types the client secret of the organization's sign-in there, and clicks Save."
        );
        const ended = a.remote ? await oidcInTerminal(a) : await oidcSecret(a, (v) => putClientSecret(a, v), WAIT_MS);
        if (ended == null) return "wait";
        if (ended) return fail(ended, o.again);
        pass(a.where == "aws" ? "AWS has the client secret." : "The client secret is kept for the first deploy.");
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
            o.auto = await installWithAuto(DIR, entry, log, a.auto || undefined);
            pass(`The deployer of ${a.host} is installed: it ${autoText(o.auto, a.branch)}.`);
          }
          break;
        }
        const did = await deployerOnCloudflare(a, seen, o, state.do, worker);
        if (!did) {
          pass(`The deployer of ${a.host} is removed, with the token that it held: no credential stays in the cloud.`);
          break;
        }
        o.auto = did.auto;
        if (did.replaced) o.last.push(oldDeployerText(a.host, tokenPage(a, seen)));
        pass(
          did.replaced
            ? o.last.at(-1)!
            : `The deployer of ${a.host} is installed, with no token yet. The user pastes its token on the server: ${tokenPage(a, seen)}. With a token, it ${autoText(did.auto, a.branch)}.`
        );
        break;
      }
      case "page":
        // The user's own step, and the run's last: the command asks the user nothing more, and waits for nothing.
        await page(a, o);
        return "page";
      case "done": {
        if (o.dryRun) pass(`${a.host} runs already, with an admin.`);
        /** A deployer that was there before this run: this run brings it to this code. Its mode stays, unless the user chose one now. */
        const there = seen.deployer && a.deploys == "cloud" && !did.has("deployer");
        const stays = a.auto ? "" : " Auto-deploy stays as it is.";
        if (a.where == "aws") {
          // Its stacks, to this code's template: a new rule of the proxy reaches AWS only this way (a deploy doesn't).
          const aws = await import("../aws/setup");
          await aws.writePlan(DIR, a);
          if (o.dryRun) say("PLAN  Its stacks change to this code's template, if it differs (each change shows as it's made).");
          else await aws.applyStacks(DIR, a, (line) => say(`  ${line.slice(0, 200)}`));
          // Its deployer too: only a person's login changes the deployer's stack and code. The switch stays as it is.
          if (there) {
            if (o.dryRun) say(`PLAN  Its deployer changes to this code's too: its stack, and the function's code.${stays}`);
            else
              await (await import("../aws/deployer")).installDeployer(DIR, await awsEntryOf(a, seen), (line) =>
                say(`  ${line.slice(0, 200)}`)
              );
          }
        }
        // On Cloudflare too: the deployer gets this checkout's code (each deploy gives it its release's). It keeps the
        // token that it holds, its store and its switch: the user makes no new token for a newer deployer.
        if (a.where != "aws" && there) {
          const c = await connect();
          const { keepsToken, installDeployer } = await import("../pipeline/deployer");
          if (o.dryRun)
            say(
              (await keepsToken(c.cf, { account: a.account, worker }))
                ? `PLAN  Its deployer's code changes to this code's. It keeps the token that it holds.${stays}`
                : `PLAN  ${oldDeployerText(a.host, tokenPage(a, seen), true)}${stays}`
            );
          else {
            const { kept } = await installDeployer(c.cf, { account: a.account, worker });
            if (!kept) o.last.push(oldDeployerText(a.host, tokenPage(a, seen)));
            pass(kept ? `The deployer of ${a.host} has this code now. It holds what it held.${stays}` : `${o.last.at(-1)!}${stays}`);
          }
        }
        // The mode that the user chose in this run (--auto-deploy): setup changes an instance's mode only so.
        if (there && a.auto) {
          if (o.dryRun) say(`PLAN  I will set its auto-deploy to ${a.auto}, as you chose.`);
          else {
            o.auto =
              a.where == "aws"
                ? await (await import("../aws/deployer")).setAuto(await awsEntryOf(a, seen), a.auto)
                : await autoOnCloudflare((await connect()).cf, { account: a.account, worker }, a.auto);
            pass(`Auto-deploy of ${a.host} is set, as the user chose: its deployer ${autoText(o.auto, a.branch)}.`);
          }
        }
        return o.dryRun ? "dry" : "done";
      }
    }
  }
}

/** `bun erga setup <host> --host ... --deploys ...`: the instance. */
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
  // The mode, when this run set it or read it: else the run says no mode (it changed none).
  const does = o.auto ? autoText(o.auto, "that branch") : "deploys that branch by itself, as the server's auto-deploy mode says";
  const deployed =
    a.deploys != "cloud"
      ? `bun erga deploy ${a.host} gives it that branch's newest commit`
      : a.where == "aws"
        ? `its deployer, in their own account, ${does} (an admin changes that on the server's Deploy page)`
        : `its deployer, in their own account, ${does}, while it holds its token: the user pastes it on ${end == "page" ? "the setup page" : `the server's Deploy page (https://${a.host}/admin/deploy), which also says whether the deployer holds one`}`;
  const rest = `${o.last.map((l) => `${l} `).join("")}It tracks ${branch} of ${repo}: ${deployed}. .erga/secrets.json in this folder holds the server's secrets: keep a copy in a password manager, and share it with no one. Later deploys: bun erga (the ops page).`;
  say(
    end == "done"
      ? `DONE  Tell the user: Erga is live at https://${a.host}, and it has its admin. ${rest}`
      : `DONE  Tell the user: Erga runs at https://${a.host}. Its setup page is ${a.remote ? "behind the link on their terminal" : "open in their browser"}: they finish there. ${a.signIn == "sso" ? `The link passes their organization's sign-in first. Then the page names them, and one button makes them the admin${a.deploys == "cloud" && a.where != "aws" ? "; before that, they paste the deployer's token there" : ""}.` : `They set up GitHub or Google sign-in${a.deploys == "cloud" && a.where != "aws" ? ", paste the deployer's token" : ""}, then they sign in, and become the admin.`} The link works one time, for 30 minutes: when the page says that it works no more, run the same command again. Never open the page yourself. ${rest}`
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
    const again = ["bun erga setup", host, ...args, ...(remote && !flag("--remote") ? ["--remote"] : [])].join(" ");
    await run({ ...answers, remote }, { dryRun: flag("--dry-run"), noTests: flag("--no-tests"), again, last: [] });
  } catch (e) {
    fail((e as Error).message, `bun erga setup ${host}`);
  }
}
