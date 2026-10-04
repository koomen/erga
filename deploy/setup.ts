#!/usr/bin/env bun
// One-time setup for staging.erga.dev, and its first deploy: the README's
// runbook, as a script. It says what it will do first, then does each step
// only after you say yes. It never deploys erga.dev; the only change it
// makes to production is setting two secrets on its Worker (step 6), and
// only if you agree.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… bun deploy/setup.ts
//   bun deploy/setup.ts --dry-run          (says what it would do, asks nothing, changes nothing)
//
// The token: an account API token with Workers Scripts edit, D1 edit,
// Workers Routes edit, Zone read, DNS edit, SSL and Certificates edit (for
// staging's pages certificate), Artifacts read, and Account Settings read.
//
// ERGA_DEPLOY_MOCK=1: all of it against the mock Cloudflare's copy of Erga's
// account (deploy/mock.ts), with --yes taking the defaults: the tests run it so.

import { randomBytes } from "node:crypto";
import { Cloudflare, DeployError, zoneIdOf, type Fetch } from "./cloudflare";
import { MOCK_HOOK_SECRET, mockCloudflare } from "./mock";
import { ask, deployFromMachine } from "./run";
import { BUILDER, TARGETS } from "./targets";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run"), yes = args.includes("--yes");
const mock = process.env.ERGA_DEPLOY_MOCK == "1";
const STAGING = TARGETS.staging, PROD = TARGETS.production;
const secret = () => randomBytes(32).toString("hex");

const PLAN = [
  `Check the token, the account, and its zones ${STAGING.zone} and ${STAGING.pages.zone} (reads only).`,
  `Check staging's GitHub OAuth app: its Client ID in deploy/targets.json (homepage https://${STAGING.host}, callback https://${STAGING.host}/auth/github/callback).`,
  `A certificate for *.${STAGING.pages.domain} (documents' pages on staging): Universal SSL covers only *.${STAGING.pages.zone}, so order an advanced certificate (Advanced Certificate Manager, a paid add-on) if there's none.`,
  `The builder Worker (${BUILDER}, deploy/builder/): deploy it with \`bunx wrangler deploy\` there (Docker builds its image) if it isn't there.`,
  `Staging's secrets: a new SESSION_SECRET, its GitHub app's client secret, its own Cloudflare token (CLOUDFLARE_DEPLOY_TOKEN, to deploy itself), an Anthropic key if you want the agent, and two shared with production: SNAPSHOT_TOKEN and DEPLOY_HOOK_SECRET.`,
  `Production's Worker (${PROD.worker}): set SNAPSHOT_TOKEN and DEPLOY_HOOK_SECRET on it (a new version of the same code; nothing else changes), so staging can read its documents and production can pass staging's pushes on.`,
  `The first staging deploy, from this machine: build HEAD, make ${STAGING.worker} and its database ${STAGING.database} with a copy of production's data, ${STAGING.host}, *.${STAGING.pages.domain}.`,
  `Check it: https://${STAGING.host}/api/deploys/version answers this release, and staging says it's set up to deploy itself.`,
];

console.log(`Setting up ${STAGING.host}${mock ? " (the mock Cloudflare: nothing real)" : ""}. The steps:\n`);
PLAN.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
console.log("");
if (dry) { console.log("--dry-run: nothing done."); process.exit(0); }
if (!ask("Start? (each step asks again before it changes anything)", yes)) process.exit(1);

const accountId = mock ? "0123456789abcdef0123456789abcdef" : process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
const token = mock ? "mock-setup-token" : process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
if (!/^[0-9a-f]{32}$/.test(accountId) || !token) { console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN first (see the top of this file)."); process.exit(1); }
const net: Fetch = mock ? mockCloudflare({ fleet: true }).fetch : globalThis.fetch.bind(globalThis);
const cf = new Cloudflare(token, net);
const acc = `/accounts/${accountId}`;
const step = (n: number) => console.log(`\n${n}. ${PLAN[n - 1]}`);

try {
  step(1);
  const account = await cf.call<{ name: string }>("GET", acc, "read the account");
  const appZone = await zoneIdOf(cf, accountId, STAGING.zone), pagesZone = await zoneIdOf(cf, accountId, STAGING.pages.zone);
  const scripts = ((await cf.call<{ id: string }[]>("GET", `${acc}/workers/scripts`, "list the Workers")) ?? []).map((s) => s.id);
  if (!scripts.includes(PROD.worker)) throw new DeployError(`There's no Worker called ${PROD.worker} in this account: is it erga.dev's?`);
  console.log(`   ${account?.name}: zones ${STAGING.zone} (${appZone}) and ${STAGING.pages.zone} (${pagesZone}); production's Worker is there${scripts.includes(STAGING.worker) ? `; so is ${STAGING.worker}` : ""}.`);

  step(2);
  const clientId = STAGING.vars.GITHUB_CLIENT_ID || (mock ? "Ov23liMockStaging" : "");
  if (!clientId) {
    console.log(`   Make a GitHub OAuth app (github.com/settings/applications/new): homepage https://${STAGING.host}, callback https://${STAGING.host}/auth/github/callback.`);
    console.log("   Put its Client ID in deploy/targets.json (targets.staging.vars.GITHUB_CLIENT_ID), commit, and run this again. Keep its client secret for step 5.");
    process.exit(1);
  }
  console.log(`   Client ID ${clientId}.`);

  step(3);
  const packs = (await cf.call<{ hosts?: string[]; status?: string }[]>("GET", `/zones/${pagesZone}/ssl/certificate_packs?status=all`, "list the certificates").catch(() => [])) ?? [];
  const covered = packs.some((p) => p.hosts?.includes(`*.${STAGING.pages.domain}`));
  if (covered) console.log("   There's one already.");
  else if (ask(`   Order an advanced certificate for ${STAGING.pages.domain} and *.${STAGING.pages.domain}? (It needs Advanced Certificate Manager, which costs money.)`, yes)) {
    await cf.call("POST", `/zones/${pagesZone}/ssl/certificate_packs/order`, "order the certificate", {
      type: "advanced", hosts: [STAGING.pages.domain, `*.${STAGING.pages.domain}`], validation_method: "txt", validity_days: 90, certificate_authority: "google", cloudflare_branding: false,
    }).then(() => console.log("   Ordered: it's active in a few minutes (Cloudflare validates it itself, the zone being on Cloudflare).")).catch((e) => console.log(`   Not ordered: ${(e as Error).message}\n   Documents' pages on staging won't load over HTTPS until there's one (or set staging's pages to the shared workers.dev host).`));
  } else console.log("   Skipped: documents' pages on staging won't load over HTTPS until there's one.");

  step(4);
  if (scripts.includes(BUILDER)) console.log("   It's there.");
  else if (mock) console.log("   (mock) It's there.");
  else if (ask("   Deploy it now (`bunx wrangler deploy` in deploy/builder; needs Docker running)?", yes)) {
    const p = Bun.spawnSync(["bunx", "wrangler", "deploy"], { cwd: new URL("./builder/", import.meta.url).pathname, stdout: "inherit", stderr: "inherit", env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId } });
    if (p.exitCode != 0) throw new DeployError("The builder didn't deploy (see above). Staging can still be deployed from a machine (bun deploy/run.ts staging), but can't deploy itself until it's there.");
  } else console.log("   Skipped: staging can't deploy itself until it's there.");

  step(5);
  const read = (what: string, required: boolean, fallback = "") => {
    // The mock never takes anything from this machine's environment; --yes for real takes what you exported.
    if (mock) return fallback;
    if (yes) return process.env[what] ?? fallback;
    for (;;) {
      const v = prompt(`   ${what}${required ? "" : " (Enter to leave it out)"}:`)?.trim() ?? "";
      if (v || !required) return v;
    }
  };
  const shared = { SNAPSHOT_TOKEN: secret(), DEPLOY_HOOK_SECRET: mock ? MOCK_HOOK_SECRET : secret() };
  const secrets: Record<string, string> = {
    SESSION_SECRET: secret(),
    GITHUB_CLIENT_SECRET: read("GITHUB_CLIENT_SECRET", true, "mock-staging-github-client-secret"),
    CLOUDFLARE_DEPLOY_TOKEN: read("CLOUDFLARE_DEPLOY_TOKEN", true, "mock-staging-deploy-token"),
    ...shared,
  };
  const anthropic = read("ANTHROPIC_API_KEY", false);
  if (anthropic) secrets.ANTHROPIC_API_KEY = anthropic;
  console.log(`   Ready: ${Object.keys(secrets).join(", ")} (new ones made here; none are printed).`);

  step(6);
  if (ask(`   Set SNAPSHOT_TOKEN and DEPLOY_HOOK_SECRET on ${PROD.worker} (production)?`, yes)) {
    for (const [name, text] of Object.entries(shared)) await cf.call("PUT", `${acc}/workers/scripts/${PROD.worker}/secrets`, `set ${name} on ${PROD.worker}`, { name, text, type: "secret_text" });
    console.log("   Set.");
  } else console.log("   Skipped: staging's documents step will say production doesn't serve snapshots, and pushes heard on erga.dev won't reach staging.");

  step(7);
  const deployed = await deployFromMachine({ name: "staging", secrets, yes, net, token, accountId, snapshotToken: shared.SNAPSHOT_TOKEN, log: (l) => console.log(`   ${l}`) });
  if (!deployed) process.exit(1);

  step(8);
  const version = await (await net(`https://${STAGING.host}/api/deploys/version`)).json().catch(() => null) as { version?: string; target?: string } | null;
  const status = await net(`https://${STAGING.host}/api/deploys/status`, { headers: { Authorization: `Bearer ${shared.DEPLOY_HOOK_SECRET}` } }).then((r) => r.status).catch(() => 0);
  console.log(`   https://${STAGING.host} runs ${version?.version ?? "(no answer)"}; it says it's ${version?.target ?? "?"}${status == 200 ? ", and answers production's status requests" : ""}.`);
  console.log(`\nDone. Next: push the staging branch (git push <erga>/git/erga.git staging) and watch https://${STAGING.host}/admin/deploys.`);
} catch (e) {
  console.error(`\nStopped: ${(e as Error).message}`);
  process.exit(1);
}
