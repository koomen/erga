// Verifies the gate (gate/) end to end, on the real platforms:
// `bun dev/verify.ts <setting> [step...] [--browsers a,b] [--origin stub]`.
// It deploys the real gate of a setting with a test issuer whose people are scripted (dev/verify/idp.ts), in front of
// one of two origins; runs the origin's checks; and removes what it made.
//
//   erga   a complete Erga of this checkout, with people and documents (dev/verify/erga.ts): requests as its people,
//          and journeys in real browsers with the real editor (dev/verify/journeys.ts). The default with SSO on
//          Cloudflare: the gate inside Erga's Worker, with the test issuer as the organization's sign-in
//   stub   a small origin that stands in for Erga (dev/verify/stub.ts), with the gate inside it: the gate's own suite,
//          with requests (dev/verify/http.ts) and in real browsers (dev/verify/browsers.ts). It keeps a log of what
//          reached it, which Erga does not. `--origin stub`, and settings 1 and 4 (Access is in front of the stub: a
//          real Erga behind Access is not in the suite)
//
//   <setting>   the plan's number or name: 1 cf-oauth, 2 cf-sso, 3 cf-sso-same, 4 cf-access, 5 aws-sso, 6 aws-oauth
//   step        deploy, check, remove; none: all three, in that order (remove also when a check fails).
//               update: on a setting that a run kept (`bun erga verify <n> --keep`), deploys again only the code and
//               the settings that changed, on the infrastructure that is there (verify/update.ts); then check
//   --browsers  chromium,firefox,webkit,safari (the default: the first three; safari needs `safaridriver --enable`,
//               and runs with the stub only)
//
// The settings on AWS are a complete Erga on celld, as `bun erga setup` deploys an instance (dev/verify/aws.ts):
// setting 5 with the gate in front on CloudFront (the checks and the journeys of the real Erga behind a gate), and
// setting 6 with the gate inside celld (celld.ts's checks).
//
// `bun erga verify <setting>` runs the three steps as one run of the verify suite, with its prerequisites checked
// first and its result recorded (dev/verify/cli.ts); the ops page shows it. With --keep it runs no remove, and
// `bun erga verify update <setting>` runs update and check. This command stays for one step alone.
//
// Every deploy runs the code that a real instance's deploy runs: on Cloudflare the repository's pipeline
// (deploy/pipeline/); on AWS setup's own steps (deploy/aws/). No
// step changes a template, a machine or a setting at run time.
//
// A run uses only the suite's own infrastructure, which this machine's settings name (dev/verify/config.ts:
// .erga/verify.json, and the Cloudflare token): a Cloudflare account with two test zones and a Zero Trust team, and an
// AWS account with two Route 53 zones. The step `deploy` refuses a zone that holds something the suite did not make,
// and an account that does, unless the settings say that the account is shared (dev/verify/dedicated.ts). A run
// makes, changes and deletes only resources named erga-verify-..., on hosts under the test zones: each call of
// Cloudflare's API is asked of that rule before it is sent (dev/verify/safe.ts).
// A deployed setting's values (its edge key and Erga's secrets too) are in .erga/verify/verify-<n>.json of the main
// clone between the steps (on AWS: verify-aws-<n>.json too), and its results in verify-<n>-results.json there.
//
// It is not a part of the suite (`bun run test`): it needs the accounts, and takes minutes (certificates, CloudFront).

import { writeFileSync } from "node:fs";
import { allowHere, deployOnAws, loadAws, removeOnAws, runtimeRuns } from "./verify/aws.ts";
import { browserChecks } from "./verify/browsers.ts";
import { celld, machineChecks } from "./verify/celld.ts";
import { answers, deployCloudflare, removeCloudflare, updateCloudflare } from "./verify/cloudflare.ts";
import { useDedicated } from "./verify/dedicated.ts";
import { ergaChecks, healthy, seed } from "./verify/erga.ts";
import { httpChecks, signIn } from "./verify/http.ts";
import { journeys } from "./verify/journeys.ts";
import {
  acceptHost,
  dropRun,
  loadRun,
  local,
  Report,
  resultsFile,
  type Run,
  type Setting,
  saveRun,
  settings,
  warmHost,
} from "./verify/run.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args.splice(at, 2)[1];
};
const browsers = (flag("--browsers") ?? "chromium,firefox,webkit").split(",").filter(Boolean);
// The suite's accounts, for this process and the commands it starts.
await useDedicated();
const SETTINGS = settings();
const setting = SETTINGS.find((s) => String(s.n) == args[0] || s.name == args[0]);
if (!setting) {
  console.error(`Which setting? ${SETTINGS.map((s) => `${s.n} ${s.name}`).join(", ")}`);
  process.exit(2);
}
const real = setting.where == "cloudflare" && setting.who == "sso";
const origin = flag("--origin") ?? (real ? "erga" : "stub");
if (setting.where == "cloudflare" && origin != "stub" && !(origin == "erga" && real)) {
  console.error(`--origin ${origin}: stub, or erga in a setting with SSO on Cloudflare.`);
  process.exit(2);
}
const steps = args.length > 1 ? args.slice(1) : ["deploy", "check", "remove"];
const results = (rows: Report["rows"]) => writeFileSync(resultsFile(String(setting.n)), JSON.stringify(rows, null, 2));

/**
 * Setting 5: Erga on AWS behind the gate on CloudFront (aws.ts), then the people and the documents, as behind the
 * gate inside Erga's Worker on Cloudflare (erga.ts, seed). The run's values for the checks. `update`: on the deploy that a run
 * kept, only what changed; its people and its documents stay.
 */
async function deployGated(s: Setting, update = false): Promise<Run> {
  const docs = update ? loadRun(s.n)?.erga?.docs : [];
  if (!docs) throw new Error(`Setting ${s.n} is not deployed: bun erga verify ${s.n} --keep deploys it, and keeps it.`);
  const made = await deployOnAws("5", update);
  const run: Run = {
    ...s,
    // (The edge key is in the gate's store only: no check here signs with it.)
    key: "",
    gateKey: made.gateKey,
    // (The parts of a deploy on AWS are in the unit's own file: aws.ts.)
    parts: {},
    idp: made.idp!,
    stack: made.stack,
    erga: { database: "", version: made.deployed!.version, session: made.session, factory: made.factory, docs },
  };
  saveRun(run);
  const zone = local().aws;
  await answers(s.shell, "/_edge/ready", 404, "Not found", zone.shell);
  for (const host of [acceptHost(s), warmHost(s)]) await answers(host, "/_edge/ready", 404, "Not found", zone.content);
  if (!update) await seed(run);
  await healthy(run);
  return run;
}

/** Setting 5's own rows: CloudFront's runtime, the machine, and what of the gate's parts must not reach a browser. */
async function gatedChecks(run: Run, report: Report): Promise<boolean> {
  const runs = runtimeRuns(run);
  report.add(
    `CloudFront: the runtime runs the gate's ${runs.length} functions, as built`,
    runs.every((r) => r.ok),
    runs.map((r) => `${r.part}: ${r.said}`).join("; ")
  );
  const made = loadAws("5");
  if (made?.outputs?.Machine) await machineChecks(report, made);
  const self = await (await fetch(`https://${run.shell}/.well-known/oauth-protected-resource`)).text();
  report.add(
    "The gate and Erga take the address for https://, with no header for the scheme",
    self.includes(`"https://${run.shell}/mcp"`),
    self.slice(0, 120)
  );
  // A sign-in, with requests: the Lambda trades the code, and the response function signs.
  const trail = await signIn(run, "ada", new Map());
  const leaked = trail.flatMap((a) =>
    ["x-erga-identity", "x-erga-exchange", "x-erga-gate", "x-erga-front"].filter((h) => a.headers.has(h))
  );
  report.add(
    "CloudFront: the Lambda's and the gate's own headers do not reach the browser",
    trail.at(-1)?.status == 302 && !leaked.length,
    `the sign-in's last answer: ${trail.at(-1)?.status}; headers seen: ${leaked.join(", ") || "none"}`
  );
  return runs.every((r) => r.ok);
}

let failed = 0;
// Setting 6 is Erga's own deploy on AWS, with the gate inside celld: celld.ts has its checks.
const inside = setting.where == "aws" && setting.who == "oauth" ? celld("6") : null;
try {
  for (const step of steps) {
    if (inside) {
      if (step == "deploy") await inside.deploy();
      else if (step == "update") await inside.update();
      else if (step == "check") {
        const report = await inside.check(browsers);
        results(report.rows);
        failed = report.failed;
      } else if (step != "remove") throw new Error(`No step "${step}": deploy, update, check or remove.`);
    } else if (step == "deploy") {
      if (setting.where == "aws") await deployGated(setting);
      else saveRun(await deployCloudflare(setting, origin as "stub" | "erga"));
      console.log(
        `Deployed setting ${setting.n} (${setting.name}), with ${setting.where == "aws" || origin == "erga" ? "a real Erga" : "the stub"}.`
      );
    } else if (step == "update") {
      const did = setting.where == "aws" ? (await deployGated(setting, true), null) : await updateCloudflare(setting);
      console.log(`Updated setting ${setting.n} (${setting.name})${did ? `: ${did.join(", ") || "nothing changed"}` : ""}.`);
    } else if (step == "check") {
      const run = loadRun(setting.n);
      if (!run) throw new Error(`Setting ${setting.n} is not deployed: run the step "deploy" first.`);
      const report = new Report();
      if (run.where == "aws") await allowHere("5");
      const runs = run.where != "aws" || (await gatedChecks(run, report));
      // (The run says which origin it deployed, not this command's --origin.)
      if (run.erga) {
        if (runs) await ergaChecks(run, report);
        if (runs) await journeys(run, report, browsers);
      } else {
        await httpChecks(run, report);
        await browserChecks(run, report, browsers);
      }
      results(report.rows);
      failed = report.failed;
      console.log(
        `\nSetting ${run.n} (${run.name}): ${report.rows.length - failed} of ${report.rows.length} rows pass or did not run; ${failed} fail.`
      );
    } else if (step != "remove") throw new Error(`No step "${step}": deploy, update, check or remove.`);
  }
} finally {
  if (steps.includes("remove")) {
    if (inside) await inside.remove();
    else {
      await (setting.where == "aws" ? removeOnAws("5") : removeCloudflare(setting));
      dropRun(setting.n);
    }
  }
}
process.exit(failed ? 1 : 0);
