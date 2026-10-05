#!/usr/bin/env bun
// Git's credential helper for Erga's Git endpoint (<server>/git/erga.git),
// so `git fetch` and `git push` there need nobody at the keyboard, within the
// rules of README "Admin SSH keys": the password Git sends is an admin token
// (an hour), made at that moment by admin-login.ts with this computer's SSH
// key (through ssh-agent when it holds the key) and an agent token.
//
//   git config credential.https://erga.dev.helper ""      (no other helper for erga.dev)
//   git config --add credential.https://erga.dev.helper "!bun <checkout>/source/git-credential.ts"
//
// The task queue sets this up on the main checkout itself (README, Erga's own
// source). By hand:
//
//   bun source/git-credential.ts login [https://erga.dev]    get an agent token now (you approve it once, below)
//   bun source/git-credential.ts status [https://erga.dev]   what it holds (never the secrets themselves)
//   bun source/git-credential.ts forget [https://erga.dev]   drop both tokens
//   bun source/git-credential.ts get|store|erase             what git runs (stdin: protocol=, host=)
//
// Where the secrets are: the macOS keychain (login keychain, through
// /usr/bin/security; never a file, never a command line). Two items per
// server: "erga-agent-token" (the agent token, until it's revoked: on its own
// it can't administer anything) and "erga-admin-token" (the last admin token
// and when it ends, used until five minutes before then; git's `erase`, on a
// 401, drops it).
//
// No agent token yet (or it was revoked): it asks the server for one (the
// device flow, POST /api/auth/request), says where to approve it on stderr
// and in $ERGA_LOGIN_NOTICE (a JSON file the task queue's board and `tq
// watch` show), and waits for the approval (15 minutes at most). That's the
// one step a person takes, once per computer: an agent token needs a GitHub
// sign-in.
//
// Settings: ERGA_CREDENTIAL_CACHED_ONLY=1 answers only an admin token it has
// already, never makes one (the queue's background fetches, so they don't
// make an admin token every hour of the day); ERGA_KEY, the SSH key
// (admin-login.ts's choice if unset); ERGA_TOKEN, an agent token to use
// instead of the keychain's; ERGA_CREDENTIAL_DIR, keep the tokens as files in
// that directory instead of the keychain (for the tests only).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { adminLogin, AdminLoginError } from "../admin-login";

const AGENT = "erga-agent-token", ADMIN = "erga-admin-token";
/** An admin token is used until this long before it ends. */
const MARGIN = 5 * 60_000;
const say = (s: string) => process.stderr.write(`erga: ${s}\n`);

/** Where the tokens are kept: the keychain, or (tests) a directory. */
export interface Store { get(service: string, account: string): string | null; set(service: string, account: string, value: string): void; remove(service: string, account: string): void }

export function keychain(): Store {
  const run = (args: string[], stdin?: string) => Bun.spawnSync(["security", ...args], { stdin: stdin ? new TextEncoder().encode(stdin) : undefined, stdout: "pipe", stderr: "pipe" });
  const q = (s: string) => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;
  return {
    get: (s, a) => { const p = run(["find-generic-password", "-s", s, "-a", a, "-w"]); return p.exitCode == 0 ? p.stdout.toString().trim() || null : null; },
    // Through `security -i`'s stdin, so the secret is in no process's arguments.
    set: (s, a, v) => { run(["-i"], `add-generic-password -U -s ${q(s)} -a ${q(a)} -l ${q(`${s} (${a})`)} -w ${q(v)}\n`); },
    remove: (s, a) => { run(["delete-generic-password", "-s", s, "-a", a]); },
  };
}

export function directory(dir: string): Store {
  const file = (s: string, a: string) => join(dir, `${s}--${a.replace(/[^A-Za-z0-9.-]/g, "_")}`);
  return {
    get: (s, a) => { try { return readFileSync(file(s, a), "utf8").trim() || null; } catch { return null; } },
    set: (s, a, v) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(file(s, a), v, { mode: 0o600 }); },
    remove: (s, a) => rmSync(file(s, a), { force: true }),
  };
}

export const defaultStore = () => process.env.ERGA_CREDENTIAL_DIR ? directory(process.env.ERGA_CREDENTIAL_DIR) : keychain();

export interface Options {
  store: Store;
  /** e.g. https://erga.dev (no path). */
  origin: string;
  key?: string | null;
  cachedOnly?: boolean;
  notice?: string;
  net?: typeof fetch;
  now?: () => number;
  /** How long to wait between polls for the approval. */
  pollMs?: number;
}

const account = (origin: string) => new URL(origin).host;

/** The admin token kept for `origin`, if it has more than MARGIN left. */
export function cachedAdminToken(o: Options): string | null {
  const v = o.store.get(ADMIN, account(o.origin));
  const [until, token] = v?.split(" ") ?? [];
  return token && Number(until) - MARGIN > (o.now ?? Date.now)() ? token : null;
}

/** An agent token from the device flow: asks, says where to approve, waits. */
export async function requestAgentToken(o: Options): Promise<string> {
  const net = o.net ?? fetch;
  const r = await net(`${o.origin}/api/auth/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: `Git on ${hostname().replace(/\.local$/, "")}` }), signal: AbortSignal.timeout(30_000) });
  const ask = await r.json().catch(() => ({})) as { code?: string; user_code?: string; approve_url?: string; expires_in?: number; interval?: number; error?: string };
  if (!r.ok || !ask.code || !ask.approve_url) throw new Error(`${o.origin} gave no agent token request: ${ask.error ?? r.status}`);
  const expires = (o.now ?? Date.now)() + (ask.expires_in ?? 900) * 1000;
  say(`this computer needs an Erga agent token for Git: open ${ask.approve_url} (signed in to ${account(o.origin)}) and approve it (code ${ask.user_code}). Waiting…`);
  if (o.notice) writeFileSync(o.notice, JSON.stringify({ origin: o.origin, approve_url: ask.approve_url, user_code: ask.user_code, expires: new Date(expires).toISOString() }) + "\n");
  try {
    while ((o.now ?? Date.now)() < expires) {
      await Bun.sleep(o.pollMs ?? (ask.interval ?? 2) * 1000);
      const p = await net(`${o.origin}/api/auth/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: ask.code }), signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (!p || p.status == 202 || p.status >= 500) continue;
      const got = await p.json().catch(() => ({})) as { token?: string; error?: string };
      if (p.ok && got.token) { say(`approved: the agent token is in the keychain.`); return got.token; }
      throw new Error(`the agent token request ended: ${got.error ?? p.status}`);
    }
    throw new Error(`nobody approved ${ask.approve_url} in time: try again (git asks again by itself)`);
  } finally {
    if (o.notice) rmSync(o.notice, { force: true });
  }
}

/** An agent token: ERGA_TOKEN, the store's, or a new one from the device flow (kept). */
async function agentToken(o: Options, fresh = false): Promise<string> {
  const given = process.env.ERGA_TOKEN?.trim();
  if (given && !given.startsWith("erga_admin_")) return given;
  const kept = fresh ? null : o.store.get(AGENT, account(o.origin));
  if (kept) return kept;
  const token = await requestAgentToken(o);
  o.store.set(AGENT, account(o.origin), token);
  return token;
}

/** The admin token to give git: the kept one, or a new one (kept), or null (cachedOnly, and none kept). */
export async function adminToken(o: Options): Promise<string | null> {
  const cached = cachedAdminToken(o);
  if (cached || o.cachedOnly) return cached;
  const login = (agent: string) => adminLogin({ origin: o.origin, agentToken: agent, key: o.key ?? process.env.ERGA_KEY, hours: 1, net: o.net, say });
  let unlocked;
  try { unlocked = await login(await agentToken(o)); } catch (e) {
    // The key isn't one of the admin's keys there: say how to add it (a person, in a browser: README, Admin SSH keys).
    if (e instanceof AdminLoginError && e.status == 403 && /admin keys/.test(e.message))
      throw new Error(`${e.message} Add this computer's key once, in a browser: ${o.origin}/admin/keys (a key on your GitHub account counts as a first key).`);
    // The agent token was revoked (401): forget it, ask for a new one, once.
    if (!(e instanceof AdminLoginError && e.status == 401) || process.env.ERGA_TOKEN) throw e;
    o.store.remove(AGENT, account(o.origin));
    say("the kept agent token no longer works (revoked?): asking for a new one.");
    unlocked = await login(await agentToken(o, true));
  }
  o.store.set(ADMIN, account(o.origin), `${Date.parse(unlocked.until)} ${unlocked.token}`);
  return unlocked.token;
}

/** Git's key=value lines. */
export const parse = (text: string) => Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

if (import.meta.main) {
  const [cmd = "", arg] = process.argv.slice(2);
  const store = defaultStore();
  const opts = (origin: string): Options => ({ store, origin: origin.replace(/\/+$/, ""), cachedOnly: !!process.env.ERGA_CREDENTIAL_CACHED_ONLY, notice: process.env.ERGA_LOGIN_NOTICE });
  try {
    if (cmd == "get" || cmd == "erase" || cmd == "store") {
      const input = parse(await new Response(Bun.stdin.stream()).text());
      if (!input.host || !/^https?$/.test(input.protocol ?? "")) process.exit(0);
      const o = opts(`${input.protocol}://${input.host}`);
      if (cmd == "erase") { const kept = store.get(ADMIN, account(o.origin)); if (!input.password || kept?.endsWith(` ${input.password}`)) store.remove(ADMIN, account(o.origin)); }
      if (cmd == "get") { const token = await adminToken(o); if (token) process.stdout.write(`username=admin\npassword=${token}\n`); }
      process.exit(0);
    }
    const o = opts(arg ?? "https://erga.dev");
    if (cmd == "login") { const t = await adminToken({ ...o, cachedOnly: false }); console.log(t ? `Ready: git can fetch from and push to ${o.origin}/git/erga.git.` : "No token."); process.exit(t ? 0 : 1); }
    if (cmd == "status") {
      const kept = store.get(ADMIN, account(o.origin))?.split(" ")[0];
      console.log(JSON.stringify({ origin: o.origin, agentToken: !!store.get(AGENT, account(o.origin)), adminTokenUntil: kept ? new Date(Number(kept)).toISOString() : null, adminTokenUsable: !!cachedAdminToken(o) }));
      process.exit(0);
    }
    if (cmd == "forget") { store.remove(AGENT, account(o.origin)); store.remove(ADMIN, account(o.origin)); console.log(`Forgot ${o.origin}'s tokens.`); process.exit(0); }
    console.error("usage: bun source/git-credential.ts get|store|erase | login|status|forget [https://erga.dev]");
    process.exit(64);
  } catch (e) {
    say((e as Error).message);
    process.exit(cmd == "get" ? 0 : 1); // to git, no answer is the answer: it fails the fetch or push with our message above
  }
}
