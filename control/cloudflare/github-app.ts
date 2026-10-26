// Erga's GitHub App, as a Worker has it (control/source/github.ts): erga.dev's
// control Worker has the App whole (its id, slug and client id in
// deploy/targets.json, control.vars; the client secret, the private key and the webhook
// secret as its secrets). An install's control Worker has only the public
// parts (its install set them), and reaches the rest through erga.dev over
// its fork's secret (control/install/forks.ts): installation tokens, the uninstall,
// the consent's relay. Local development has the pretend GitHub
// (dev/github-mock.ts) at the dev server, ERGA_GITHUB_ORIGIN.

import { forkGithubToken, forkGithubUninstall } from "../install/forks";
import { githubOrigins, installationToken, uninstall, type GithubApp } from "../source/index.ts";
import { forkOf } from "./artifacts";
import type { Env } from "../../cloudflare/env";

export type GithubAppEnv = Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_SLUG" | "GITHUB_APP_CLIENT_ID" | "GITHUB_APP_CLIENT_SECRET" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_WEBHOOK_SECRET" | "ERGA_GITHUB_ORIGIN" | "UPSTREAM" | "INSTALL" | "FORK_SECRET">;

/** The App as this Worker knows it (the public parts at least), or null where there's none (an app Worker). */
export function githubAppOf(env: GithubAppEnv): GithubApp | null {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  if (!clientId) return null;
  const { www, api } = githubOrigins(env.ERGA_GITHUB_ORIGIN);
  return {
    appId: env.GITHUB_APP_ID?.trim() ?? "", slug: env.GITHUB_APP_SLUG?.trim() || "erga-editor", clientId,
    ...(env.GITHUB_APP_CLIENT_SECRET ? { clientSecret: env.GITHUB_APP_CLIENT_SECRET } : {}),
    ...(env.GITHUB_APP_PRIVATE_KEY ? { privateKey: env.GITHUB_APP_PRIVATE_KEY } : {}),
    ...(env.GITHUB_WEBHOOK_SECRET ? { webhookSecret: env.GITHUB_WEBHOOK_SECRET } : {}),
    www, api,
  };
}


/** An installation token: minted here with the App's key, or at upstream over the fork's secret (an install). */
export async function githubTokenFor(env: GithubAppEnv, installationId: number): Promise<{ token: string; expiresAt: number }> {
  const app = githubAppOf(env);
  if (app?.privateKey) return installationToken(app, installationId);
  const fork = forkOf(env);
  if (fork) return forkGithubToken(fork, installationId);
  throw new Error("This server can't reach GitHub as the App: it has no private key, and no upstream to ask.");
}

/** The App uninstalled from the account: here with the key, or through upstream. */
export async function githubUninstallFor(env: GithubAppEnv, installationId: number): Promise<void> {
  const app = githubAppOf(env);
  if (app?.privateKey) return uninstall(app, installationId);
  const fork = forkOf(env);
  if (fork) await forkGithubUninstall(fork, installationId);
}
