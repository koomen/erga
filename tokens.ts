// Agent tokens: one kind of token, standing for one person everywhere on the
// server. The share button in the editor makes one, /tokens makes and
// revokes them, and an agent on the command line can ask for one (a device
// flow: it gets a link for the person to approve, and polls). Whoever holds
// a token can do what that person can do: the front door (front.ts) treats
// "Authorization: Bearer erga_..." as signing them in, for the server's API
// (server-api.ts, /api/ext and /mcp) and every document's own (/api/ext).
//
// Kept in SQL (migrations/0100_tokens.sql) behind the directory's `Sql`, so
// D1 holds them on erga.dev and locally, and the tests run them on
// bun:sqlite. A token is an HMAC of its id with the server's secret, and only
// its SHA-256 is stored, so the database alone holds no working token. That
// lets the share button show its token again each time it's asked (until
// it's rotated); a token made at /tokens or for an agent is shown once.

import type { Sql } from "./directory";

/** A token as its person's list shows it (never the token itself). */
export interface AgentToken {
  id: string;
  /** Whom it stands for: their login (lowercase) and name. */
  login: string;
  name: string;
  /** What it's for, as whoever made it put it ("Claude Code", "Share button"). */
  label: string;
  /** "share": the editor's share button's (one per person, shown again until rotated); "agent": any other. */
  kind: "agent" | "share";
  /** A test person's token: who minted their test token (front.ts, Session.test). */
  testBy: string | null;
  created: number;
  lastUsed: number | null;
}

/** Whom a token is for: a login and name, and for a test person, who minted their test token. */
export interface Who { login: string; name: string; testBy?: string }

export const TOKEN_PREFIX = "erga_";
export const LABEL_MAX = 80;
/** How long a request for a token waits to be approved. */
export const REQUEST_MINUTES = 15;
/** last_used is written at most this often, so using a token isn't a write every time. */
const TOUCH_MS = 5 * 60 * 1000;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

const random = (n: number, alphabet: string) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join("");
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
const clipLabel = (s: string | null | undefined, fallback: string) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || fallback;

interface Row { id: string; login: string; name: string; label: string; kind: string; test_by: string | null; created: number; last_used: number | null }
const COLUMNS = "id, login, name, label, kind, test_by, created, last_used";
const fromRow = (r: Row): AgentToken => ({
  id: r.id, login: r.login, name: r.name, label: r.label, kind: r.kind == "share" ? "share" : "agent", testBy: r.test_by ?? null,
  created: Number(r.created), lastUsed: r.last_used == null ? null : Number(r.last_used),
});

export class Tokens {
  constructor(private sql: Sql, private secret: string) {}

  /** The token with this id: an HMAC of it with the server's secret. */
  private async tokenFor(id: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`erga-agent-token:${this.secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return TOKEN_PREFIX + b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id))));
  }

  /** A new token for someone: the token (show it once) and its entry. */
  async mint(who: Who, label: string, kind: "agent" | "share" = "agent"): Promise<{ token: string; info: AgentToken }> {
    const info: AgentToken = {
      id: random(12, ID_ALPHABET), login: who.login.toLowerCase(), name: who.name || who.login, label: clipLabel(label, "Agent"), kind,
      testBy: who.testBy?.toLowerCase() ?? null, created: Date.now(), lastUsed: null,
    };
    const token = await this.tokenFor(info.id);
    await this.sql.run("INSERT INTO agent_tokens (id, hash, login, name, label, kind, test_by, created, last_used) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
      info.id, await sha256(token), info.login, info.name, info.label, info.kind, info.testBy, info.created);
    return { token, info };
  }

  /**
   * The share button's token for someone: the one they have, or a new one
   * (and with `rotate`, a new one in place of the old, which stops working).
   */
  async share(who: Who, rotate: boolean): Promise<{ token: string; info: AgentToken }> {
    const [row] = await this.sql.all<Row>(`SELECT ${COLUMNS} FROM agent_tokens WHERE login = ?1 AND kind = 'share' ORDER BY created DESC LIMIT 1`, who.login.toLowerCase());
    if (row && !rotate) return { token: await this.tokenFor(row.id), info: fromRow(row) };
    if (row) await this.sql.run("DELETE FROM agent_tokens WHERE login = ?1 AND kind = 'share'", who.login.toLowerCase());
    return this.mint(who, "Share button", "share");
  }

  /** Whose a token is, if it's one of ours and hasn't been revoked. */
  async verify(token: string): Promise<AgentToken | null> {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const [row] = await this.sql.all<Row>(`SELECT ${COLUMNS} FROM agent_tokens WHERE hash = ?1`, await sha256(token));
    if (!row) return null;
    const now = Date.now();
    if (row.last_used == null || now - Number(row.last_used) > TOUCH_MS) {
      await this.sql.run("UPDATE agent_tokens SET last_used = ?2 WHERE id = ?1", row.id, now).catch(() => {});
      row.last_used = now;
    }
    return fromRow(row);
  }

  /** Someone's tokens, newest first. */
  async list(login: string): Promise<AgentToken[]> {
    const rows = await this.sql.all<Row>(`SELECT ${COLUMNS} FROM agent_tokens WHERE login = ?1 ORDER BY created DESC`, login.toLowerCase());
    return rows.map(fromRow);
  }

  /** Turns one of someone's tokens off; false if they have none by that id. */
  async revoke(login: string, id: string): Promise<boolean> {
    const [row] = await this.sql.all<{ id: string }>("SELECT id FROM agent_tokens WHERE id = ?1 AND login = ?2", id, login.toLowerCase());
    if (!row) return false;
    await this.sql.run("DELETE FROM agent_tokens WHERE id = ?1", id);
    return true;
  }

  // ---------------------------------------------------------- asking for one

  /**
   * An agent asks for a token: `code` is its secret to poll with, and
   * `userCode` goes in the link the person opens to approve it.
   */
  async request(label: string | null | undefined): Promise<{ code: string; userCode: string; label: string; expires: number }> {
    const now = Date.now();
    await this.sql.run("DELETE FROM token_requests WHERE expires < ?1", now);
    const code = "ergareq_" + b64url(crypto.getRandomValues(new Uint8Array(24)));
    const userCode = `${random(4, CODE_ALPHABET)}-${random(4, CODE_ALPHABET)}`;
    const expires = now + REQUEST_MINUTES * 60 * 1000;
    const clipped = clipLabel(label, "An agent");
    await this.sql.run("INSERT INTO token_requests (code_hash, user_code, label, created, expires, login, token_id) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)",
      await sha256(code), userCode, clipped, now, expires);
    return { code, userCode, label: clipped, expires };
  }

  /** A request still waiting for someone to approve it. */
  async pending(userCode: string): Promise<{ label: string; expires: number } | null> {
    const [row] = await this.sql.all<{ label: string; expires: number }>(
      "SELECT label, expires FROM token_requests WHERE user_code = ?1 AND login IS NULL AND expires >= ?2", normalCode(userCode), Date.now());
    return row ? { label: row.label, expires: Number(row.expires) } : null;
  }

  /** Approves a request as `who`: mints their token for the agent to collect. Null if there's no such request waiting. */
  async approve(userCode: string, who: { login: string; name: string }): Promise<AgentToken | null> {
    const waiting = await this.pending(userCode);
    if (!waiting) return null;
    const { info } = await this.mint(who, waiting.label);
    await this.sql.run("UPDATE token_requests SET login = ?2, token_id = ?3 WHERE user_code = ?1 AND login IS NULL", normalCode(userCode), info.login, info.id);
    return info;
  }

  /** The agent polls: its token once approved (handed over once), "pending" until then, "gone" if it expired or was collected. */
  async collect(code: string): Promise<{ status: "pending" } | { status: "gone" } | { status: "ready"; token: string; login: string }> {
    const hash = await sha256(code);
    const [row] = await this.sql.all<{ expires: number; login: string | null; token_id: string | null }>("SELECT expires, login, token_id FROM token_requests WHERE code_hash = ?1", hash);
    if (!row) return { status: "gone" };
    if (row.token_id && row.login) {
      await this.sql.run("DELETE FROM token_requests WHERE code_hash = ?1", hash);
      // Revoked before it was collected: nothing to hand over.
      const [still] = await this.sql.all<{ id: string }>("SELECT id FROM agent_tokens WHERE id = ?1", row.token_id);
      return still ? { status: "ready", token: await this.tokenFor(row.token_id), login: row.login } : { status: "gone" };
    }
    if (Number(row.expires) < Date.now()) {
      await this.sql.run("DELETE FROM token_requests WHERE code_hash = ?1", hash);
      return { status: "gone" };
    }
    return { status: "pending" };
  }
}

/** A user code as typed: "bcdf ghjk", "bcdfghjk" → "BCDF-GHJK". */
export function normalCode(s: string): string {
  const c = s.toUpperCase().replace(/[^A-Z]/g, "");
  return c.length == 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : s.trim().toUpperCase();
}
