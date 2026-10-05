#!/usr/bin/env bun
// An admin token, made on your own computer with your admin SSH key (README,
// Admin SSH keys): for an agent or a script to administer, edit or deploy the
// server (the admin tools, /api/source, /api/deploys), and as Git's password
// for <server>/git/erga.git. It lasts an hour unless you ask for more (12 at most).
//
//   ERGA_TOKEN=erga_… bun admin-login.ts [https://erga.dev] [--key ~/.ssh/id_ed25519] [--hours 1]
//
// ERGA_TOKEN is one of your agent tokens (Settings). This asks the server for
// a one-time challenge, signs it with `ssh-keygen -Y sign -n erga-admin`
// (your key never leaves this computer), and prints the admin token on
// stdout, nothing else:
//
//   export ERGA_ADMIN_TOKEN=$(ERGA_TOKEN=erga_… bun admin-login.ts https://erga.dev)
//   git -c credential.helper= -c "credential.helper=!f() { echo username=admin; echo password=$ERGA_ADMIN_TOKEN; }; f" push erga HEAD:staging
//
// Without --key it takes the first of ~/.ssh/id_ed25519_sk, id_ecdsa_sk,
// id_ed25519, id_ecdsa and id_rsa, and signs with ssh-agent when the agent
// holds that key (so a key with a passphrase signs with no prompt). Git does
// all this by itself with source/git-credential.ts (README, Erga's own source).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export class AdminLoginError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

/** The public keys ssh-agent holds (their "type base64" part), or none. */
function agentKeys(): string[] {
  if (!process.env.SSH_AUTH_SOCK) return [];
  const p = Bun.spawnSync(["ssh-add", "-L"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode == 0 ? p.stdout.toString().split("\n").map((l) => l.split(" ").slice(0, 2).join(" ")).filter(Boolean) : [];
}

/**
 * The file to sign with: the key given, or the first usual one in ~/.ssh. Its .pub when ssh-agent holds that key,
 * so ssh-keygen signs through the agent (no passphrase prompt, which nobody would answer in a script).
 */
export function signingKey(given?: string | null): string | undefined {
  const key = given ? expand(given) : ["id_ed25519_sk", "id_ecdsa_sk", "id_ed25519", "id_ecdsa", "id_rsa"].map((n) => `${homedir()}/.ssh/${n}`).find(existsSync);
  if (!key || key.endsWith(".pub") || !existsSync(`${key}.pub`)) return key;
  const pub = readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  return agentKeys().includes(pub) ? `${key}.pub` : key;
}

export interface Unlocked { token: string; until: string; key: { name: string; fingerprint: string } }

/** Asks `origin` for a challenge with an agent token, signs it with the key, and answers the admin token. */
export async function adminLogin(o: { origin: string; agentToken: string; key?: string | null; hours?: number; say?: (s: string) => void; net?: typeof fetch }): Promise<Unlocked> {
  const origin = o.origin.replace(/\/+$/, ""), hours = o.hours ?? 1, net = o.net ?? fetch, say = o.say ?? (() => {});
  if (!o.agentToken) throw new AdminLoginError(`Set ERGA_TOKEN to one of your agent tokens (${origin}/settings).`);
  if (o.agentToken.startsWith("erga_admin_")) throw new AdminLoginError("ERGA_TOKEN is an admin token already: give one of your agent tokens instead.");
  const key = signingKey(o.key);
  if (!key || !existsSync(key)) throw new AdminLoginError(`No SSH key at ${key ?? "~/.ssh/id_ed25519"}: give one with --key.`);
  if (!(hours > 0 && hours <= 12)) throw new AdminLoginError("--hours: more than 0, at most 12.");
  const call = async (path: string, body: unknown): Promise<Record<string, string>> => {
    const r = await net(origin + path, { method: "POST", headers: { Authorization: `Bearer ${o.agentToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
      .catch((e) => { throw new AdminLoginError(`Couldn't reach ${origin}: ${(e as Error).message}`); });
    const out = await r.json().catch(() => ({})) as Record<string, string>;
    if (!r.ok) throw new AdminLoginError(`${origin}${path}: ${out.error ?? r.status}`, r.status);
    return out;
  };
  const challenge = await call("/api/admin/challenge", { purpose: "unlock" });
  say(`Signing ${origin}'s challenge with ${key} …`);
  const signer = Bun.spawn(["ssh-keygen", "-Y", "sign", "-n", challenge.namespace ?? "erga-admin", "-f", key], { stdin: new TextEncoder().encode(challenge.message), stdout: "pipe", stderr: "pipe" });
  const signature = await new Response(signer.stdout).text();
  const signErr = await new Response(signer.stderr).text();
  if (await signer.exited) throw new AdminLoginError(`ssh-keygen didn't sign it: ${signErr.replace(/^Signing data on standard input\n?/m, "").trim()}`);
  const unlocked = await call("/api/admin/unlock", { nonce: challenge.nonce, signature, ttl: Math.round(hours * 3600) }) as unknown as Unlocked;
  say(`Unlocked with ${unlocked.key.name} (${unlocked.key.fingerprint}) until ${new Date(unlocked.until).toLocaleString()}.`);
  return unlocked;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? null; };
  const key = flag("--key"), hours = Number(flag("--hours") ?? 1);
  const origin = args.find((a) => /^https?:\/\//.test(a)) ?? "https://erga.dev";
  const say = (s: string) => process.stderr.write(s + "\n");
  try {
    const unlocked = await adminLogin({ origin, agentToken: process.env.ERGA_TOKEN?.trim() ?? "", key, hours, say });
    process.stdout.write(unlocked.token + "\n");
  } catch (e) {
    say((e as Error).message);
    process.exit(1);
  }
}
