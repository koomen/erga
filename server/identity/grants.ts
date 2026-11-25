// Agent grants: a person lets an agent, a script, the API or MCP act for them. The gate signs the agent's tokens
// (gate/core.ts: a token names the person and a grant's id, and says nothing else). A grant is the row the server
// keeps for it: what it is for, and whether its person revoked it. The server reads the row on every request of the
// agent (`good`), so a revoke works at once, on every copy of the server. Each grant stands for one person, within a
// scope:
//
//   document    one document (`docId`), with the person's rights there, and nothing else: no listing, making or
//               deleting other documents
//   documents   everything the person can do with documents, but no admin power
//   admin       everything the person can do, admin power included while they are an admin (Users.isAdmin, checked on
//               every request); only an admin can make one
//
// A grant from MCP's sign-in is one exchange's of its code. The gate keeps no state, so it can't refuse a code's second
// use in the code's 60 seconds; it marks each exchange's tokens instead (gate/core.ts, `token`). The first token of a
// grant that comes here says which exchange is the grant's (`exchange`), and a token of another exchange revokes the
// grant: so a second use of a code gives nothing, and its person sees the revoke in Settings and in the changelog.
//
// A grant ends after GRANT_DAYS at most (the gate's tokens end then too), or sooner if its maker chose. Only a person
// signed in in a browser makes one: on the approval page of MCP's sign-in (authorize.ts), or as a token to paste
// (tokens-page.ts). An agent never can, whatever its scope.

import * as Schema from "effect/Schema";
import { changeLogEntry } from "../../shared/attribution.ts";
import { randomString } from "../../shared/bytes.ts";
import { ALPHABET, type Directory, type Sql } from "../directory/index.ts";

export type Scope = "document" | "documents" | "admin";
export const SCOPES: readonly Scope[] = ["document", "documents", "admin"];
/** The most days a grant lasts: its person approves again after that (the gate's Config.grantDays is the same). */
export const GRANT_DAYS = 30;
export const LABEL_MAX = 80;
/** How long a remote device-code sign-in stays pending (10 minutes). */
export const DEVICE_TTL_MS = 10 * 60_000;
/** Suggested seconds between device-code polls. */
export const DEVICE_INTERVAL_S = 2;
/** Unambiguous characters for short human-typed device codes (no 0/O/1/I/vowels). */
const USER_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";

/** Normalizes a typed user code ("bcdf-ghjk" or "bcdf ghjk" -> "BCDFGHJK"). */
export const normalizeUserCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Formats an 8-character user code with a middle dash ("BCDF-GHJK"). */
export const formatUserCode = (raw: string): string => {
  const clean = normalizeUserCode(raw);
  return clean.length == 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
};

async function sha256Url(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface DevicePending {
  userCode: string;
  approveState: string;
  clientId: string;
  challenge: string;
  expires: number;
}

export type DevicePollResult = { status: "approved"; code: string } | { status: "pending" | "denied" | "expired" | "invalid" };
/** last_used is written at most this often, so an agent's request isn't a write every time. */
const TOUCH_MS = 5 * 60 * 1000;

/** A grant as its person's list shows it. */
export interface Grant {
  id: string;
  /** Whom it stands for: their account. */
  login: string;
  /** What it's for, as whoever made it put it ("Claude Code", "My script"). */
  label: string;
  scope: Scope;
  /** A document grant's document (its id). */
  docId: string | null;
  /** When it stops working (milliseconds since the epoch). */
  expires: number;
  created: number;
  lastUsed: number | null;
}

/** What a grant is for, as its maker asks: its scope, a document grant's document, and when it ends (none: after GRANT_DAYS). */
export interface Ask {
  scope: Scope;
  docId?: string | null;
  expires?: number | null;
}

/** Who makes a grant: their account, the person as the gate names them, and how they act when not in person (`via`). */
export interface Maker {
  login: string;
  provider: string;
  subject: string;
  via?: string;
}

/** Why a grant can't be made (a wrong scope, a document that isn't the person's to open): the message says so. */
export class ScopeError extends Schema.TaggedError<ScopeError>()("ScopeError", { message: Schema.String }) {
  readonly status = 403;
}

/** The rule, with no exception: a token is made by a person, in person. An agent never makes one, of any kind. */
export const NOT_FOR_AGENTS = "An agent can't make a token: a user makes one, signed in as themselves, on the page.";

/** How the changelog says that the server revoked a grant whose code was traded for tokens two times. */
export const CODE_USED_TWICE = "the server (the grant's code was used two times)";

const clip = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || "Agent";

interface Row {
  id: string;
  login: string;
  provider: string;
  subject: string;
  label: string;
  scope: string;
  doc_id: string | null;
  expires: number;
  created: number;
  last_used: number | null;
  revoked: number | null;
  exchange: string | null;
}
const fromRow = (r: Row): Grant => ({
  id: r.id,
  login: r.login,
  label: r.label,
  scope: r.scope as Scope,
  docId: r.doc_id ?? null,
  expires: Number(r.expires),
  created: Number(r.created),
  lastUsed: r.last_used == null ? null : Number(r.last_used),
});
/** A grant that works at ?2: not revoked, not ended. */
const LIVE = "revoked IS NULL AND expires > ?2";

export class Grants {
  /** `dir` checks who may have which scope: admin for admins only, a document grant for a document the person may open. */
  constructor(
    private sql: Sql,
    private dir: Directory
  ) {}

  /**
   * Checks what someone asks a grant to be (throws ScopeError, saying why): a scope there is, admin only for an admin,
   * a document they may open, and an end in the future. Returns it tidied: its end is GRANT_DAYS from now at most.
   */
  async check(who: { login: string }, ask: Ask, now = Date.now()): Promise<Required<Ask> & { expires: number }> {
    if (!SCOPES.includes(ask.scope)) throw new ScopeError({ message: `"${ask.scope}" isn't a scope: document, documents or admin.` });
    const most = now + GRANT_DAYS * 86_400_000;
    const expires = ask.expires == null ? most : Math.min(Number(ask.expires), most);
    if (!(expires > now)) throw new ScopeError({ message: "The expiry must be in the future." });
    if (ask.scope == "admin" && !(await this.dir.users.isAdmin(who.login)))
      throw new ScopeError({ message: "Only an admin can make an admin token." });
    if (ask.scope != "document") return { scope: ask.scope, docId: null, expires };
    const doc = ask.docId ? await this.dir.find(ask.docId) : null;
    if (!doc || !(await this.dir.access({ login: who.login.toLowerCase() }, doc)))
      throw new ScopeError({ message: "A document token needs a document you may open." });
    return { scope: "document", docId: doc.id, expires };
  }

  /** A new grant of `who`'s, within `ask` (check). The gate makes its token: the server never holds one. */
  async make(who: Maker, label: string | null | undefined, ask: Ask): Promise<Grant> {
    if (who.via) throw new ScopeError({ message: NOT_FOR_AGENTS });
    const now = Date.now();
    const { scope, docId, expires } = await this.check(who, ask, now);
    const grant: Grant = {
      id: randomString(16, ALPHABET),
      login: who.login.toLowerCase(),
      label: clip(label),
      scope,
      docId,
      expires,
      created: now,
      lastUsed: null,
    };
    await this.sql.run(
      "INSERT INTO agent_grants (id, login, provider, subject, label, scope, doc_id, expires, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      grant.id,
      grant.login,
      who.provider,
      who.subject,
      grant.label,
      scope,
      docId,
      expires,
      now
    );
    await this.changed(grant.login, grant.id);
    return grant;
  }

  /** Their open Settings shows this grant as it is now, or without it (server/news/). */
  private changed(login: string, id: string): Promise<void> {
    return this.dir.publish([{ key: `token:${id}`, to: [login] }]);
  }

  /**
   * The grant an agent's token names, if it works now: there is such a row, it is this person's (as the gate names them
   * in the token), nobody revoked it, and it has not ended. Asked on every request of an agent, of the database.
   */
  async good(agent: { p: string; sub: string; g: string; x?: string }, now = Date.now()): Promise<Grant | null> {
    const [row] = await this.sql.all<Row>(`SELECT * FROM agent_grants WHERE id = ?1 AND ${LIVE}`, agent.g, now);
    // A scope that this code does not know (a row of other code) gives nothing: never a wider scope in its place.
    if (!row || row.provider != agent.p || row.subject != agent.sub || !SCOPES.includes(row.scope as Scope)) return null;
    // One exchange of its code only (see the top). The grant's first token says which: in one statement, so that of
    // two first tokens at once only one does.
    const x = agent.x ?? null;
    const [first] =
      row.exchange == null && x != null
        ? await this.sql.all<{ exchange: string }>(
            "UPDATE agent_grants SET exchange = COALESCE(exchange, ?2) WHERE id = ?1 RETURNING exchange",
            row.id,
            x
          )
        : [row];
    if (first.exchange != x) {
      await this.revoke(row.login, row.id, CODE_USED_TWICE);
      return null;
    }
    if (row.last_used == null || now - Number(row.last_used) > TOUCH_MS) {
      await this.sql.run("UPDATE agent_grants SET last_used = ?2 WHERE id = ?1", row.id, now).catch(() => {});
      row.last_used = now;
    }
    return fromRow(row);
  }

  /**
   * Someone's grants that still work, newest first: `limit` of them after the first `offset`, and how many there are in
   * all. One that ended or was revoked works no more, and isn't listed.
   */
  async list(login: string, limit: number, offset = 0): Promise<{ grants: Grant[]; total: number }> {
    const mine = `login = ?1 AND ${LIVE}`;
    const [rows, [count]] = await Promise.all([
      this.sql.all<Row>(
        `SELECT * FROM agent_grants WHERE ${mine} ORDER BY created DESC, rowid DESC LIMIT ?3 OFFSET ?4`,
        login.toLowerCase(),
        Date.now(),
        limit,
        offset
      ),
      this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_grants WHERE ${mine}`, login.toLowerCase(), Date.now()),
    ]);
    return { grants: rows.map(fromRow), total: Number(count?.n ?? 0) };
  }

  /**
   * Revokes one of `login`'s grants: its agent's next request is refused. `via`: how they did it, when not in person:
   * the changelog (/admin/changes) records it under them, with that.
   */
  async revoke(login: string, id: string, via?: string | null): Promise<boolean> {
    login = login.toLowerCase();
    const now = Date.now();
    const [row] = await this.sql.all<{ label: string }>(
      `SELECT label FROM agent_grants WHERE id = ?1 AND login = ?3 AND ${LIVE}`,
      id,
      now,
      login
    );
    if (!row) return false;
    await this.sql.batch([
      ["UPDATE agent_grants SET revoked = ?2 WHERE id = ?1", id, now],
      changeLogEntry(now, login, via, [
        { key: "token", from: null, to: null, token: { id, label: row.label, event: "revoked", of: login } },
      ]),
    ]);
    await this.changed(login, id);
    // The changelog's new line, on the open admin pages.
    await this.dir.users.pagesChanged([]);
    return true;
  }

  // ---------------------------------------------------------------- remote device-code sign-in (device_codes)

  /** Starts a pending device-code sign-in bound to `clientId` and PKCE `challenge` (S256). */
  async startDevice(
    clientId: string,
    challenge: string,
    now = Date.now()
  ): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
    await this.sql.run("DELETE FROM device_codes WHERE expires < ?1", now);
    const deviceCode = randomString(32, ALPHABET);
    const userCode = randomString(8, USER_ALPHABET);
    const approveState = randomString(32, ALPHABET);
    const deviceHash = await sha256Url(deviceCode);
    const expires = now + DEVICE_TTL_MS;
    await this.sql.run(
      "INSERT INTO device_codes (device_hash, user_code, approve_state, client_id, challenge, status, code, expires, created) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', NULL, ?6, ?7)",
      deviceHash,
      userCode,
      approveState,
      clientId,
      challenge,
      expires,
      now
    );
    return { deviceCode, userCode: formatUserCode(userCode), expiresIn: DEVICE_TTL_MS / 1000, interval: DEVICE_INTERVAL_S };
  }

  /** Finds a pending, unexpired device-code sign-in by its short human code. */
  async findDevice(rawUserCode: string, now = Date.now()): Promise<DevicePending | null> {
    const clean = normalizeUserCode(rawUserCode);
    if (!clean) return null;
    const [row] = await this.sql.all<{
      user_code: string;
      approve_state: string;
      client_id: string;
      challenge: string;
      expires: number;
    }>(
      "SELECT user_code, approve_state, client_id, challenge, expires FROM device_codes WHERE user_code = ?1 AND status = 'pending' AND expires > ?2",
      clean,
      now
    );
    return row
      ? {
          userCode: row.user_code,
          approveState: row.approve_state,
          clientId: row.client_id,
          challenge: row.challenge,
          expires: Number(row.expires),
        }
      : null;
  }

  /** Attaches the gate-signed PKCE authorization code (or denial) to a pending device-code sign-in. */
  async completeDevice(
    approveState: string,
    result: { ok: true; code: string } | { ok: false },
    now = Date.now()
  ): Promise<"approved" | "denied" | "missing"> {
    const status = result.ok ? "approved" : "denied";
    const updated = await this.sql.all<{ status: string }>(
      "UPDATE device_codes SET status = ?3, code = ?4 WHERE approve_state = ?1 AND status = 'pending' AND expires > ?2 RETURNING status",
      approveState,
      now,
      status,
      result.ok ? result.code : null
    );
    return updated.length ? status : "missing";
  }

  /** Polls a device-code sign-in by its secret `deviceCode` and consumes an approved code atomically once. */
  async pollDevice(deviceCode: string, clientId: string, now = Date.now()): Promise<DevicePollResult> {
    const deviceHash = await sha256Url(deviceCode);
    const [row] = await this.sql.all<{ client_id: string; status: string; code: string | null; expires: number }>(
      "SELECT client_id, status, code, expires FROM device_codes WHERE device_hash = ?1",
      deviceHash
    );
    if (!row || row.client_id != clientId) return { status: "invalid" };
    if (Number(row.expires) <= now) return { status: "expired" };
    if (row.status == "pending") return { status: "pending" };
    if (row.status == "denied") return { status: "denied" };
    if (row.status == "approved" && row.code) {
      const taken = await this.sql.all<{ device_hash: string }>(
        "UPDATE device_codes SET status = 'consumed', code = NULL WHERE device_hash = ?1 AND status = 'approved' RETURNING device_hash",
        deviceHash
      );
      if (taken.length) return { status: "approved", code: row.code };
    }
    return { status: "invalid" };
  }
}
