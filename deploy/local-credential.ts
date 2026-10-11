// The credential deploy/setup.ts and deploy/run.ts use on this machine: a
// person's own, never a server's. CLOUDFLARE_API_TOKEN if it's set; else
// the cf CLI's own login (`bunx cf auth login`), refreshed first. Making
// Erga's deploy tokens needs one that may make account
// API tokens: the cf CLI's login asks for that (account_api_tokens:create)
// since its 2026-10 versions (log in again with `bunx cf auth login --force`
// if yours is older), or an API token with Account API Tokens Write.
//
// It's never printed, nor stored anywhere by these scripts.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Where the cf CLI keeps its default login (plain JSON: oauth_token, expiration_time, scopes). */
function cfLoginFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const candidates = [
    ...(xdg ? [join(xdg, "cloudflare/config/default.json")] : []),
    join(homedir(), "Library/Preferences/cloudflare/config/default.json"),
    join(homedir(), ".config/cloudflare/config/default.json"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** The cf CLI's login, refreshed: its token and scopes, or null if there's none. */
export function cfLogin(): { token: string; scopes: string[] } | null {
  // `cf auth whoami` refreshes an expired token with the stored refresh token.
  Bun.spawnSync(["bunx", "cf", "auth", "whoami"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
  try {
    const d = JSON.parse(readFileSync(cfLoginFile(), "utf8")) as { oauth_token?: string; scopes?: string[] };
    return d.oauth_token ? { token: d.oauth_token, scopes: d.scopes ?? [] } : null;
  } catch { return null; }
}

/** This machine's credential for the account: CLOUDFLARE_API_TOKEN, else the cf CLI's login. */
export function machineCredential(): { token: string; from: string; scopes?: string[] } | null {
  const env = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (env) return { token: env, from: "CLOUDFLARE_API_TOKEN" };
  const login = cfLogin();
  return login ? { token: login.token, from: "the cf CLI's login", scopes: login.scopes } : null;
}
