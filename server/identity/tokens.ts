// Agent tokens: the one credential for agents, scripts, the API, MCP and Git.
// Each stands for one person, within a scope:
//
//   document    one document (`docId`), with the person's rights there, and
//               nothing else: no listing, making or deleting other documents
//   documents   everything the person can do with documents, but no admin power
//   admin       everything the person can do, admin power included while they
//               are an admin (Users.isAdmin, checked on every request); only an
//               admin can make one, and pushing to Erga's Git endpoint needs one
//
// and, if its maker chose one, an expiry, after which it stops working. The
// share button in the editor makes a documents token, /tokens makes and
// revokes them, and an agent on the command line can ask for one (a device
// flow: it gets a link for the person to approve, and polls), or an agent's app
// asks through the browser (MCP's OAuth sign-in, oauth.ts: the same request,
// approved on the same page, handed back with a code). Share with an
// agent's menu makes one through /tokens, as Settings does. Only a person signed in in a browser makes a token: an agent
// never can, whatever its scope. The app
// treats "Authorization: Bearer erga_..." as signing
// the person in, within the token's scope, for the server's API
// (server/api.ts: /api/tools and /mcp).
//
// Kept in SQL behind the directory's `Sql`, so
// D1 holds them on erga.dev and locally, and the tests run them on
// bun:sqlite. A token is an HMAC of its id with the server's secret, and only
// its SHA-256 is stored, so the database alone holds no working token. That
// lets the share button show its token again each time it's asked (until
// it's rotated); a token made at /tokens or for an agent is shown once.
// It also means a token works only on the server that made it: staging's
// database copies the rows, but staging's secret is its own.

import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";
import type { Directory, Sql } from "../directory/index.ts";
import { changeLogEntry } from "../../shared/attribution";
import { base64url, randomString, randomToken, sha256, sha256Hex } from "../../shared/bytes.ts";

/** A token as its person's list shows it (never the token itself). */
export interface AgentToken {
  id: string;
  /** Whom it stands for: their login (lowercase) and name. */
  login: string;
  name: string;
  /** What it's for, as whoever made it put it ("Claude Code", "Share button"). */
  label: string;
  /**
   * "share": a share button's, one per person and scope, shown again until rotated: a documents
   * token; "agent": any other.
   */
  kind: "agent" | "share";
  /** What it may do (see the top of this file). */
  scope: Scope;
  /** A document token's document (its id). */
  docId: string | null;
  /** When it stops working (milliseconds since the epoch); null: when it's revoked. */
  expires: number | null;
  created: number;
  lastUsed: number | null;
}

export type Scope = "document" | "documents" | "admin";
export const SCOPES: readonly Scope[] = ["document", "documents", "admin"];

/** What a token is for, as its maker asks: its scope, a document token's document, and when it ends (or never). */
export interface Grant { scope: Scope; docId?: string | null; expires?: number | null }

/** Why a token can't be made (a wrong scope, a document that isn't the person's to open): the message says so. */
export class ScopeError extends Schema.TaggedError<ScopeError>()("ScopeError", { message: Schema.String }) {}

/** An OAuth request's own parts (oauth.ts): the client, where its person goes back, its PKCE challenge (S256) and state. */
export interface OAuthAsk {
  client: string;
  redirectUri: string;
  challenge: string;
  state: string | null;
}
/** Where an OAuth request sends its person back, and the client's state to send with them. */
export interface OAuthBack {
  redirectUri: string;
  state: string | null;
}
/** How long an OAuth request's authorization code works, once approved. */
export const CODE_MINUTES = 10;

/** Whom a token is for: a login and name. */
export interface Who {
  login: string;
  name: string;
}

export const TOKEN_PREFIX = "erga_";
export const LABEL_MAX = 80;
/** How long a request for a token waits to be approved. */
export const REQUEST_MINUTES = 15;
/** last_used is written at most this often, so using a token isn't a write every time. */
const TOUCH_MS = 5 * 60 * 1000;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

const clipLabel = (s: string | null | undefined, fallback: string) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || fallback;

interface Row {
  id: string;
  login: string;
  name: string;
  label: string;
  kind: string;
  scope: string;
  doc_id: string | null;
  expires: number | null;
  created: number;
  last_used: number | null;
}
const COLUMNS = "id, login, name, label, kind, scope, doc_id, expires, created, last_used";
const scopeOf = (s: unknown): Scope => (SCOPES.includes(s as Scope) ? s as Scope : "documents");
const fromRow = (r: Row): AgentToken => ({
  id: r.id,
  login: r.login,
  name: r.name,
  label: r.label,
  kind: r.kind == "share" ? "share" : "agent",
  scope: scopeOf(r.scope),
  docId: r.doc_id ?? null,
  expires: r.expires == null ? null : Number(r.expires),
  created: Number(r.created),
  lastUsed: r.last_used == null ? null : Number(r.last_used),
});

export class Tokens {
  /** `dir` checks who may make which scope: an admin token for admins only, a document token for a document the person may open. */
  constructor(
    private sql: Sql,
    private secret: string,
    private dir: Directory
  ) {}

  /** The token with this id: an HMAC of it with the server's secret. */
  private async tokenFor(id: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`erga-agent-token:${this.secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return TOKEN_PREFIX + Base64Url.encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id))));
  }

  /**
   * The working token for a row, or null if this server didn't make it: a copy of another server's database (staging
   * takes production's) holds that server's share tokens, which our secret can't make again (verify refuses them).
   */
  private async ownToken(id: string): Promise<string | null> {
    const token = await this.tokenFor(id);
    const [row] = await this.sql.all<{ hash: string }>("SELECT hash FROM agent_tokens WHERE id = ?1", id);
    return row?.hash == (await sha256Hex(token)) ? token : null;
  }

  /**
   * Checks what someone asks a token to be (throws ScopeError, saying why):
   * a scope there is, an admin token only for an admin, a document token for
   * a document they may open, and an expiry in the future. Returns it tidied.
   */
  async check(who: Who, grant: Grant): Promise<Required<Grant>> {
    if (!SCOPES.includes(grant.scope)) throw new ScopeError({ message: `"${grant.scope}" isn't a scope: document, documents or admin.` });
    const expires = grant.expires == null ? null : Number(grant.expires);
    if (expires != null && !(expires > Date.now())) throw new ScopeError({ message: "The expiry must be in the future." });
    if (grant.scope == "admin" && !(await this.dir.users.isAdmin(who.login)))
      throw new ScopeError({ message: "Only an admin can make an admin token." });
    if (grant.scope != "document") return { scope: grant.scope, docId: null, expires };
    const doc = grant.docId ? await this.dir.find(grant.docId) : null;
    const as = { login: who.login.toLowerCase() };
    if (!doc || !(await this.dir.access(as, doc))) throw new ScopeError({ message: "A document token needs a document you may open." });
    return { scope: "document", docId: doc.id, expires };
  }

  /** A new token for someone, within `grant` (check): the token (show it once) and its entry. */
  async mint(who: Who, label: string, grant: Grant, kind: "agent" | "share" = "agent"): Promise<{ token: string; info: AgentToken }> {
    const { scope, docId, expires } = await this.check(who, grant);
    const info: AgentToken = {
      id: randomString(12, ID_ALPHABET),
      login: who.login.toLowerCase(),
      name: who.name || who.login,
      label: clipLabel(label, "Agent"),
      kind,
      scope,
      docId,
      expires,
      created: Date.now(),
      lastUsed: null,
    };
    const token = await this.tokenFor(info.id);
    await this.sql.run(
      "INSERT INTO agent_tokens (id, hash, login, name, label, kind, scope, doc_id, expires, created, last_used) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
      info.id,
      await sha256Hex(token),
      info.login,
      info.name,
      info.label,
      info.kind,
      info.scope,
      info.docId,
      info.expires,
      info.created
    );
    await this.changed(info.login, [info.id]);
    return { token, info };
  }

  /** Their open /settings shows these tokens as they are now, or without them (server/news/). */
  private async changed(login: string, ids: string[]): Promise<void> {
    if (ids.length) await this.dir.publish(ids.map((id) => ({ key: `token:${id}`, to: [login] })));
  }

  /** Deletes the tokens `where` picks (SQL, with ?1: login), and tells their open /settings. */
  private async drop(login: string, where: string, ...params: (string | number)[]): Promise<void> {
    const gone = await this.sql.all<{ id: string }>(`SELECT id FROM agent_tokens WHERE login = ?1 AND ${where}`, login, ...params);
    if (!gone.length) return;
    await this.sql.run(`DELETE FROM agent_tokens WHERE login = ?1 AND ${where}`, login, ...params);
    await this.changed(
      login,
      gone.map((r) => r.id)
    );
  }

  /**
   * The share button's token for someone: the one they have, or a new one
   * (and with `rotate`, a new one in place of the old, which stops working).
   */
  async share(who: Who, rotate: boolean): Promise<{ token: string; info: AgentToken }> {
    const [row] = await this.sql.all<Row>(`SELECT ${COLUMNS} FROM agent_tokens WHERE login = ?1 AND kind = 'share' AND scope != 'admin' ORDER BY created DESC LIMIT 1`, who.login.toLowerCase());
    // Not ours (another server's row): a new one in its place, as with rotate.
    const own = row && !rotate ? await this.ownToken(row.id) : null;
    if (own) return { token: own, info: fromRow(row) };
    if (row) await this.drop(who.login.toLowerCase(), "kind = 'share' AND scope != 'admin'");
    return this.mint(who, "Share button", { scope: "documents" }, "share");

  }

  /** Whose a token is, if it's one of ours, hasn't been revoked and hasn't expired. */

  async verify(token: string): Promise<AgentToken | null> {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const [row] = await this.sql.all<Row>(`SELECT ${COLUMNS} FROM agent_tokens WHERE hash = ?1`, await sha256Hex(token));
    // The row must be this server's: a copy of another server's database (staging takes production's) holds
    // its tokens' hashes, but their tokens were made with that server's secret, not ours.
    if (!row || (await this.tokenFor(row.id)) != token) return null;
    const now = Date.now();
    if (row.expires != null && Number(row.expires) <= now) return null;

    if (row.last_used == null || now - Number(row.last_used) > TOUCH_MS) {
      await this.sql.run("UPDATE agent_tokens SET last_used = ?2 WHERE id = ?1", row.id, now).catch(() => {});
      row.last_used = now;
    }
    return fromRow(row);
  }

  /**
   * Someone's tokens that still work, newest first: `limit` of them after the first `offset`, and how many there are in
   * all. An expired token works no more, and isn't listed; a revoked one is gone.
   */
  async list(login: string, limit: number, offset = 0): Promise<{ tokens: AgentToken[]; total: number }> {
    const live = "login = ?1 AND (expires IS NULL OR expires > ?2)";
    const [rows, [count]] = await Promise.all([
      this.sql.all<Row>(
        `SELECT ${COLUMNS} FROM agent_tokens WHERE ${live} ORDER BY created DESC, rowid DESC LIMIT ?3 OFFSET ?4`,
        login.toLowerCase(),
        Date.now(),
        limit,
        offset
      ),
      this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_tokens WHERE ${live}`, login.toLowerCase(), Date.now()),
    ]);
    return { tokens: rows.map(fromRow), total: Number(count?.n ?? 0) };
  }

  /**
   * Turns one of `login`'s tokens off. `via`: how they did it, when not in
   * person: the change log (/admin/changes) records it under
   * them, with that.
   */
  async revoke(login: string, id: string, via?: string | null): Promise<boolean> {
    login = login.toLowerCase();
    const [row] = await this.sql.all<{ id: string; label: string }>("SELECT id, label FROM agent_tokens WHERE id = ?1 AND login = ?2", id, login);
    if (!row) return false;
    await this.sql.batch([
      ["DELETE FROM agent_tokens WHERE id = ?1", id],
      changeLogEntry(Date.now(), login, via, [{ key: "token", from: null, to: null, token: { id, label: row.label, event: "revoked", of: login } }]),
    ]);
    await this.changed(login, [id]);
    // The change log's new line, on the open admin pages.
    await this.dir.users.pagesChanged([]);
    return true;
  }

  // ---------------------------------------------------------- asking for one

  /**
   * An agent asks for a token: `code` is its secret to poll with, and
   * `userCode` goes in the link the person opens to approve it.
   */
  /** `oauth`: an agent's app asking through the browser (oauth.ts), which gets its token back with a code, not by polling. */
  async request(
    label: string | null | undefined,
    grant: Grant,
    oauth?: OAuthAsk
  ): Promise<{ code: string; userCode: string; label: string; expires: number }> {
    if (!SCOPES.includes(grant.scope)) throw new ScopeError({ message: `"${grant.scope}" isn't a scope: document, documents or admin.` });
    if (grant.scope == "document" && !grant.docId)
      throw new ScopeError({ message: "A document token needs a document: give doc (its address, URL or id)." });
    if (grant.expires != null && !(Number(grant.expires) > Date.now()))
      throw new ScopeError({ message: "The expiry must be in the future." });
    const now = Date.now();

    await this.sql.run("DELETE FROM token_requests WHERE expires < ?1", now);
    const code = "ergareq_" + randomToken(24);
    const userCode = `${randomString(4, CODE_ALPHABET)}-${randomString(4, CODE_ALPHABET)}`;
    const expires = now + REQUEST_MINUTES * 60 * 1000;
    const clipped = clipLabel(label, "An agent");
    await this.sql.run(
      "INSERT INTO token_requests (code_hash, user_code, label, created, expires, login, token_id, scope, doc_id, token_expires, oauth_client, redirect_uri, code_challenge, oauth_state) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
      await sha256Hex(code),
      userCode,
      clipped,
      now,
      expires,
      grant.scope,
      grant.scope == "document" ? String(grant.docId).slice(0, 300) : null,
      grant.expires == null ? null : Number(grant.expires),
      oauth?.client ?? null,
      oauth?.redirectUri ?? null,
      oauth?.challenge ?? null,
      oauth?.state ?? null
    );

    return { code, userCode, label: clipped, expires };
  }

  /**
   * A request still waiting for someone to approve it: what it asks for (`docId` as the agent named it), when it
   * lapses, and for an OAuth request, where its person goes back.
   */
  async pending(userCode: string): Promise<{ label: string; expires: number; grant: Required<Grant>; oauth: OAuthBack | null } | null> {
    const [row] = await this.sql.all<{
      label: string;
      expires: number;
      scope: string;
      doc_id: string | null;
      token_expires: number | null;
      redirect_uri: string | null;
      oauth_state: string | null;
    }>(
      "SELECT label, expires, scope, doc_id, token_expires, redirect_uri, oauth_state FROM token_requests WHERE user_code = ?1 AND login IS NULL AND expires >= ?2",
      normalCode(userCode),
      Date.now()
    );
    return row
      ? {
          label: row.label,
          expires: Number(row.expires),
          grant: {
            scope: scopeOf(row.scope),
            docId: row.doc_id ?? null,
            expires: row.token_expires == null ? null : Number(row.token_expires),
          },
          oauth: row.redirect_uri ? { redirectUri: row.redirect_uri, state: row.oauth_state ?? null } : null,
        }
      : null;
  }

  /**
   * Approves a request as `who`: mints their token, as the request asks
   * (check: ScopeError if they can't have it), for the agent to collect.
   * `documentsOnly` gives a request for admin scope the documents scope instead: the person's choice on the card.
   * For an OAuth request, also its authorization code (good for CODE_MINUTES), to send its person back with.
   * Null if there's no such request waiting.
   */
  async approve(
    userCode: string,
    who: Who,
    documentsOnly = false
  ): Promise<{ info: AgentToken; oauth: (OAuthBack & { code: string }) | null } | null> {
    const waiting = await this.pending(userCode);
    if (!waiting) return null;
    const grant = documentsOnly && waiting.grant.scope == "admin" ? { ...waiting.grant, scope: "documents" as const } : waiting.grant;
    const { info } = await this.mint(who, waiting.label, grant);
    if (!waiting.oauth) {
      await this.sql.run("UPDATE token_requests SET login = ?2, token_id = ?3 WHERE user_code = ?1 AND login IS NULL", normalCode(userCode), info.login, info.id);
      return { info, oauth: null };
    }
    const code = "ergacode_" + randomToken(24);
    await this.sql.run(
      "UPDATE token_requests SET login = ?2, token_id = ?3, code_hash = ?4, expires = ?5 WHERE user_code = ?1 AND login IS NULL",
      normalCode(userCode),
      info.login,
      info.id,
      await sha256Hex(code),
      Date.now() + CODE_MINUTES * 60 * 1000
    );
    return { info, oauth: { ...waiting.oauth, code } };
  }

  /**
   * Denies a request: the agent's next poll hears it's gone; an OAuth request's person goes back to say so (`oauth`).
   * Null if there's no such request waiting.
   */
  async deny(userCode: string): Promise<{ oauth: OAuthBack | null } | null> {
    const waiting = await this.pending(userCode);
    if (!waiting) return null;
    await this.sql.run("DELETE FROM token_requests WHERE user_code = ?1 AND login IS NULL", normalCode(userCode));
    return { oauth: waiting.oauth };
  }

  /**
   * An agent's app trades its authorization code for the token (oauth.ts, /oauth/token): once, before the code
   * expires, from the client the code was made for, with the same redirect URI and the PKCE verifier of its
   * challenge. Null for anything else. A code tried is used up, right or wrong.
   */
  async exchange(code: string, client: string, redirectUri: string, verifier: string): Promise<{ token: string; info: AgentToken } | null> {
    const hash = await sha256Hex(code);
    const [row] = await this.sql.all<{
      expires: number;
      token_id: string | null;
      oauth_client: string;
      redirect_uri: string;
      code_challenge: string;
    }>(
      "SELECT expires, token_id, oauth_client, redirect_uri, code_challenge FROM token_requests WHERE code_hash = ?1 AND redirect_uri IS NOT NULL AND login IS NOT NULL",
      hash
    );
    if (!row) return null;
    await this.sql.run("DELETE FROM token_requests WHERE code_hash = ?1", hash);
    if (!row.token_id || Number(row.expires) < Date.now() || row.oauth_client != client || row.redirect_uri != redirectUri) return null;
    if (!(await pkceMatches(verifier, row.code_challenge))) return null;
    // Revoked before it was collected: nothing to hand over.
    const [token] = await this.sql.all<Row>(`SELECT ${COLUMNS} FROM agent_tokens WHERE id = ?1`, row.token_id);
    return token ? { token: await this.tokenFor(token.id), info: fromRow(token) } : null;
  }

  /** The agent polls: its token once approved (handed over once), "pending" until then, "gone" if it expired or was collected. */
  async collect(code: string): Promise<{ status: "pending" } | { status: "gone" } | { status: "ready"; token: string; login: string }> {
    const hash = await sha256Hex(code);
    // Not an OAuth request's code: that one is traded only with its PKCE verifier (exchange).
    const [row] = await this.sql.all<{ expires: number; login: string | null; token_id: string | null }>(
      "SELECT expires, login, token_id FROM token_requests WHERE code_hash = ?1 AND redirect_uri IS NULL",
      hash
    );
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

/** PKCE (RFC 7636, S256): the verifier is 43 to 128 of its characters, and its SHA-256, in base64url, is the challenge. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return base64url(await sha256(verifier)) == challenge;
}
