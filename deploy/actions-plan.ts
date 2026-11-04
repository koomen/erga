// What a push deploys on GitHub Actions (deploy/actions.ts does it): Erga's own targets (deploy/targets.json), or a
// fork's servers, from the answers in its repository variables. Pure: no network, no files.
//
// A fork sets these repository variables (Settings > Secrets and variables > Actions > Variables), the same answers as
// `bun erga own set` takes (deploy/own/plan.ts QUESTIONS):
//
//   ERGA_HOST                 the production address (erga.example.com). Its presence makes this a fork's deploy.
//   ERGA_STAGING              a staging address, or nothing (no staging server)
//   ERGA_PROVIDERS            github, or github,google
//   ERGA_PRESET               website or company
//   ERGA_ADMIN                the first admin's GitHub login
//   ERGA_COMPANY              the company preset's domain or GitHub organization
//   ERGA_PAGES                shared, or a second domain of the account's
//   ERGA_GITHUB_CLIENT_ID     the sign-in GitHub app's client id (its secret stays on the Worker)
//   ERGA_GOOGLE_CLIENT_ID     with Google sign-in: the Google client's id
//   CLOUDFLARE_ACCOUNT_ID     the account (32 hex digits)
//
// and the secret CLOUDFLARE_API_TOKEN. No variable ERGA_HOST: Erga's own deployment (deploy/targets.json).

import { type Answers, defaultAnswers, parseAnswer, QUESTIONS, type TargetName } from "./own/plan";
import { ACCOUNT, TARGETS } from "./targets";

export type ActionDeploy =
  | { skip: string }
  | { problem: string }
  | { kind: "erga"; target: TargetName; account: string }
  | { kind: "own"; target: TargetName; account: string; answers: Answers; ids: { github: string; google?: string } };

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** What a push of `branch` deploys, from the repository's variables (`vars`) and whether it has the token. */
export function actionDeploy(o: { branch: string; vars: Record<string, string | undefined>; token: boolean }): ActionDeploy {
  const v = (k: string) => o.vars[k]?.trim() ?? "";
  if (!o.token) return { skip: "This repository has no CLOUDFLARE_API_TOKEN secret, so it doesn't deploy." };
  const account = v("CLOUDFLARE_ACCOUNT_ID");
  if (account && !ACCOUNT_ID.test(account)) return { problem: "CLOUDFLARE_ACCOUNT_ID is the account's id: 32 hex digits." };

  if (!v("ERGA_HOST")) {
    if (account && account != ACCOUNT)
      return {
        problem: `CLOUDFLARE_ACCOUNT_ID is ${account}, not Erga's own (${ACCOUNT}). A fork sets the variable ERGA_HOST and its other answers (deploy/actions-plan.ts).`,
      };
    const target = (Object.keys(TARGETS) as TargetName[]).find((t) => TARGETS[t].branch == o.branch);
    return target
      ? { kind: "erga", target, account: ACCOUNT }
      : {
          skip: `${o.branch} doesn't deploy: only ${Object.values(TARGETS)
            .map((t) => t.branch)
            .join(" and ")} do.`,
        };
  }

  if (!account) return { problem: "Set the variable CLOUDFLARE_ACCOUNT_ID: the account's id, 32 hex digits." };
  const answers = defaultAnswers();
  const problems: string[] = [];
  for (const q of QUESTIONS) {
    const raw = v(`ERGA_${q.key.toUpperCase()}`);
    if (!raw) continue;
    const r = parseAnswer(q.key, raw);
    if ("problem" in r) problems.push(`ERGA_${q.key.toUpperCase()}: ${r.problem}`);
    else (answers as unknown as Record<string, unknown>)[q.key] = r.value;
  }
  if (!answers.admin) problems.push("Set ERGA_ADMIN: the first admin's GitHub login.");
  const github = v("ERGA_GITHUB_CLIENT_ID"),
    google = v("ERGA_GOOGLE_CLIENT_ID");
  // Without it, the upload would set GITHUB_CLIENT_ID empty, and nobody could sign in.
  if (!github) problems.push("Set ERGA_GITHUB_CLIENT_ID: the client id of the GitHub app people sign in with.");
  if (answers.providers.includes("google") && !google) problems.push("Set ERGA_GOOGLE_CLIENT_ID: Google sign-in is on (ERGA_PROVIDERS).");
  if (problems.length) return { problem: problems.join(" ") };
  const target: TargetName | null = o.branch == "main" ? "production" : o.branch == "staging" && answers.staging ? "staging" : null;
  if (!target)
    return {
      skip: `${o.branch} doesn't deploy: main deploys ${answers.host}${answers.staging ? `, staging deploys ${answers.staging}` : ""}.`,
    };
  return { kind: "own", target, account, answers, ids: { github, ...(google ? { google } : {}) } };
}

/**
 * Why a deploy from Actions mustn't go on, from the Worker's secrets (their names; null: there's no Worker yet). Actions
 * sends no secret and keeps the Worker's: a Worker without its own SESSION_SECRET and FACTORY_KEY would make a server
 * nobody can sign in to. Its first deploy runs on a machine, which makes them (`bun erga own deploy`).
 */
export function secretsProblem(names: string[] | null, worker: string): string | null {
  if (!names)
    return `There's no Worker ${worker} yet. Run the first deploy from your machine (bun erga own deploy), which sets its secrets; GitHub deploys it after that.`;
  const missing = ["SESSION_SECRET", "FACTORY_KEY"].filter((n) => !names.includes(n));
  return missing.length
    ? `The Worker ${worker} has no ${missing.join(" and ")}. Run a deploy from your machine once (bun erga own deploy), which sets them; GitHub deploys it after that.`
    : null;
}
