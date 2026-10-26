#!/usr/bin/env bun
// One-time setup of the control Worker (erga-control, control/), its secrets
// and the one deploy token Erga deploys with: the runbook, as a script. It
// says what it will do first, then does each step only after you say yes.
// It never deploys production's app (bun deploy/run.ts production does). On
// the app Workers it sets one secret (SNAPSHOT_TOKEN, shared with the control
// Worker). Every name it uses is in deploy/targets.json (docs/self-host.md).
//
//   bun deploy/setup.ts                    (the account is deploy/targets.json's; CLOUDFLARE_ACCOUNT_ID overrides it)
//   bun deploy/setup.ts --dry-run          (says what it would do, asks nothing, changes nothing)
//   bun deploy/setup.ts --control          (deploy the control Worker again: after control/ or its image changed)
//   bun deploy/setup.ts --oauth            (only step 7: the OAuth client's secret, if it has one, from CLOUDFLARE_OAUTH_CLIENT_SECRET)
//   --no-deploy                            (skip staging's first deploy from this machine, if erga-staging is missing)
//   bun deploy/setup.ts --hook-secret      (only a new DEPLOY_HOOK_SECRET on the two app Workers, for their sign-in settings)
//   bun deploy/setup.ts --cleanup          (delete what the control Worker replaced: the erga-builder Worker, and the app
//                                           Workers' own deploy tokens)
//
// The credential is yours, never a server's: CLOUDFLARE_API_TOKEN if set,
// else the cf CLI's login. It needs Workers, D1, Containers, Workers Routes,
// DNS, Zone read and Artifacts (the cf CLI's login has them).
//
// The control Worker's Cloudflare credential is an OAuth grant, not a token
// anyone assembles: once it runs, an admin clicks Connect Cloudflare on the
// Ops page and consents in the browser (control/deploys/credential.ts). Erga's OAuth
// client ("Erga", public, PKCE) is made once on the dashboard (Manage account ›
// OAuth clients) and its id goes in deploy/targets.json; nothing here
// makes tokens. (Making account API tokens through the API was refused on
// 2026-10-12, 403 9109, with the right permission: that way is gone.)
//
// ERGA_DEPLOY_MOCK=1: all of it against the mock Cloudflare's copy of Erga's
// account, with --yes taking the defaults: the tests run it so.

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_OAUTH_SCOPES } from "../control/deploys/credential";
import { Cloudflare, DeployError, findDatabase, zoneIdOf, type Fetch } from "../control/deploys/pipeline";
import { machineCredential } from "./local-credential";
import { MOCK_HOOK_SECRET, mockCloudflare } from "../dev/mock-cloudflare";
import { ask, deployFromMachine } from "./run";
import { controlWranglerConfig } from "./release";
import { ACCOUNT, CONTROL, SOURCE, TARGETS } from "./targets";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const dry = flag("--dry-run"), yes = flag("--yes"), oauthOnly = flag("--oauth");
const mock = process.env.ERGA_DEPLOY_MOCK == "1";
const STAGING = TARGETS.staging, PROD = TARGETS.production;
const APP_WORKERS = [PROD.worker, STAGING.worker];
const secret = () => randomBytes(32).toString("hex");
/** The wrangler that deploys the control Worker (its containers need a recent one). */
export const WRANGLER = "wrangler@4.147.0";
const CONTROL_DIR = new URL("../control/", import.meta.url).pathname;
/** The release store's bucket (the control Worker's RELEASES; control/deploys/releases.ts). */
const RELEASES_BUCKET = CONTROL.releases;
/** The filled-in config wrangler deploys (controlWranglerConfig), next to control/wrangler.jsonc so its paths hold; deleted after. */
const DEPLOY_CONFIG = join(CONTROL_DIR, "wrangler.deploy.json");
/** The account: CLOUDFLARE_ACCOUNT_ID if set, else deploy/targets.json's. */
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || ACCOUNT;

/** One of the control Worker's vars in deploy/targets.json (control.vars: its GitHub App's and OAuth client's ids), or "". */
const controlVar = (name: string): string => String(CONTROL.vars[name] ?? "").trim();
const controlClientId = () => controlVar("GITHUB_APP_CLIENT_ID");

const PLAN = [
  `Check the credential, the account, and its zones ${[...new Set([CONTROL.zone, STAGING.zone, PROD.pages.zone, STAGING.pages.zone])].join(", ")} (reads only).`,
  `Erga's source: the Artifacts repo ${SOURCE.namespace}/${SOURCE.repo} (made if it isn't there). The control Worker reaches it through its Artifacts binding, not a token. And the release store's R2 bucket, ${RELEASES_BUCKET} (made if it isn't there), which the control Worker binds.`,
  `The control Worker's GitHub App: its id, slug and client id in deploy/targets.json (control.vars; homepage https://${CONTROL.host}, callback https://${CONTROL.host}/auth/github/callback).`,
  `The control Worker (${CONTROL.worker}, control/): deployed with \`bunx ${WRANGLER} deploy\` there (Docker builds its container image) if it isn't there, or with --control. It gets ${CONTROL.host}.`,
  `The control Worker's secrets: a SESSION_SECRET (kept if it has one), its GitHub app's client secret, a GitHub mirror token if you want the mirror, and SNAPSHOT_TOKEN, which it shares with ${APP_WORKERS.join(" and ")} (set on all three: staging's data copy goes through it).`,
  `Staging's first deploy, from this machine, only if ${STAGING.worker} isn't there: build HEAD, make it and its database with a copy of production's data.`,
  `The Cloudflare credential: an OAuth grant, by an admin's consent at https://${CONTROL.host}/install once the Worker runs (nothing is made here). Erga's OAuth client's id is in deploy/targets.json (control.vars); its secret, if the client has one, from CLOUDFLARE_OAUTH_CLIENT_SECRET.`,
  `Check it: https://${CONTROL.host}/api/health answers, and each target answers its version.`,
];
const OAUTH_STEPS = [1, 7];

// --hook-secret: a new DEPLOY_HOOK_SECRET, set on both app Workers, for the sign-in settings they share server to server.
if (flag("--hook-secret")) {
  const accountId = ACCOUNT_ID, cred = mock ? null : machineCredential();
  if (mock || !/^[0-9a-f]{32}$/.test(accountId) || !cred) { console.error("--hook-secret: set the account (deploy/targets.json, or CLOUDFLARE_ACCOUNT_ID) and log in with `bunx cf auth login` (not under the mock)."); process.exit(1); }
  console.log(`A new DEPLOY_HOOK_SECRET for ${APP_WORKERS.join(" and ")} (not printed, not kept here).`);
  if (!ask("Go on?", yes)) process.exit(1);
  const value = secret(), cf = new Cloudflare(cred.token);
  for (const worker of APP_WORKERS) {
    await cf.call("PUT", `/accounts/${accountId}/workers/scripts/${worker}/secrets`, `set DEPLOY_HOOK_SECRET on ${worker}`, { name: "DEPLOY_HOOK_SECRET", text: value, type: "secret_text" });
    console.log(`Set on ${worker}.`);
  }
  process.exit(0);
}

console.log(`Setting up ${CONTROL.worker} at ${CONTROL.host}${mock ? " (the mock Cloudflare: nothing real)" : ""}${oauthOnly ? ", the OAuth client's secret only" : ""}. The steps:\n`);
PLAN.forEach((p, i) => { if (!oauthOnly || OAUTH_STEPS.includes(i + 1)) console.log(`  ${i + 1}. ${p}`); });
console.log(`\nThe credential's scopes (what an admin consents to at /install): ${CONTROL_OAUTH_SCOPES}.\n`);
if (dry) { console.log("--dry-run: nothing done."); process.exit(0); }
if (!ask("Start? (each step asks again before it changes anything)", yes)) process.exit(1);

const accountId = mock ? "0123456789abcdef0123456789abcdef" : ACCOUNT_ID;
const cred = mock ? { token: "mock-setup-token", from: "the mock" } : machineCredential();
if (!/^[0-9a-f]{32}$/.test(accountId) || !cred) { console.error("Set the account (deploy/targets.json's account, or CLOUDFLARE_ACCOUNT_ID), and CLOUDFLARE_API_TOKEN or log in with `bunx cf auth login` (see the top of this file)."); process.exit(1); }
const token = cred.token;
const net: Fetch = mock ? mockCloudflare({ fleet: true }).fetch : globalThis.fetch.bind(globalThis);
const cf = new Cloudflare(token, net);
const acc = `/accounts/${accountId}`;
const step = (n: number) => console.log(`\n${n}. ${PLAN[n - 1]}`);
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
  for (const w of [...APP_WORKERS, CONTROL.worker]) if ((await secretsOf(w)).includes("CLOUDFLARE_DEPLOY_TOKEN")) console.log(`  - ${w}'s CLOUDFLARE_DEPLOY_TOKEN: deploys run on the OAuth grant now (/install)`);
  if (!ask("Go on?", yes)) process.exit(1);
  if (scripts.includes("erga-builder")) { await cf.call("DELETE", `${acc}/workers/scripts/erga-builder?force=true`, "delete erga-builder"); console.log("  Deleted erga-builder."); }
  for (const w of [...APP_WORKERS, CONTROL.worker]) if ((await secretsOf(w)).includes("CLOUDFLARE_DEPLOY_TOKEN")) { await cf.call("DELETE", `${acc}/workers/scripts/${w}/secrets/CLOUDFLARE_DEPLOY_TOKEN`, `delete ${w}'s CLOUDFLARE_DEPLOY_TOKEN`); console.log(`  Deleted ${w}'s CLOUDFLARE_DEPLOY_TOKEN.`); }
  console.log("Done. The account's older deploy tokens (erga-deploy-staging, erga-deploy-production) can go on the dashboard: Manage Account › Account API Tokens.");
  process.exit(0);
}

/** `bunx wrangler deploy` in control/, on the filled-in config: the image (Docker), the Worker, its address. The image caches the checkout's dependencies (deps/, for the build only). */
async function deployControl() {
  const databaseId = await findDatabase(cf, acc, PROD.database);
  if (!databaseId) throw new DeployError(`The account has no D1 database called ${PROD.database} (production's: the control Worker binds it). Deploy production first: bun deploy/run.ts production.`);
  writeFileSync(DEPLOY_CONFIG, JSON.stringify(controlWranglerConfig(databaseId), null, 2));
  const deps = join(CONTROL_DIR, "builder/deps");
  mkdirSync(deps, { recursive: true });
  for (const f of ["package.json", "bun.lock"]) copyFileSync(new URL(`../${f}`, import.meta.url).pathname, join(deps, f));
  // An empty config dir: wrangler must use this token, not its own older login (which can't write containers).
  const xdg = mkdtempSync(join(tmpdir(), "erga-wrangler-"));
  let p;
  try { p = Bun.spawnSync(["bunx", WRANGLER, "deploy", "--config", DEPLOY_CONFIG], { cwd: CONTROL_DIR, stdout: "inherit", stderr: "inherit", env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, XDG_CONFIG_HOME: xdg, WRANGLER_SEND_METRICS: "false" } }); }
  finally { rmSync(deps, { recursive: true, force: true }); rmSync(xdg, { recursive: true, force: true }); rmSync(DEPLOY_CONFIG, { force: true }); }
  if (p.exitCode != 0) throw new DeployError(`${CONTROL.worker} didn't deploy (see above). Is OrbStack (Docker) running?`);
}

try {
  console.log(`(Using ${cred.from}.)`);
  step(1);
  const account = await cf.call<{ name: string }>("GET", acc, "read the account");
  for (const z of new Set([CONTROL.zone, PROD.pages.zone, STAGING.pages.zone])) await zoneIdOf(cf, accountId, z);
  let scripts = await scriptsNow();
  if (!scripts.includes(PROD.worker)) throw new DeployError(`There's no Worker called ${PROD.worker} in this account: is it ${PROD.host}'s? Deploy production first (bun deploy/run.ts production), or check deploy/targets.json's account.`);
  console.log(`   ${account?.name}: the zones are there; so is production's Worker${scripts.includes(STAGING.worker) ? `, and ${STAGING.worker}` : ""}${scripts.includes(CONTROL.worker) ? `, and ${CONTROL.worker}` : ""}.`);

  if (!oauthOnly) {
    step(2);
    const base = `${acc}/artifacts/namespaces/${SOURCE.namespace}/repos`;
    const repo = await cf.call<{ remote?: string }>("GET", `${base}/${SOURCE.repo}`, "find the source repo", undefined, { allow404: true });
    if (repo) console.log(`   It's there (${repo.remote ?? "no remote said"}).`);
    else if (ask(`   Make the Artifacts repo ${SOURCE.namespace}/${SOURCE.repo} (default branch main)?`, yes)) {
      await cf.call("POST", base, "make the source repo", {
        name: SOURCE.repo,
        default_branch: "main",
        description: "Erga's source: staging and main",
      });
      console.log(
        "   Made. Push the history to it through the control Worker's Git endpoint (bun control/source/import.ts), or straight to Artifacts."
      );
    } else console.log("   Skipped: the control Worker has no repository until it's there.");
    const buckets = ((await cf.call<{ buckets?: { name: string }[] }>("GET", `${acc}/r2/buckets?name_contains=${RELEASES_BUCKET}`, "list the R2 buckets"))?.buckets ?? []).map((b) => b.name);
    if (buckets.includes(RELEASES_BUCKET)) console.log(`   The release store's bucket ${RELEASES_BUCKET} is there.`);
    else if (ask(`   Make the R2 bucket ${RELEASES_BUCKET} (the release store)?`, yes)) {
      await cf.call("POST", `${acc}/r2/buckets`, "make the release store's bucket", { name: RELEASES_BUCKET });
      console.log("   Made.");
    } else console.log("   Skipped: the control Worker's deploy fails until it's there (its config binds it).");

    step(3);
    const clientId = controlClientId() || (mock ? "Iv1.mockgithubapp0" : "");
    if (clientId) console.log(`   The GitHub App's client id is ${clientId} (deploy/targets.json control.vars: GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID).`);
    else {
      console.log(`   None yet: signing in to ${CONTROL.host} won't work until there is one (admin-scope tokens work). Make a GitHub App (github.com/settings/apps/new; public):`);
      console.log(`   callback https://${CONTROL.host}/auth/github/callback (request user authorization during installation), webhook https://${CONTROL.host}/github/webhook (push events),`);
      console.log(`   permissions Contents read and write, Metadata read, Administration read and write. Put its id, slug and client id in deploy/targets.json (control.vars), run this again with --control, and give its secrets at step 5.`);
    }

    step(4);
    if (scripts.includes(CONTROL.worker) && !flag("--control")) console.log("   It's there (--control deploys it again).");
    else if (mock) console.log("   (mock) It's there.");
    else if (ask(`   Deploy it now (\`bunx ${WRANGLER} deploy\` in control/; needs Docker running)?`, yes)) { await deployControl(); scripts = await scriptsNow(); }
    else console.log("   Skipped: nothing deploys until it's there.");

    step(5);
    // The one SNAPSHOT_TOKEN, for the control Worker and both app Workers: set in step 5, and given to staging's first deploy in step 6.
    let snapshot: string | null = null;
    if (!scripts.includes(CONTROL.worker)) console.log(`   Skipped: there's no ${CONTROL.worker} to set them on yet.`);
    else {
      const had = await secretsOf(CONTROL.worker);
      const secrets: Record<string, string> = { ...(had.includes("SESSION_SECRET") ? {} : { SESSION_SECRET: secret() }) };
      // The GitHub App's secrets, from files (never typed, never printed): the client secret, the webhook secret, and the
      // private key as PKCS#8 (openssl pkcs8 -topk8 -nocrypt -in <GitHub's .pem>).
      const fileSecret = (what: string, fallback: string) => { const path = read(`${what}_FILE`, fallback); return path && !mock ? readFileSync(path, "utf8").replace(/\n+$/, "") : path; };
      const github = fileSecret("GITHUB_APP_CLIENT_SECRET", "mock-control-github-client-secret");
      if (github) secrets.GITHUB_APP_CLIENT_SECRET = github;
      const hook = fileSecret("GITHUB_WEBHOOK_SECRET", "");
      if (hook) secrets.GITHUB_WEBHOOK_SECRET = hook;
      const key = fileSecret("GITHUB_APP_PRIVATE_KEY", "");
      if (key) secrets.GITHUB_APP_PRIVATE_KEY = key.includes("BEGIN PRIVATE KEY") ? `${key}\n` : (() => { throw new DeployError("GITHUB_APP_PRIVATE_KEY_FILE must hold a PKCS#8 key (-----BEGIN PRIVATE KEY-----): openssl pkcs8 -topk8 -nocrypt -in <GitHub's .pem> -out key.pem"); })();
      // One SNAPSHOT_TOKEN on the control Worker and every app Worker that's there: kept when all of them have one (a run
      // of this after the setup, for a new client secret or --control, rotates nothing), new otherwise.
      const apps = APP_WORKERS.filter((w) => scripts.includes(w));
      // (Staging's first deploy, step 6, needs the value: with no erga-staging yet, a new one.)
      const snapshotKept = had.includes("SNAPSHOT_TOKEN") && scripts.includes(STAGING.worker) && (await Promise.all(apps.map((w) => secretsOf(w)))).every((l) => l.includes("SNAPSHOT_TOKEN"));
      snapshot = snapshotKept ? null : secret();
      const setting = [...Object.keys(secrets), ...(snapshot ? ["SNAPSHOT_TOKEN"] : [])];
      const kept = [...(had.includes("SESSION_SECRET") ? ["SESSION_SECRET"] : []), ...(snapshotKept ? ["SNAPSHOT_TOKEN"] : [])];
      if (!setting.length) console.log(`   Nothing to set (${kept.join(" and ")} kept as they are; GITHUB_APP_CLIENT_SECRET_FILE, GITHUB_WEBHOOK_SECRET_FILE and GITHUB_APP_PRIVATE_KEY_FILE in the environment name files to set the GitHub App's secrets from).`);
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
  {
    const secret = read("CLOUDFLARE_OAUTH_CLIENT_SECRET");
    const clientId = controlVar("CLOUDFLARE_OAUTH_CLIENT_ID");
    if (!clientId) console.log(`   No OAuth client yet: make "Erga" on the dashboard (Manage account › OAuth clients; public, PKCE, redirect https://${CONTROL.host}/install/callback, the scopes above), put its client id in deploy/targets.json (control.vars; CLOUDFLARE_OAUTH_CLIENT_SECRET only if it has a secret), and deploy the control Worker (--control, or a push to main).`);
    else console.log(`   The OAuth client ${clientId} (deploy/targets.json).`);
    if (secret && scripts.includes(CONTROL.worker)) { await putSecret(CONTROL.worker, "CLOUDFLARE_OAUTH_CLIENT_SECRET", secret); console.log(`   Stored its secret on ${CONTROL.worker} as CLOUDFLARE_OAUTH_CLIENT_SECRET (not printed).`); }
    else if (secret) console.log(`   There's no ${CONTROL.worker} to store the client secret on yet.`);
    const status = await (await net(`https://${CONTROL.host}/api/install`, { headers: { Authorization: `Bearer ${token}` } })).json().catch(() => null) as { connected?: boolean; by?: string; problem?: string } | null;
    console.log(`   The grant: ${status?.connected ? `connected by ${status.by}` : `not connected${status?.problem ? ` (${status.problem})` : ""}. An admin clicks Connect Cloudflare on the Ops page (https://${CONTROL.host}/), a consent in a popup; the deploys that waited run after that.`}`);
  }

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
