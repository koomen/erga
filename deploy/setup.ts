#!/usr/bin/env bun
// One-time setup of the control Worker (erga-control, control/), its secrets
// and the one deploy token Erga deploys with: the runbook, as a script. It
// says what it will do first, then does each step only after you say yes.
// It never deploys erga.dev's app. On the app Workers it sets one secret
// (SNAPSHOT_TOKEN, shared with the control Worker).
//
//   CLOUDFLARE_ACCOUNT_ID=… bun deploy/setup.ts
//   bun deploy/setup.ts --dry-run          (says what it would do, asks nothing, changes nothing)
//   bun deploy/setup.ts --control          (deploy the control Worker again: after control/ or its image changed)
//   bun deploy/setup.ts --tokens           (only the deploy token: make it again, check it, store it)
//   --no-deploy                            (skip staging's first deploy from this machine, if erga-staging is missing)
//   bun deploy/setup.ts --hook-secret      (only a new DEPLOY_HOOK_SECRET on the two app Workers, for their sign-in settings)
//   bun deploy/setup.ts --cleanup          (delete what the control Worker replaced: the erga-builder Worker, and the app
//                                           Workers' own deploy tokens)
//
// The credential is yours, never a server's: CLOUDFLARE_API_TOKEN if set,
// else the cf CLI's login. It needs Workers, D1, Containers, Workers Routes,
// DNS, Zone read and Artifacts (the cf CLI's login has them). Making the
// deploy token needs a credential that may make account API tokens: set
// CLOUDFLARE_TOKEN_MAKER to an account-owned API token with only Account ›
// Account API Tokens › Edit (Manage Account › Account API Tokens; a short
// TTL; delete it after). The setup checks it first and says what's wrong
// with it, if anything.
//
// The token: Editor on erga, erga-staging and erga-control, D1 Write
// (account-wide: Cloudflare has no per-database scope) and read on the three
// zones. It is checked with itself before it's stored, and never printed.
//
// ERGA_DEPLOY_MOCK=1: all of it against the mock Cloudflare's copy of Erga's
// account, with --yes taking the defaults: the tests run it so.

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cloudflare, DeployError, zoneIdOf, type Fetch } from "./pipeline";
import { machineCredential } from "./local-credential";
import { MOCK_HOOK_SECRET, mockCloudflare } from "./mock-cloudflare";
import { ask, deployFromMachine } from "./run";
import { CONTROL, SOURCE, TARGETS } from "./targets";
import { checkToken, createToken, describePlan, diagnoseMaker, olderTokens, permissionIds, policiesFor, tokenPlan, type TokenPlan } from "./server-tokens";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const dry = flag("--dry-run"), yes = flag("--yes"), tokensOnly = flag("--tokens");
const mock = process.env.ERGA_DEPLOY_MOCK == "1";
const STAGING = TARGETS.staging, PROD = TARGETS.production;
const APP_WORKERS = [PROD.worker, STAGING.worker];
const secret = () => randomBytes(32).toString("hex");
/** The wrangler that deploys the control Worker (its containers need a recent one). */
export const WRANGLER = "wrangler@4.147.0";
const CONTROL_DIR = new URL("../control/", import.meta.url).pathname;

/** The control Worker's GitHub OAuth app's Client ID, as control/wrangler.jsonc has it (JSONC: comments stripped). */
function controlClientId(): string {
  try {
    const text = readFileSync(join(CONTROL_DIR, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    return String((JSON.parse(text) as { vars?: { GITHUB_CLIENT_ID?: string } }).vars?.GITHUB_CLIENT_ID ?? "").trim();
  } catch { return ""; }
}

const PLAN = [
  `Check the credential, the account, and its zones ${[...new Set([CONTROL.zone, STAGING.zone, PROD.pages.zone, STAGING.pages.zone])].join(", ")} (reads only).`,
  `Erga's source: the Artifacts repo ${SOURCE.namespace}/${SOURCE.repo} (made if it isn't there). The control Worker reaches it through its Artifacts binding, not a token.`,
  `The control Worker's GitHub OAuth app: its Client ID in control/wrangler.jsonc (homepage https://${CONTROL.host}, callback https://${CONTROL.host}/auth/github/callback).`,
  `The control Worker (${CONTROL.worker}, control/): deployed with \`bunx ${WRANGLER} deploy\` there (Docker builds its container image) if it isn't there, or with --control. It gets ${CONTROL.host}.`,
  `The control Worker's secrets: a SESSION_SECRET (kept if it has one), its GitHub app's client secret, a GitHub mirror token if you want the mirror, and SNAPSHOT_TOKEN, which it shares with ${APP_WORKERS.join(" and ")} (set on all three: staging's data copy goes through it).`,
  `Staging's first deploy, from this machine, only if ${STAGING.worker} isn't there: build HEAD, make it and its database with a copy of production's data.`,
  `The deploy token (${tokenPlan().name}): Editor on ${tokenPlan().workers.join(", ")}, D1, read on the zones. Made, checked with itself, stored on ${CONTROL.worker} as CLOUDFLARE_DEPLOY_TOKEN.`,
  `Check it: https://${CONTROL.host}/api/health answers, and each target answers its version.`,
];
const TOKEN_STEPS = [1, 7];

// --hook-secret: a new DEPLOY_HOOK_SECRET, set on both app Workers, for the sign-in settings they share server to server.
if (flag("--hook-secret")) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "", cred = mock ? null : machineCredential();
  if (mock || !/^[0-9a-f]{32}$/.test(accountId) || !cred) { console.error("--hook-secret: set CLOUDFLARE_ACCOUNT_ID and log in with `bunx cf auth login` (not under the mock)."); process.exit(1); }
  console.log(`A new DEPLOY_HOOK_SECRET for ${APP_WORKERS.join(" and ")} (not printed, not kept here).`);
  if (!ask("Go on?", yes)) process.exit(1);
  const value = secret(), cf = new Cloudflare(cred.token);
  for (const worker of APP_WORKERS) {
    await cf.call("PUT", `/accounts/${accountId}/workers/scripts/${worker}/secrets`, `set DEPLOY_HOOK_SECRET on ${worker}`, { name: "DEPLOY_HOOK_SECRET", text: value, type: "secret_text" });
    console.log(`Set on ${worker}.`);
  }
  process.exit(0);
}

console.log(`Setting up ${CONTROL.worker} at ${CONTROL.host}${mock ? " (the mock Cloudflare: nothing real)" : ""}${tokensOnly ? ", the deploy token only" : ""}. The steps:\n`);
PLAN.forEach((p, i) => { if (!tokensOnly || TOKEN_STEPS.includes(i + 1)) console.log(`  ${i + 1}. ${p}`); });
console.log("\nThe deploy token grants exactly this:");
{
  const p = tokenPlan();
  console.log(`  ${p.name} (on ${p.storedOn}):`);
  for (const l of describePlan(p)) console.log(`    - ${l}`);
}
console.log("");
if (dry) { console.log("--dry-run: nothing done."); process.exit(0); }
if (!ask("Start? (each step asks again before it changes anything)", yes)) process.exit(1);

const accountId = mock ? "0123456789abcdef0123456789abcdef" : process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
const cred = mock ? { token: "mock-setup-token", from: "the mock" } : machineCredential();
if (!/^[0-9a-f]{32}$/.test(accountId) || !cred) { console.error("Set CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN or log in with `bunx cf auth login` (see the top of this file)."); process.exit(1); }
const token = cred.token;
const net: Fetch = mock ? mockCloudflare({ fleet: true }).fetch : globalThis.fetch.bind(globalThis);
const cf = new Cloudflare(token, net);
const acc = `/accounts/${accountId}`;
const step = (n: number) => console.log(`\n${n}. ${PLAN[n - 1]}`);
// Who makes the token: CLOUDFLARE_TOKEN_MAKER if set (an account-owned API token with Account API Tokens Edit,
// for when your own credential can't make tokens: the cf CLI's OAuth login can't, today), else the same credential.
const makerValue = mock ? "" : process.env.CLOUDFLARE_TOKEN_MAKER?.trim() ?? "";
const maker = makerValue ? new Cloudflare(makerValue, net) : cf;
const putSecret = (worker: string, name: string, text: string) => cf.call("PUT", `${acc}/workers/scripts/${worker}/secrets`, `set ${name} on ${worker}`, { name, text, type: "secret_text" });
const scriptsNow = async () => ((await cf.call<{ id: string }[]>("GET", `${acc}/workers/scripts`, "list the Workers")) ?? []).map((s) => s.id);
const secretsOf = async (worker: string) => ((await cf.call<{ name: string }[]>("GET", `${acc}/workers/scripts/${worker}/secrets`, `list ${worker}'s secrets`).catch(() => [])) ?? []).map((s) => s.name);
/** What you type, or what you exported with --yes; the mock takes nothing from this machine. */
const read = (what: string, fallback = "") => {
  if (mock) return fallback;
  if (yes) return process.env[what]?.trim() ?? "";
  return prompt(`   ${what} (Enter to leave it out)`)?.trim() ?? "";
};

// --cleanup: what the control Worker replaced.
if (flag("--cleanup")) {
  const scripts = await scriptsNow();
  console.log(`Clean up what ${CONTROL.worker} replaced:`);
  if (scripts.includes("erga-builder")) console.log("  - the erga-builder Worker (its container application goes with it)");
  for (const w of APP_WORKERS) if ((await secretsOf(w)).includes("CLOUDFLARE_DEPLOY_TOKEN")) console.log(`  - ${w}'s own deploy token (CLOUDFLARE_DEPLOY_TOKEN): the control Worker deploys it now`);
  if (!ask("Go on?", yes)) process.exit(1);
  if (scripts.includes("erga-builder")) { await cf.call("DELETE", `${acc}/workers/scripts/erga-builder?force=true`, "delete erga-builder"); console.log("  Deleted erga-builder."); }
  for (const w of APP_WORKERS) if ((await secretsOf(w)).includes("CLOUDFLARE_DEPLOY_TOKEN")) { await cf.call("DELETE", `${acc}/workers/scripts/${w}/secrets/CLOUDFLARE_DEPLOY_TOKEN`, `delete ${w}'s CLOUDFLARE_DEPLOY_TOKEN`); console.log(`  Deleted ${w}'s CLOUDFLARE_DEPLOY_TOKEN.`); }
  console.log("Done. The account's older deploy tokens (erga-deploy-staging, erga-deploy-production) can go on the dashboard: Manage Account › Account API Tokens.");
  process.exit(0);
}

/** Makes the deploy token, checks it with itself, stores it on the control Worker, and deletes older ones by the same name. */
async function makeToken(plan: TokenPlan): Promise<boolean> {
  for (const l of describePlan(plan)) console.log(`   - ${l}`);
  if (!ask(`   Make ${plan.name} and store it on ${plan.storedOn}?`, yes)) { console.log("   Skipped."); return false; }
  if (!mock && !makerValue && cred!.from != "CLOUDFLARE_API_TOKEN") throw new DeployError("The cf CLI's login can't make account API tokens (Cloudflare doesn't grant its OAuth client that scope). Make an account-owned API token with only Account › Account API Tokens › Edit (Manage Account › Account API Tokens, a TTL of today), and run this again with CLOUDFLARE_TOKEN_MAKER set to it.");
  if (!mock) {
    const d = await diagnoseMaker({ net, accountId, value: makerValue || token });
    for (const l of d.said) console.log(`   The token maker (${makerValue ? "CLOUDFLARE_TOKEN_MAKER" : cred!.from}): ${l}`);
    if (!d.ok) throw new DeployError(makerValue ? "CLOUDFLARE_TOKEN_MAKER can't make the token (above)." : `${cred!.from} can't make account API tokens. Make an account-owned API token with Account › Account API Tokens › Edit (Manage Account › Account API Tokens), and run this again with CLOUDFLARE_TOKEN_MAKER set to it.`);
  }
  const ids = await permissionIds(maker, accountId, (l) => console.log(`   ${l}`));
  const policies = await policiesFor(cf, accountId, plan, ids);
  const made = await createToken(maker, accountId, plan, policies);
  const wrong = await checkToken({ net, admin: cf, tokens: maker, accountId, plan, id: made.id, value: made.value, policies });
  if (wrong.length) {
    await maker.call("DELETE", `${acc}/tokens/${made.id}`, `delete the token ${plan.name}`).catch(() => {});
    throw new DeployError(`The new token ${plan.name} isn't right, so it was deleted and not stored: ${wrong.join("; ")}.`);
  }
  console.log(`   Made and checked: it deploys ${plan.workers.join(", ")}, reads ${plan.zones.join(", ")}, and can't write DNS and routes.`);
  await putSecret(plan.storedOn, "CLOUDFLARE_DEPLOY_TOKEN", made.value);
  console.log(`   Stored on ${plan.storedOn} as CLOUDFLARE_DEPLOY_TOKEN (not printed).`);
  for (const old of await olderTokens(maker, accountId, plan, made.id)) {
    await maker.call("DELETE", `${acc}/tokens/${old}`, `delete an older ${plan.name}`).then(() => console.log(`   Deleted an older ${plan.name}.`)).catch((e) => console.log(`   Couldn't delete an older ${plan.name} (${(e as Error).message}): delete it on the dashboard.`));
  }
  return true;
}

/** `bunx wrangler deploy` in control/: the image (Docker), the Worker, its address. The image caches the checkout's dependencies (deps/, for the build only). */
function deployControl() {
  const deps = join(CONTROL_DIR, "builder/deps");
  mkdirSync(deps, { recursive: true });
  for (const f of ["package.json", "bun.lock"]) copyFileSync(new URL(`../${f}`, import.meta.url).pathname, join(deps, f));
  // An empty config dir: wrangler must use this token, not its own older login (which can't write containers).
  const xdg = mkdtempSync(join(tmpdir(), "erga-wrangler-"));
  let p;
  try { p = Bun.spawnSync(["bunx", WRANGLER, "deploy"], { cwd: CONTROL_DIR, stdout: "inherit", stderr: "inherit", env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, XDG_CONFIG_HOME: xdg, WRANGLER_SEND_METRICS: "false" } }); }
  finally { rmSync(deps, { recursive: true, force: true }); rmSync(xdg, { recursive: true, force: true }); }
  if (p.exitCode != 0) throw new DeployError(`${CONTROL.worker} didn't deploy (see above). Is OrbStack (Docker) running?`);
}

try {
  console.log(`(Using ${cred.from}.)`);
  step(1);
  const account = await cf.call<{ name: string }>("GET", acc, "read the account");
  for (const z of new Set([CONTROL.zone, PROD.pages.zone, STAGING.pages.zone])) await zoneIdOf(cf, accountId, z);
  let scripts = await scriptsNow();
  if (!scripts.includes(PROD.worker)) throw new DeployError(`There's no Worker called ${PROD.worker} in this account: is it erga.dev's?`);
  console.log(`   ${account?.name}: the zones are there; so is production's Worker${scripts.includes(STAGING.worker) ? `, and ${STAGING.worker}` : ""}${scripts.includes(CONTROL.worker) ? `, and ${CONTROL.worker}` : ""}.`);

  if (!tokensOnly) {
    step(2);
    const base = `${acc}/artifacts/namespaces/${SOURCE.namespace}/repos`;
    const repo = await cf.call<{ remote?: string }>("GET", `${base}/${SOURCE.repo}`, "find the source repo", undefined, { allow404: true });
    if (repo) console.log(`   It's there (${repo.remote ?? "no remote said"}).`);
    else if (ask(`   Make the Artifacts repo ${SOURCE.namespace}/${SOURCE.repo} (default branch main)?`, yes)) {
      await cf.call("POST", base, "make the source repo", { name: SOURCE.repo, default_branch: "main", description: "Erga's source: staging and main" });
      console.log("   Made. Push the history to it through the control Worker's Git endpoint (bun server/source/import.ts), or straight to Artifacts.");
    } else console.log("   Skipped: the control Worker has no repository until it's there.");

    step(3);
    const clientId = controlClientId() || (mock ? "Ov23liMockControl" : "");
    if (clientId) console.log(`   Client ID ${clientId}.`);
    else {
      console.log(`   None yet: signing in to ${CONTROL.host} won't work until there is one (admin-scope tokens work). Make a GitHub OAuth app (github.com/settings/applications/new):`);
      console.log(`   homepage https://${CONTROL.host}, callback https://${CONTROL.host}/auth/github/callback. Put its Client ID in control/wrangler.jsonc (vars.GITHUB_CLIENT_ID),`);
      console.log(`   run this again with --control, and give its client secret at step 5.`);
    }

    step(4);
    if (scripts.includes(CONTROL.worker) && !flag("--control")) console.log("   It's there (--control deploys it again).");
    else if (mock) console.log("   (mock) It's there.");
    else if (ask(`   Deploy it now (\`bunx ${WRANGLER} deploy\` in control/; needs Docker running)?`, yes)) { deployControl(); scripts = await scriptsNow(); }
    else console.log("   Skipped: nothing deploys until it's there.");

    step(5);
    // The one SNAPSHOT_TOKEN, for the control Worker and both app Workers: set in step 5, and given to staging's first deploy in step 6.
    let snapshot: string | null = null;
    if (!scripts.includes(CONTROL.worker)) console.log(`   Skipped: there's no ${CONTROL.worker} to set them on yet.`);
    else {
      const had = await secretsOf(CONTROL.worker);
      const secrets: Record<string, string> = { ...(had.includes("SESSION_SECRET") ? {} : { SESSION_SECRET: secret() }) };
      const github = read("GITHUB_CLIENT_SECRET", "mock-control-github-client-secret");
      if (github) secrets.GITHUB_CLIENT_SECRET = github;
      const mirror = read("GITHUB_MIRROR_TOKEN");
      if (mirror) secrets.GITHUB_MIRROR_TOKEN = mirror;
      // One SNAPSHOT_TOKEN on the control Worker and every app Worker that's there: kept when all of them have one (a run
      // of this after the setup, for a new client secret or --control, rotates nothing), new otherwise.
      const apps = APP_WORKERS.filter((w) => scripts.includes(w));
      // (Staging's first deploy, step 6, needs the value: with no erga-staging yet, a new one.)
      const snapshotKept = had.includes("SNAPSHOT_TOKEN") && scripts.includes(STAGING.worker) && (await Promise.all(apps.map((w) => secretsOf(w)))).every((l) => l.includes("SNAPSHOT_TOKEN"));
      snapshot = snapshotKept ? null : secret();
      const setting = [...Object.keys(secrets), ...(snapshot ? ["SNAPSHOT_TOKEN"] : [])];
      const kept = [...(had.includes("SESSION_SECRET") ? ["SESSION_SECRET"] : []), ...(snapshotKept ? ["SNAPSHOT_TOKEN"] : [])];
      if (!setting.length) console.log(`   Nothing to set (${kept.join(" and ")} kept as they are${read("GITHUB_CLIENT_SECRET") ? "" : "; GITHUB_CLIENT_SECRET in the environment sets the GitHub app's secret"}).`);
      else {
        console.log(`   Ready: ${setting.join(", ")}${kept.length ? ` (${kept.join(" and ")} kept as ${kept.length > 1 ? "they are" : "it is"})` : ""} (new ones made here; none are printed).`);
        if (ask(`   Set them on ${CONTROL.worker}${snapshot && apps.length ? `, and SNAPSHOT_TOKEN on ${apps.join(" and ")} too` : ""}?`, yes)) {
          for (const [name, text] of Object.entries({ ...secrets, ...(snapshot ? { SNAPSHOT_TOKEN: snapshot } : {}) })) await putSecret(CONTROL.worker, name, text);
          if (snapshot) for (const w of apps) await putSecret(w, "SNAPSHOT_TOKEN", snapshot);
          console.log(`   Set: ${CONTROL.worker}: ${setting.join(", ")}${snapshot && apps.length ? `; ${apps.join(", ")}: SNAPSHOT_TOKEN` : ""}.`);
        } else console.log("   Skipped.");
      }
    }

    step(6);
    if (scripts.includes(STAGING.worker)) console.log("   It's there: nothing to do (the control Worker deploys it from now on).");
    else if (flag("--no-deploy")) console.log("   Skipped (--no-deploy).");
    else {
      // The copy goes through production's snapshot endpoint: production must have the same token first.
      if (!snapshot) { snapshot = secret(); await putSecret(PROD.worker, "SNAPSHOT_TOKEN", snapshot); if (scripts.includes(CONTROL.worker)) await putSecret(CONTROL.worker, "SNAPSHOT_TOKEN", snapshot); }
      const stagingSecrets = { SESSION_SECRET: secret(), FACTORY_KEY: randomBytes(32).toString("base64"), SNAPSHOT_TOKEN: snapshot, DEPLOY_HOOK_SECRET: mock ? MOCK_HOOK_SECRET : secret() };
      const github = read("STAGING_GITHUB_CLIENT_SECRET", "mock-staging-github-client-secret");
      const deployed = await deployFromMachine({ name: "staging", secrets: { ...stagingSecrets, ...(github ? { GITHUB_CLIENT_SECRET: github } : {}) }, yes, net, token, accountId, snapshotToken: snapshot, log: (l) => console.log(`   ${l}`) });
      if (!deployed) process.exit(1);
      scripts = await scriptsNow();
    }
  }

  step(7);
  scripts = await scriptsNow();
  const missing = tokenPlan().workers.filter((w) => !scripts.includes(w));
  if (missing.length) throw new DeployError(`There's no ${missing.join(" or ")} yet: a token can only name a Worker that's there. Run this without --tokens first.`);
  await makeToken(tokenPlan(scripts.filter((s) => !tokenPlan().workers.includes(s) && /^erga/.test(s))));

  step(8);
  const health = await (await net(`https://${CONTROL.host}/api/health`)).json().catch(() => null) as { ok?: boolean; version?: string } | null;
  console.log(`   https://${CONTROL.host}/api/health: ${health ? `ok ${health.ok}${health.version ? `, version ${health.version}` : ""}` : "(no answer)"}.`);
  for (const t of [STAGING, PROD]) {
    const version = await (await net(`https://${t.host}/api/deploys/version`)).json().catch(() => null) as { version?: string; target?: string } | null;
    console.log(`   https://${t.host} runs ${version?.version ?? "(no answer)"}; it says it's ${version?.target ?? "?"}.`);
  }
  console.log(`\nDone. Next: push the staging branch (git push https://${CONTROL.host}/git/erga.git staging) and watch https://${CONTROL.host}/. Then bun deploy/setup.ts --cleanup, once the control Worker has deployed both targets.`);
} catch (e) {
  console.error(`\nStopped: ${(e as Error).message}`);
  process.exit(1);
}
