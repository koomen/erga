// Admins' SSH keys (admin-keys.ts) on an in-memory SQLite database with the
// same migrations D1 gets, signed with the real ssh-keygen: the first key
// from GitHub, unlocking, one try per challenge, the unlock's cookie and
// admin tokens, adding while unlocked, revoking, and losing admin.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { AdminKeys, CHALLENGE_MS, KeyError } from "../admin-keys";
import type { Param, Sql } from "../directory";
import { Users } from "../users";
import { keygen, runCommand, sign } from "./ssh-keys";
import { signCommand } from "../admin-access";

const MIGRATIONS = new URL("../migrations/", import.meta.url).pathname;
const HOST = "erga.example";

function fresh(github: Record<string, string[]> = {}) {
  const db = new Database(":memory:", { strict: true });
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(MIGRATIONS + name, "utf8"));
  const bind = (params: Param[]) => params as (string | number | null)[];
  const sql: Sql = {
    all: async <T>(q: string, ...params: Param[]) => db.query(q).all(...bind(params)) as T[],
    run: async (q, ...params) => { db.query(q).run(...bind(params)); },
    batch: async (statements) => { db.transaction(() => { for (const [q, ...params] of statements) db.query(q).run(...bind(params)); })(); },
  };
  let now = Date.now();
  const asked: string[] = [];
  const keys = new AdminKeys(sql, "test secret", { githubKeys: async (login) => { asked.push(login); return github[login] ?? []; }, now: () => now });
  return { keys, sql, db, asked, later: (ms: number) => { now += ms; } };
}

/** Signs a challenge as the person would: the server's own command, run in a shell with their key. */
const signed = (c: { message: string }, path: string) => runCommand(signCommand(c.message), path);

/** Adds a key for `login` from scratch: its challenge, signed with it. */
async function addKey(keys: AdminKeys, login: string, key: { path: string; pub: string }, opts: { unlocked?: { key: string; until: number } | null; local?: boolean; name?: string } = {}) {
  const c = await keys.challenge(login, HOST, "add-key", key.pub);
  return keys.add(login, { nonce: c.nonce, signature: signed(c, key.path), publicKey: key.pub, name: opts.name, unlocked: opts.unlocked ?? null, local: opts.local });
}

test("the first key must be on the admin's GitHub account; it unlocks, once per challenge, for this host only", async () => {
  const laptop = keygen("laptop");
  const { keys, asked, later } = fresh({ ada: ["ssh-rsa AAAAB3Nza other", laptop.pub.split(" ").slice(0, 2).join(" ")] });
  const stray = keygen("stray");
  // Not on GitHub: refused, saying where to put it.
  await expect(addKey(keys, "ada", stray)).rejects.toThrow(/github.com\/ada.keys/);
  const key = await addKey(keys, "ada", laptop);
  expect(asked).toEqual(["ada", "ada"]);
  expect(key).toMatchObject({ login: "ada", name: "laptop@test", addedHow: "github", revoked: null });
  expect(key.fingerprint).toMatch(/^SHA256:/);
  // Once there is one, GitHub isn't enough: a second key needs an unlock with the first.
  const phone = keygen("phone");
  await expect(addKey(keys, "ada", phone)).rejects.toThrow(/Unlock admin access/);

  // Unlocking: the challenge names the host, the login and when it ends.
  const c = await keys.challenge("ada", HOST, "unlock");
  expect(c.message).toMatch(new RegExp(`^erga-admin unlock host=${HOST.replace(".", "\\.")} login=ada nonce=\\S+ expires=\\S+Z$`));
  const signature = signed(c, laptop.path);
  const { unlock } = await keys.unlock("ada", c.nonce, signature);
  expect(unlock.key).toBe(key.id);
  expect(unlock.until - Date.now()).toBeGreaterThan(59 * 60_000);
  // The same signature again: the challenge is gone (no replay).
  await expect(keys.unlock("ada", c.nonce, signature)).rejects.toThrow(/used already/);
  // Someone else's challenge, or a stale one, or one signed with -n file, or a key that isn't theirs.
  const bo = await keys.challenge("bo", HOST, "unlock");
  await expect(keys.unlock("ada", bo.nonce, signed(bo, laptop.path))).rejects.toThrow(/isn't one this server gave you/);
  const stale = await keys.challenge("ada", HOST, "unlock");
  later(CHALLENGE_MS + 1000);
  await expect(keys.unlock("ada", stale.nonce, signed(stale, laptop.path))).rejects.toThrow(/expired/);
  const wrongNs = await keys.challenge("ada", HOST, "unlock");
  await expect(keys.unlock("ada", wrongNs.nonce, sign(laptop.path, wrongNs.message, "file"))).rejects.toThrow(/doesn't match/);
  const strayTry = await keys.challenge("ada", HOST, "unlock");
  await expect(keys.unlock("ada", strayTry.nonce, signed(strayTry, stray.path))).rejects.toThrow(/isn't one of your admin keys/);
  // A signature of a challenge for another server (staging's, say) doesn't fit this one's.
  const other = await keys.challenge("ada", "staging.erga.example", "unlock");
  const here = await keys.challenge("ada", HOST, "unlock");
  await expect(keys.unlock("ada", here.nonce, signed(other, laptop.path))).rejects.toThrow(/doesn't match/);
  // An add-key challenge isn't an unlock.
  const add = await keys.challenge("ada", HOST, "add-key", phone.pub);
  await expect(keys.unlock("ada", add.nonce, signed(add, laptop.path))).rejects.toThrow(/isn't one this server gave you/);
  // What failed is logged.
  const log = await keys.history();
  expect(log.filter((e) => e.action == "unlock-failed").length).toBeGreaterThanOrEqual(3);
});

test("the unlock's cookie and admin tokens: for their person, until they end or their key is revoked", async () => {
  const laptop = keygen("laptop"), spare = keygen("spare");
  const { keys, later } = fresh({ ada: [laptop.pub] });
  const key = await addKey(keys, "ada", laptop);
  const c = await keys.challenge("ada", HOST, "unlock");
  const { unlock } = await keys.unlock("ada", c.nonce, signed(c, laptop.path));
  const cookie = await keys.cookie("ada", unlock);
  expect(await keys.readCookie(cookie, "ada")).toEqual(unlock);
  // Another person's session with Ada's cookie, a cookie changed by a character, a token offered as a cookie: nothing.
  expect(await keys.readCookie(cookie, "bo")).toBeNull();
  expect(await keys.readCookie(cookie.slice(0, -2) + (cookie.endsWith("A") ? "BB" : "AA"), "ada")).toBeNull();
  const token = await keys.token("ada", "Ada", unlock);
  expect(token.startsWith("erga_admin_")).toBe(true);
  expect(await keys.readCookie(token.slice("erga_admin_".length), "ada")).toBeNull();
  expect(await keys.readToken(token)).toEqual({ login: "ada", name: "Ada", unlock });
  expect(await keys.readToken("erga_admin_" + cookie)).toBeNull();
  // Adding a second key while unlocked; then revoking the first ends both carriers at once (in this isolate; seconds elsewhere).
  const second = await addKey(keys, "ada", spare, { unlocked: unlock, name: "Spare" });
  expect(second).toMatchObject({ addedHow: "unlocked", name: "Spare" });
  await keys.revoke("ada", key.id);
  expect(await keys.readCookie(cookie, "ada")).toBeNull();
  expect(await keys.readToken(token)).toBeNull();
  // The revoked key can't unlock any more; the spare can, and its unlock ends on time.
  const again = await keys.challenge("ada", HOST, "unlock");
  await expect(keys.unlock("ada", again.nonce, signed(again, laptop.path))).rejects.toThrow(/isn't one of your admin keys/);
  const fromSpare = await keys.challenge("ada", HOST, "unlock");
  const next = await keys.unlock("ada", fromSpare.nonce, signed(fromSpare, spare.path), 5 * 60_000);
  const short = await keys.token("ada", "Ada", next.unlock);
  expect(await keys.readToken(short)).not.toBeNull();
  later(5 * 60_000 + 1);
  expect(await keys.readToken(short)).toBeNull();
  // A revoked key can be added again only as a new key (its row stays revoked, for the record).
  expect((await keys.list("ada")).map((k) => [k.name, !!k.revoked]).sort()).toEqual([["Spare", false], ["laptop@test", true]]);
});

test("each admin's keys are their own; losing admin revokes them; local development doesn't ask GitHub", async () => {
  const shared = keygen("shared");
  const { keys, sql, asked } = fresh({ ada: [shared.pub], bo: [shared.pub] });
  await addKey(keys, "ada", shared);
  // The same key for another admin: refused.
  await expect(addKey(keys, "bo", shared)).rejects.toThrow(/Another admin has added that key/);
  // Proof of holding it: an add-key challenge signed by another key doesn't add this one.
  const mine = keygen("mine"), notMine = keygen("not-mine");
  const c = await keys.challenge("bo", HOST, "add-key", notMine.pub);
  await expect(keys.add("bo", { nonce: c.nonce, signature: signed(c, mine.path), publicKey: notMine.pub, unlocked: null, local: true })).rejects.toThrow(/doesn't match/);
  // Locally the first key needn't be on GitHub.
  asked.length = 0;
  expect(await addKey(keys, "bo", mine, { local: true })).toMatchObject({ addedHow: "local" });
  expect(asked).toEqual([]);
  // A private key pasted by mistake is refused without being kept anywhere.
  await expect(keys.challenge("bo", HOST, "add-key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----")).rejects.toBeInstanceOf(KeyError);
  // Bo stops being an admin: his keys are revoked with it.
  const users = new Users(sql, ["root"]);
  const root = { login: "root", unlocked: { key: "test", until: Infinity } };
  await users.add(root, "bo", { role: "admin" });
  await users.setRole(root, "bo", "user");
  expect(await keys.hasKeys("bo")).toBe(false);
  expect((await keys.list("bo"))[0]).toMatchObject({ revokedBy: "root" });
  expect(await keys.hasKeys("ada")).toBe(true);
});
