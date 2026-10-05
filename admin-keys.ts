// Admins' SSH keys, and unlocking admin access with them (README, Admin SSH
// keys). Being an admin (users.ts) is no longer enough to administer, edit
// or deploy the server: the admin must also have *unlocked* admin access, by
// signing a one-time challenge from this server with an SSH key they added
// themselves (`ssh-keygen -Y sign -n erga-admin`). An unlock lasts an hour
// (UNLOCK_MS), and is carried by
//
//   - a browser: the erga_admin cookie, next to the session cookie, for the
//     same person (worker/auth.ts);
//   - an agent or a script: an admin token, `erga_admin_…`, sent as a Bearer
//     token or as Git's password (front.ts, withTokens; worker/source.ts),
//     made by signing a challenge with an agent token in hand (admin-login.ts).
//
// Both are signed with the server's secret and name the key that unlocked
// them; each request checks that the key is still there and still the
// admin's (remembered for a few seconds), so revoking a key ends every
// unlock made with it. Keys, challenges and a log of what happened are on
// the directory's database (migrations/0110_admin_keys.sql), behind its
// `Sql`, so the tests run this on bun:sqlite.
//
// Adding a key needs proof of holding it (a signed add-key challenge naming
// it) and either an unlock with another of the admin's own keys, or, for an
// admin with no keys at all, that the key is on their GitHub account
// (github.com/<login>.keys; skipped in local development).

import type { Sql } from "./directory.ts";
import { parsePublicKey, parseSignature, SshError, verifySignature, type PublicKey } from "./sshsig.ts";

/** The SSH signature namespace (`ssh-keygen -Y sign -n erga-admin`): a signature made for anything else (git, files) never counts here. */
export const NAMESPACE = "erga-admin";
/** How long an unlock lasts: a browser's, and an admin token's unless it asks for less. */
export const UNLOCK_MS = 60 * 60 * 1000;
/** The longest an admin token may ask for. */
export const TOKEN_MAX_MS = 12 * 60 * 60 * 1000;
/** How long a challenge waits to be signed. */
export const CHALLENGE_MS = 5 * 60 * 1000;
export const ADMIN_TOKEN_PREFIX = "erga_admin_";
/**
 * The key an unlock names when admin keys aren't required (ERGA_ADMIN_KEYS_REQUIRED unset, worker/auth.ts):
 * every signed-in session carries such an unlock, so a signed-in admin is enough. It names no SSH key, so it
 * stops counting the moment the keys are required again.
 */
export const SIGN_IN_KEY = "sign-in";
/** How long a key that's there is trusted before asking the database again (a revoke here is seen at once). */
const REMEMBER_MS = 10_000;
const NAME_MAX = 60;

/** An unlock, as a session carries it (front.ts, Session.unlocked) to the directory's admin-only calls (users.ts). */
export interface Unlock {
  /** The key that unlocked it ("local" for local development's shortcut, ERGA_ADMIN_UNLOCKED; SIGN_IN_KEY while admin keys aren't required). */
  key: string;
  /** When it ends (ms since the epoch). */
  until: number;
}

export interface AdminKey {
  id: string;
  login: string;
  name: string;
  type: string;
  /** "type base64", no comment. */
  publicKey: string;
  fingerprint: string;
  created: number;
  addedHow: "github" | "unlocked" | "local";
  lastUsed: number | null;
  revoked: number | null;
  revokedBy: string | null;
}

export interface LogEntry { at: number; login: string; action: string; detail: string }

export type Purpose = "unlock" | "add-key";

/** Something about a key, a challenge or a signature that a person can act on (400/403). */
export class KeyError extends Error {
  constructor(message: string, readonly status = 403) { super(message); }
}

interface Row { id: string; login: string; name: string; type: string; public_key: string; fingerprint: string; created: number; added_how: string; last_used: number | null; revoked: number | null; revoked_by: string | null }
const fromRow = (r: Row): AdminKey => ({
  id: r.id, login: r.login, name: r.name, type: r.type, publicKey: r.public_key, fingerprint: r.fingerprint, created: Number(r.created),
  addedHow: r.added_how as AdminKey["addedHow"], lastUsed: r.last_used == null ? null : Number(r.last_used),
  revoked: r.revoked == null ? null : Number(r.revoked), revokedBy: r.revoked_by,
});

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const randomId = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const clipName = (s: string | null | undefined, fallback: string) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX) || fallback;

export interface AdminKeysOptions {
  /**
   * The public keys on someone's GitHub account (github.com/<login>.keys):
   * an admin's first key must be one of them. Absent: GitHub is asked.
   */
  githubKeys?: (login: string) => Promise<string[]>;
  now?: () => number;
}

/** What GitHub lists for a login: one "type base64" line per key. */
export async function githubKeys(login: string): Promise<string[]> {
  const r = await fetch(`https://github.com/${encodeURIComponent(login)}.keys`, { headers: { "User-Agent": "erga.dev" } });
  if (!r.ok) throw new KeyError(`Erga couldn't read your keys on GitHub (github.com/${login}.keys answered ${r.status}): try again.`, 502);
  return (await r.text()).split("\n").map((l) => l.trim()).filter(Boolean);
}

export class AdminKeys {
  private known = new Map<string, { login: string | null; at: number }>();
  private readonly now: () => number;

  constructor(private sql: Sql, private secret: string, private opts: AdminKeysOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  // ------------------------------------------------------------ keys

  /** Someone's keys (or everyone's, with no login), revoked ones too, newest first. */
  async list(login?: string): Promise<AdminKey[]> {
    const rows = login
      ? await this.sql.all<Row>("SELECT * FROM admin_keys WHERE login = ?1 ORDER BY created DESC", login.toLowerCase())
      : await this.sql.all<Row>("SELECT * FROM admin_keys ORDER BY login, created DESC");
    return rows.map(fromRow);
  }

  /** Whether someone has a key that works. */
  async hasKeys(login: string): Promise<boolean> {
    const [row] = await this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM admin_keys WHERE login = ?1 AND revoked IS NULL", login.toLowerCase());
    return Number(row?.n ?? 0) > 0;
  }

  /** Whose a key is, while it works (null once revoked, or if there's none). */
  async ownerOf(id: string): Promise<string | null> {
    const known = this.known.get(id);
    if (known && this.now() - known.at < REMEMBER_MS) return known.login;
    const [row] = await this.sql.all<{ login: string }>("SELECT login FROM admin_keys WHERE id = ?1 AND revoked IS NULL", id);
    if (this.known.size > 1000) this.known.clear();
    this.known.set(id, { login: row?.login ?? null, at: this.now() });
    return row?.login ?? null;
  }

  // ------------------------------------------------------------ challenges

  /**
   * A challenge for `login` to sign, for `purpose` on this server (`host`):
   * the exact text to sign, and when it stops working. An add-key challenge
   * names the key (which must be the one that signs it).
   */
  async challenge(login: string, host: string, purpose: Purpose, publicKey?: string): Promise<{ nonce: string; message: string; expires: number; key?: { fingerprint: string; type: string } }> {
    login = login.toLowerCase();
    let key: PublicKey | null = null;
    if (purpose == "add-key") key = await this.parseKey(publicKey ?? "");
    const now = this.now();
    await this.sql.run("DELETE FROM admin_challenges WHERE expires < ?1", now);
    const nonce = randomId(24);
    const expires = now + CHALLENGE_MS;
    const message = [NAMESPACE, purpose, `host=${host}`, `login=${login}`, ...(key ? [`key=${key.fingerprint}`] : []), `nonce=${nonce}`, `expires=${new Date(expires).toISOString()}`].join(" ");
    await this.sql.run("INSERT INTO admin_challenges (nonce, login, purpose, message, fingerprint, expires) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      nonce, login, purpose, message, key?.fingerprint ?? null, expires);
    return { nonce, message, expires, ...(key ? { key: { fingerprint: key.fingerprint, type: key.type } } : {}) };
  }

  /** Takes a challenge out (one try each, whatever the answer): the challenge if it's `login`'s, for `purpose`, and unexpired. */
  private async consume(nonce: string, login: string, purpose: Purpose): Promise<{ message: string; fingerprint: string | null }> {
    const [row] = await this.sql.all<{ login: string; purpose: string; message: string; fingerprint: string | null; expires: number }>(
      "DELETE FROM admin_challenges WHERE nonce = ?1 RETURNING login, purpose, message, fingerprint, expires", String(nonce ?? ""));
    if (!row || row.login != login.toLowerCase() || row.purpose != purpose) throw new KeyError("That challenge isn't one this server gave you (or it was used already): ask for a new one.", 400);
    if (Number(row.expires) < this.now()) throw new KeyError("That challenge expired: ask for a new one, and sign it within five minutes.", 400);
    return { message: row.message, fingerprint: row.fingerprint };
  }

  /** Whether `armored` is `key`'s signature of `message` (or of it with the newline `echo` adds). */
  private async signed(armored: string, key: PublicKey, message: string): Promise<boolean> {
    let sig;
    try { sig = await parseSignature(armored); } catch (e) { throw new KeyError((e as Error).message, 400); }
    return (await verifySignature(sig, key, NAMESPACE, message)) || (await verifySignature(sig, key, NAMESPACE, message + "\n"));
  }

  private async parseKey(text: string): Promise<PublicKey> {
    try { return await parsePublicKey(text); } catch (e) { throw new KeyError(e instanceof SshError ? e.message : "That isn't a public key.", 400); }
  }

  // ------------------------------------------------------------ unlocking

  /**
   * Unlocks admin access for `login`: `armored` must be the signature of
   * the challenge `nonce` names (an unlock challenge of theirs, on this
   * host), by one of their keys. Returns the key and when the unlock ends.
   */
  async unlock(login: string, nonce: string, armored: string, ttl = UNLOCK_MS): Promise<{ key: AdminKey; unlock: Unlock }> {
    login = login.toLowerCase();
    const { message } = await this.consume(nonce, login, "unlock");
    let sig;
    try { sig = await parseSignature(armored); } catch (e) { await this.log(login, "unlock-failed", (e as Error).message); throw new KeyError((e as Error).message, 400); }
    const [row] = await this.sql.all<Row>("SELECT * FROM admin_keys WHERE fingerprint = ?1 AND revoked IS NULL", sig.key.fingerprint);
    if (!row || row.login != login) {
      await this.log(login, "unlock-failed", `signed by ${sig.key.fingerprint}, which isn't one of ${login}'s keys`);
      throw new KeyError(`That signature is from ${sig.key.fingerprint}, which isn't one of your admin keys. Sign with a key listed on /admin/keys.`);
    }
    if (!(await this.signed(armored, await parsePublicKey(row.public_key), message))) {
      await this.log(login, "unlock-failed", `bad signature from ${row.fingerprint}`);
      throw new KeyError("That signature doesn't match the challenge: sign exactly the text given, with -n erga-admin.");
    }
    const now = this.now();
    await this.sql.run("UPDATE admin_keys SET last_used = ?2 WHERE id = ?1", row.id, now);
    const until = now + Math.max(60_000, Math.min(ttl, TOKEN_MAX_MS));
    return { key: { ...fromRow(row), lastUsed: now }, unlock: { key: row.id, until } };
  }

  // ------------------------------------------------------------ adding and revoking

  /**
   * Adds a key for `login`, who signed the add-key challenge `nonce` with
   * it. They must be unlocked (with another of their own keys), or have no
   * keys at all and the key on their GitHub account (`local`: local
   * development, where GitHub isn't asked).
   */
  async add(login: string, opts: { nonce: string; signature: string; publicKey: string; name?: string; unlocked: Unlock | null; local?: boolean }): Promise<AdminKey> {
    login = login.toLowerCase();
    const key = await this.parseKey(opts.publicKey);
    const { message, fingerprint } = await this.consume(opts.nonce, login, "add-key");
    if (fingerprint != key.fingerprint) throw new KeyError("That challenge was for another key: ask for one for this key.", 400);
    if (!(await this.signed(opts.signature, key, message))) {
      await this.log(login, "add-failed", `bad signature for ${key.fingerprint}`);
      throw new KeyError("That signature doesn't match: sign the challenge with the key you're adding (its private half), with -n erga-admin.");
    }
    const unlocked = opts.unlocked && opts.unlocked.until > this.now() && (opts.unlocked.key == "local" ? !!opts.local : (await this.ownerOf(opts.unlocked.key)) == login);
    let how: AdminKey["addedHow"];
    if (unlocked) how = opts.local && opts.unlocked!.key == "local" ? "local" : "unlocked";
    else if (await this.hasKeys(login)) throw new KeyError("Unlock admin access with one of your keys first: a new key needs one you already have.");
    else if (opts.local) how = "local";
    else {
      const listed = await (this.opts.githubKeys ?? githubKeys)(login);
      if (!listed.some((l) => l.split(/\s+/).slice(0, 2).join(" ") == key.text)) {
        await this.log(login, "add-failed", `first key ${key.fingerprint} isn't on github.com/${login}.keys`);
        throw new KeyError(`Your first admin key must be one of your keys on GitHub (github.com/${login}.keys), and ${key.fingerprint} isn't. Add it to GitHub (Settings › SSH and GPG keys), then try again.`);
      }
      how = "github";
    }
    const [taken] = await this.sql.all<{ login: string }>("SELECT login FROM admin_keys WHERE fingerprint = ?1 AND revoked IS NULL", key.fingerprint);
    if (taken) throw new KeyError(taken.login == login ? "You've added that key already." : "Another admin has added that key: each admin needs a key of their own.", 409);
    const row: AdminKey = {
      id: randomId(9), login, name: clipName(opts.name, key.comment || key.type), type: key.type, publicKey: key.text, fingerprint: key.fingerprint,
      created: this.now(), addedHow: how, lastUsed: null, revoked: null, revokedBy: null,
    };
    await this.sql.run("INSERT INTO admin_keys (id, login, name, type, public_key, fingerprint, created, added_how) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      row.id, row.login, row.name, row.type, row.publicKey, row.fingerprint, row.created, row.addedHow);
    await this.log(login, "key-added", `${row.name} (${row.fingerprint}), ${how == "github" ? "first key, found on GitHub" : how == "local" ? "local development" : "while unlocked"}`);
    return row;
  }

  /**
   * Revokes a key: its owner's, or any admin's (to lock someone out who
   * lost theirs), by an unlocked admin (the caller checks that they're one).
   * Every unlock made with it ends.
   */
  async revoke(by: string, id: string): Promise<AdminKey> {
    const [row] = await this.sql.all<Row>("SELECT * FROM admin_keys WHERE id = ?1", id);
    if (!row) throw new KeyError("There's no such key.", 404);
    if (row.revoked != null) return fromRow(row);
    const now = this.now();
    await this.sql.run("UPDATE admin_keys SET revoked = ?2, revoked_by = ?3 WHERE id = ?1 AND revoked IS NULL", id, now, by.toLowerCase());
    this.known.delete(id);
    await this.log(by, "key-revoked", `${row.login}'s ${row.name} (${row.fingerprint})`);
    return { ...fromRow(row), revoked: now, revokedBy: by.toLowerCase() };
  }

  // ------------------------------------------------------------ the unlock's carriers

  private async mac(value: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", enc.encode(`erga-admin-unlock:${this.secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value))));
  }

  private async seal(kind: "cookie" | "token", claims: object): Promise<string> {
    const value = b64url(enc.encode(JSON.stringify(claims)));
    return `${value}.${await this.mac(`${kind}:${value}`)}`;
  }

  private async open<T>(kind: "cookie" | "token", sealed: string): Promise<T | null> {
    const i = sealed.lastIndexOf(".");
    if (i < 0 || sealed.length > 1000) return null;
    const value = sealed.slice(0, i), mac = sealed.slice(i + 1);
    const want = await this.mac(`${kind}:${value}`);
    if (mac.length != want.length) return null;
    let d = 0;
    for (let j = 0; j < mac.length; j++) d |= mac.charCodeAt(j) ^ want.charCodeAt(j);
    if (d) return null;
    try { return JSON.parse(new TextDecoder().decode(unb64url(value))) as T; } catch { return null; }
  }

  /** The erga_admin cookie's value for an unlock of `login`'s. */
  cookie(login: string, unlock: Unlock): Promise<string> {
    return this.seal("cookie", { l: login.toLowerCase(), k: unlock.key, u: unlock.until });
  }

  /** The unlock an erga_admin cookie holds, if it's `login`'s, unexpired, and its key still theirs. */
  async readCookie(raw: string, login: string): Promise<Unlock | null> {
    const c = await this.open<{ l: string; k: string; u: number }>("cookie", raw);
    if (!c || c.l != login.toLowerCase() || !(c.u > this.now())) return null;
    return (await this.ownerOf(c.k)) == c.l ? { key: c.k, until: c.u } : null;
  }

  /** An admin token: an unlock of `login`'s for an agent or a script (and Git's password). */
  async token(login: string, name: string, unlock: Unlock): Promise<string> {
    await this.log(login, "token", `admin token until ${new Date(unlock.until).toISOString()}`);
    return ADMIN_TOKEN_PREFIX + (await this.seal("token", { l: login.toLowerCase(), n: name, k: unlock.key, u: unlock.until }));
  }

  /** Whose an admin token is, and its unlock, while it lasts and its key is still theirs. */
  async readToken(token: string): Promise<{ login: string; name: string; unlock: Unlock } | null> {
    if (!token.startsWith(ADMIN_TOKEN_PREFIX)) return null;
    const t = await this.open<{ l: string; n: string; k: string; u: number }>("token", token.slice(ADMIN_TOKEN_PREFIX.length));
    if (!t || !(t.u > this.now()) || (await this.ownerOf(t.k)) != t.l) return null;
    return { login: t.l, name: t.n || t.l, unlock: { key: t.k, until: t.u } };
  }

  // ------------------------------------------------------------ the log

  async log(login: string, action: string, detail = ""): Promise<void> {
    await this.sql.run("INSERT INTO admin_log (at, login, action, detail) VALUES (?1, ?2, ?3, ?4)", this.now(), login.toLowerCase(), action, detail.slice(0, 300));
    // Kept to the last thousand or so.
    if (Math.random() < 0.05) await this.sql.run("DELETE FROM admin_log WHERE id <= (SELECT MAX(id) FROM admin_log) - 1000");
  }

  /** The latest entries, newest first. */
  async history(limit = 30): Promise<LogEntry[]> {
    const rows = await this.sql.all<{ at: number; login: string; action: string; detail: string }>("SELECT at, login, action, detail FROM admin_log ORDER BY id DESC LIMIT ?1", Math.max(1, Math.min(200, limit)));
    return rows.map((r) => ({ at: Number(r.at), login: r.login, action: r.action, detail: r.detail }));
  }
}
