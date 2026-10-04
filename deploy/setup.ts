#!/usr/bin/env bun
// One-time setup for staging.erga.dev, its first deploy, and the narrow
// Cloudflare tokens Erga's servers deploy themselves with: the README's
// runbook, as a script. It says what it will do first, then does each step
// only after you say yes. It never deploys erga.dev. On production it sets
// two secrets (step 7) and, only with --production, production's own deploy
// token (step 10).
//
//   CLOUDFLARE_ACCOUNT_ID=… bun deploy/setup.ts
//   bun deploy/setup.ts --dry-run          (says what it would do, asks nothing, changes nothing)
//   bun deploy/setup.ts --tokens           (only the deploy tokens: make them again, check them, store them)
//   bun deploy/setup.ts --production       (also production's deploy token, stored on erga: task #3's switch)
//   --certificate                          (order the advanced certificate for staging's pages: paid)
//   --builder                              (deploy the builder again, e.g. after deploy/builder/ changed)
//   --no-deploy                            (skip staging's deploy from this machine)
//
// The credential is yours, never a server's: CLOUDFLARE_API_TOKEN if set,
// else the cf CLI's login (deploy/credential.ts). Making the deploy tokens
// needs one that may make account API tokens (the cf CLI asks for that when
// you log in: `bunx cf auth login --force` if your login is older; or an API
// token with Account API Tokens Write). The rest needs Workers, D1, Workers
// Routes, DNS, Zone read and Artifacts (the cf CLI's login has them).
//
// The tokens (deploy/tokens.ts): staging's may deploy erga-staging only;
// production's may deploy erga and erga-staging. Each also has D1 Write
// (account-wide: Cloudflare has no per-database scope) and read on the two
// zones. Each is checked with itself before it's stored, and never printed.
//
// ERGA_DEPLOY_MOCK=1: all of it against the mock Cloudflare's copy of Erga's
// account (deploy/mock.ts), with --yes taking the defaults: the tests run it so.

import { randomBytes } from "node:crypto";
import { Cloudflare, DeployError, zoneIdOf, type Fetch } from "./cloudflare";
import { machineCredential } from "./credential";
import { MOCK_HOOK_SECRET, mockCloudflare } from "./mock";
import { ask, deployFromMachine } from "./run";
import { BUILDER, SOURCE, TARGETS } from "./targets";
import { checkToken, createToken, describePlan, olderTokens, permissionIds, policiesFor, tokenPlan, type TokenPlan } from "./tokens";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const dry = flag("--dry-run"), yes = flag("--yes"), tokensOnly = flag("--tokens"), withProduction = flag("--production");
const mock = process.env.ERGA_DEPLOY_MOCK == "1";
const STAGING = TARGETS.staging, PROD = TARGETS.production;
const secret = () => randomBytes(32).toString("hex");
/** The wrangler that deploys the builder (its containers need a recent one). */
export const WRANGLER = "wrangler@4.147.0";

const PLAN = [
  `Check the credential, the account, and its zones ${STAGING.zone} and ${STAGING.pages.zone} (reads only).`,
  `Erga's source: the Artifacts repo ${SOURCE.namespace}/${SOURCE.repo} (made if it isn't there). Servers reach it through their Artifacts binding, not a token.`,
  `Staging's GitHub OAuth app: its Client ID in deploy/targets.json (homepage https://${STAGING.host}, callback https://${STAGING.host}/auth/github/callback).`,
  `A certificate for *.${STAGING.pages.domain} (documents' pages on staging): Universal SSL covers only *.${STAGING.pages.zone}. An advanced certificate is paid: ordered only with --certificate.`,
  `The builder Worker (${BUILDER}, deploy/builder/): deployed with \`bunx ${WRANGLER} deploy\` there (Docker builds its image) if it isn't there, or with --builder.`,
  `Staging's secrets: a SESSION_SECRET (kept if it has one), its GitHub app's client secret, an Anthropic key if you want the agent, and two shared with production: SNAPSHOT_TOKEN and DEPLOY_HOOK_SECRET.`,
  `Production's Worker (${PROD.worker}): set SNAPSHOT_TOKEN and DEPLOY_HOOK_SECRET on it (a new version of the same code; nothing else changes), so staging can read its documents and production can pass staging's pushes on.`,
  `The staging deploy, from this machine: build HEAD, make ${STAGING.worker} and its database ${STAGING.database} with a copy of production's data, ${STAGING.host}, *.${STAGING.pages.domain}.`,
  `Staging's deploy token (${tokenPlan("staging").name}): Editor on ${tokenPlan("staging").workers.join(", ")} only, D1, read on its zones. Made, checked with itself, stored on ${STAGING.worker} as CLOUDFLARE_DEPLOY_TOKEN.`,
  `Production's deploy token (${tokenPlan("production").name}): Editor on ${tokenPlan("production").workers.join(" and ")}, D1, read on its zones; stored on ${PROD.worker}. Only with --production.`,
  `Check it: https://${STAGING.host}/api/deploys/version answers this release, and staging says it can deploy itself.`,
];
const TOKEN_STEPS = [1, 9, 10, 11];

console.log(`Setting up ${STAGING.host}${mock ? " (the mock Cloudflare: nothing real)" : ""}${tokensOnly ? ", the deploy tokens only" : ""}. The steps:\n`);
PLAN.forEach((p, i) => { if (!tokensOnly || TOKEN_STEPS.includes(i + 1)) console.log(`  ${i + 1}. ${p}`); });
console.log("\nThe deploy tokens grant exactly this:");
for (const p of [tokenPlan("staging"), tokenPlan("production")]) {
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
const putSecret = (worker: string, name: string, text: string) => cf.call("PUT", `${acc}/workers/scripts/${worker}/secrets`, `set ${name} on ${worker}`, { name, text, type: "secret_text" });

/** Makes a deploy token, checks it with itself, stores it on its Worker, and deletes older ones by the same name. */
async function makeToken(plan: TokenPlan): Promise<boolean> {
  for (const l of describePlan(plan)) console.log(`   - ${l}`);
  if (!ask(`   Make ${plan.name} and store it on ${plan.storedOn}?`, yes)) { console.log("   Skipped."); return false; }
  const ids = await permissionIds(cf, accountId);
  const policies = await policiesFor(cf, accountId, plan, ids);
  const made = await createToken(cf, accountId, plan, policies);
  const wrong = await checkToken({ net, admin: cf, accountId, plan, id: made.id, value: made.value, policies });
  if (wrong.length) {
    await cf.call("DELETE", `${acc}/tokens/${made.id}`, `delete the token ${plan.name}`).catch(() => {});
    throw new DeployError(`The new token ${plan.name} isn't right, so it was deleted and not stored: ${wrong.join("; ")}.`);
  }
  console.log(`   Made and checked: it deploys ${plan.workers.join(" and ")}, reads ${plan.zones.join(" and ")}, and can't reach ${plan.notWorkers.join(", ") || "any other Worker"} or write DNS and routes.`);
  await putSecret(plan.storedOn, "CLOUDFLARE_DEPLOY_TOKEN", made.value);
  console.log(`   Stored on ${plan.storedOn} as CLOUDFLARE_DEPLOY_TOKEN (not printed).`);
  for (const old of await olderTokens(cf, accountId, plan, made.id)) {
    await cf.call("DELETE", `${acc}/tokens/${old}`, `delete an older ${plan.name}`).then(() => console.log(`   Deleted an older ${plan.name}.`)).catch((e) => console.log(`   Couldn't delete an older ${plan.name} (${(e as Error).message}): delete it on the dashboard.`));
  }
  return true;
}

try {
  console.log(`(Using ${cred.from}.)`);
  step(1);
  const account = await cf.call<{ name: string }>("GET", acc, "read the account");
  const appZone = await zoneIdOf(cf, accountId, STAGING.zone), pagesZone = await zoneIdOf(cf, accountId, STAGING.pages.zone);
  const scriptsNow = async () => ((await cf.call<{ id: string }[]>("GET", `${acc}/workers/scripts`, "list the Workers")) ?? []).map((s) => s.id);
  const scripts = await scriptsNow();
  if (!scripts.includes(PROD.worker)) throw new DeployError(`There's no Worker called ${PROD.worker} in this account: is it erga.dev's?`);
  console.log(`   ${account?.name}: zones ${STAGING.zone} (${appZone}) and ${STAGING.pages.zone} (${pagesZone}); production's Worker is there${scripts.includes(STAGING.worker) ? `; so is ${STAGING.worker}` : ""}.`);
  const shared = { SNAPSHOT_TOKEN: secret(), DEPLOY_HOOK_SECRET: mock ? MOCK_HOOK_SECRET : secret() };

  if (!tokensOnly) {
    step(2);
    const base = `${acc}/artifacts/namespaces/${SOURCE.namespace}/repos`;
    const repo = await cf.call<{ remote?: string }>("GET", `${base}/${SOURCE.repo}`, "find the source repo", undefined, { allow404: true });
    if (repo) console.log(`   It's there (${repo.remote ?? "no remote said"}).`);
    else if (ask(`   Make the Artifacts repo ${SOURCE.namespace}/${SOURCE.repo} (default branch main)?`, yes)) {
      await cf.call("POST", base, "make the source repo", { name: SOURCE.repo, default_branch: "main", description: "Erga's source: staging and main" });
      console.log("   Made. Push the history to it through a server's Git endpoint (bun source/import.ts), or straight to Artifacts.");
    } else console.log("   Skipped: servers have no Git endpoint, and the factory can't push, until it's there.");

    step(3);
    const clientId = STAGING.vars.GITHUB_CLIENT_ID || (mock ? "Ov23liMockStaging" : "");
    if (clientId) console.log(`   Client ID ${clientId}.`);
    else {
      console.log(`   None yet: signing in to staging won't work until there is one. Make a GitHub OAuth app (github.com/settings/applications/new):`);
      console.log(`   homepage https://${STAGING.host}, callback https://${STAGING.host}/auth/github/callback. Put its Client ID in deploy/targets.json`);
      console.log("   (targets.staging.vars.GITHUB_CLIENT_ID) and push it to staging; set its client secret on erga-staging (GITHUB_CLIENT_SECRET).");
    }

    step(4);
    const packs = (await cf.call<{ hosts?: string[]; status?: string }[]>("GET", `/zones/${pagesZone}/ssl/certificate_packs?status=all`, "list the certificates").catch(() => [])) ?? [];
    const covered = packs.some((p) => p.hosts?.includes(`*.${STAGING.pages.domain}`));
    if (covered) console.log("   There's one already.");
    else if (!flag("--certificate")) console.log(`   None, and none ordered (it costs money: --certificate orders it). Documents' pages on staging won't load over HTTPS until there's one.`);
    else if (ask(`   Order an advanced certificate for ${STAGING.pages.domain} and *.${STAGING.pages.domain}? (It needs Advanced Certificate Manager, which costs money.)`, yes)) {
      await cf.call("POST", `/zones/${pagesZone}/ssl/certificate_packs/order`, "order the certificate", {
        type: "advanced", hosts: [STAGING.pages.domain, `*.${STAGING.pages.domain}`], validation_method: "txt", validity_days: 90, certificate_authority: "google", cloudflare_branding: false,
      }).then(() => console.log("   Ordered: it's active in a few minutes (Cloudflare validates it itself, the zone being on Cloudflare).")).catch((e) => console.log(`   Not ordered: ${(e as Error).message}`));
    }

    step(5);
    if (scripts.includes(BUILDER) && !flag("--builder")) console.log("   It's there.");
    else if (mock) console.log("   (mock) It's there.");
    else if (ask(`   Deploy it now (\`bunx ${WRANGLER} deploy\` in deploy/builder; needs Docker running)?`, yes)) {
      const p = Bun.spawnSync(["bunx", WRANGLER, "deploy"], { cwd: new URL("./builder/", import.meta.url).pathname, stdout: "inherit", stderr: "inherit", env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId } });
      if (p.exitCode != 0) throw new DeployError("The builder didn't deploy (see above). Staging can still be deployed from a machine (bun deploy/run.ts staging), but can't deploy itself until it's there.");
    } else console.log("   Skipped: staging can't deploy itself until it's there.");

    step(6);
    const read = (what: string, fallback = "") => {
      // The mock never takes anything from this machine's environment; --yes for real takes what you exported.
      if (mock) return fallback;
      if (yes) return process.env[what]?.trim() ?? "";
      return prompt(`   ${what} (Enter to leave it out)`)?.trim() ?? "";
    };
    const had = scripts.includes(STAGING.worker)
      ? ((await cf.call<{ name: string }[]>("GET", `${acc}/workers/scripts/${STAGING.worker}/secrets`, `list ${STAGING.worker}'s secrets`).catch(() => [])) ?? []).map((s) => s.name)
      : [];
    const secrets: Record<string, string> = { ...(had.includes("SESSION_SECRET") ? {} : { SESSION_SECRET: secret() }), ...shared };
    const github = read("GITHUB_CLIENT_SECRET", "mock-staging-github-client-secret");
    if (github) secrets.GITHUB_CLIENT_SECRET = github;
    const anthropic = read("ANTHROPIC_API_KEY");
    if (anthropic) secrets.ANTHROPIC_API_KEY = anthropic;
    console.log(`   Ready: ${Object.keys(secrets).join(", ")}${had.includes("SESSION_SECRET") ? " (SESSION_SECRET kept as it is)" : ""} (new ones made here; none are printed).`);

    step(7);
    if (ask(`   Set SNAPSHOT_TOKEN and DEPLOY_HOOK_SECRET on ${PROD.worker} (production)?`, yes)) {
      for (const [name, text] of Object.entries(shared)) await putSecret(PROD.worker, name, text);
      console.log("   Set.");
    } else console.log("   Skipped: staging's documents step will say production doesn't serve snapshots, and pushes heard on erga.dev won't reach staging.");

    step(8);
    if (flag("--no-deploy")) {
      if (!(await scriptsNow()).includes(STAGING.worker)) throw new DeployError(`--no-deploy, but there's no ${STAGING.worker} yet: deploy it once first.`);
      for (const [name, text] of Object.entries(secrets)) await putSecret(STAGING.worker, name, text);
      console.log(`   Not deployed (--no-deploy); its secrets set on ${STAGING.worker}.`);
    } else {
      const deployed = await deployFromMachine({ name: "staging", secrets, yes, net, token, accountId, snapshotToken: shared.SNAPSHOT_TOKEN, log: (l) => console.log(`   ${l}`) });
      if (!deployed) process.exit(1);
    }
  }

  step(9);
  if (!(await scriptsNow()).includes(STAGING.worker)) throw new DeployError(`There's no ${STAGING.worker} yet: a token can only name a Worker that's there. Run this without --tokens first.`);
  await makeToken(tokenPlan("staging"));

  step(10);
  if (withProduction) await makeToken(tokenPlan("production"));
  else console.log("   Not now (--production makes it: production's switch to deploying itself).");

  step(11);
  const version = await (await net(`https://${STAGING.host}/api/deploys/version`)).json().catch(() => null) as { version?: string; target?: string } | null;
  console.log(`   https://${STAGING.host} runs ${version?.version ?? "(no answer)"}; it says it's ${version?.target ?? "?"}.`);
  console.log(`\nDone. Next: push the staging branch (git push https://${STAGING.host}/git/erga.git staging) and watch https://${STAGING.host}/source (or /api/deploys/staging/log).`);
} catch (e) {
  console.error(`\nStopped: ${(e as Error).message}`);
  process.exit(1);
}
