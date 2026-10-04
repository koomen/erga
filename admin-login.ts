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
// (your key never leaves this computer: give the .pub file to sign with a key
// ssh-agent holds), and prints the admin token on stdout, nothing else:
//
//   export ERGA_ADMIN_TOKEN=$(ERGA_TOKEN=erga_… bun admin-login.ts https://erga.dev)
//   git -c credential.helper= -c "credential.helper=!f() { echo username=admin; echo password=$ERGA_ADMIN_TOKEN; }; f" push erga HEAD:staging

import { existsSync } from "node:fs";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? null; };
const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());
const keyArg = flag("--key"), hours = Number(flag("--hours") ?? 1);
const origin = (args.find((a) => /^https?:\/\//.test(a)) ?? "https://erga.dev").replace(/\/+$/, "");
const say = (s: string) => process.stderr.write(s + "\n");
const fail = (s: string): never => { say(s); process.exit(1); };

const agentToken = process.env.ERGA_TOKEN?.trim();
if (!agentToken) fail(`Set ERGA_TOKEN to one of your agent tokens (${origin}/settings).`);
if (agentToken!.startsWith("erga_admin_")) fail("ERGA_TOKEN is an admin token already: give one of your agent tokens instead.");
const key = keyArg ? expand(keyArg) : ["id_ed25519_sk", "id_ecdsa_sk", "id_ed25519", "id_ecdsa", "id_rsa"].map((n) => `${homedir()}/.ssh/${n}`).find(existsSync);
if (!key || !existsSync(key)) fail(`No SSH key at ${key ?? "~/.ssh/id_ed25519"}: give one with --key.`);
if (!(hours > 0 && hours <= 12)) fail("--hours: more than 0, at most 12.");

async function call(path: string, body: unknown): Promise<Record<string, string>> {
  const r = await fetch(origin + path, { method: "POST", headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch((e) => fail(`Couldn't reach ${origin}: ${e.message}`));
  const out = await r.json().catch(() => ({})) as Record<string, string>;
  if (!r.ok) fail(`${origin}${path}: ${out.error ?? r.status}`);
  return out;
}

const challenge = await call("/api/admin/challenge", { purpose: "unlock" });
say(`Signing ${origin}'s challenge with ${key} …`);
const signer = Bun.spawn(["ssh-keygen", "-Y", "sign", "-n", challenge.namespace ?? "erga-admin", "-f", key!], { stdin: new TextEncoder().encode(challenge.message), stdout: "pipe", stderr: "inherit" });
const signature = await new Response(signer.stdout).text();
if (await signer.exited) fail("ssh-keygen didn't sign it.");
const unlocked = await call("/api/admin/unlock", { nonce: challenge.nonce, signature, ttl: Math.round(hours * 3600) }) as unknown as { token: string; until: string; key: { name: string; fingerprint: string } };
say(`Unlocked with ${unlocked.key.name} (${unlocked.key.fingerprint}) until ${new Date(unlocked.until).toLocaleString()}.`);
process.stdout.write(unlocked.token + "\n");
