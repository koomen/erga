// Publishing a document to a domain in the person's own Cloudflare account:
// what the server keeps about it. publish.ts does the rest (the calls to
// Cloudflare, the files); deploys.ts runs the deploys; api.ts is the API.
//
// The site lives in the person's account, not on Erga: a Worker there with
// the published version's files as its static assets, on a custom domain of
// theirs (notes.example.com). Erga uploads a new copy each time the
// published version changes. Readers reach Cloudflare only, never erga.dev,
// so the site keeps working if Erga is down, and its traffic is theirs.
//
// Two tables:
//
//   - cloudflare_grants: each person's Cloudflare connection, an OAuth grant
//     from a consent in the browser (connect.ts; deploy/credential.ts keeps
//     and refreshes it, as it does the control Worker's). Its tokens are
//     sealed with AES-GCM under a key from FACTORY_KEY and the login, so a
//     row opens only for its own person, and only on this server. Nothing
//     answers a token to a page: only the accounts it reaches.
//   - sites: each document's hostname, the zone and account it is on, the
//     Worker that serves it, and whose connection deploys it. One site for
//     each document; one document for each hostname.
//
// Reached through the directory (dir.cloudflare, dir.sites).

import { OAuthCredential, sealKeyFrom, type StoredGrant, type TokenAnswer } from "../../deploy/credential.ts";
import type { Fetch } from "../../deploy/pipeline.ts";
import { open } from "../../deploy/seal.ts";
import type { Sql } from "../directory/index.ts";

/** A Cloudflare account, as a grant reaches it. */
export interface CfAccount { id: string; name: string }
/** A zone (a domain on Cloudflare), with the account it is in. */
export interface CfZone { id: string; name: string; account: CfAccount }

/** How this server reaches Cloudflare's OAuth: Erga's client, the network (or the pretend one), and the consent page's address (the pretend one's, locally). */
export interface SiteOAuth { clientId: string; net: Fetch; authorize?: string }

/**
 * What a person's consent asks for: Account Settings Read (their accounts),
 * Workers Admin (the site's Worker: Cloudflare's Editor role updates and
 * deploys a Worker that exists, but only Admin creates or deletes one;
 * developers.cloudflare.com/workers/authorization/workers/), Workers Routes
 * Write (the custom domain: Cloudflare asks for it on the zone, beside the
 * Worker's role), Zone Read (the list of domains), and offline_access (a
 * refresh token, so a site follows its document after the hour an access
 * token lasts). Each must be among the scopes of Erga's OAuth client;
 * Cloudflare takes a request for some of them.
 */
export const SITE_OAUTH_SCOPES = "account-settings.read workers-scripts.admin workers-routes.write zone.read offline_access";

/** The scopes a grant must have (offline_access isn't one Cloudflare names in the grant's scope). */
export const SITE_NEEDS = SITE_OAUTH_SCOPES.split(" ").filter((s) => s != "offline_access");

/** A person's connection, as their own pages show it: never a token. */
export interface ConnectionInfo {
  connected: boolean;
  accounts: CfAccount[];
  /** When they consented (ms since the epoch). */
  updated: number | null;
  /** Why the grant no longer works (Cloudflare refused a refresh: revoked), or null. */
  error: string | null;
  /** This server has the secret to seal with, so it can keep a grant. */
  canStore: boolean;
  /** A grant is kept, but it doesn't open here (another FACTORY_KEY: staging's copy of production's data). */
  unreadable: boolean;
}

/** A document's site, as stored. */
export interface SiteRow {
  docId: string;
  hostname: string;
  zoneId: string;
  zoneName: string;
  accountId: string;
  /** The Worker in their account that serves it. */
  script: string;
  /** Whose Cloudflare connection deploys it. */
  login: string;
  created: number;
  createdVia: string | null;
}

/** A refusal said for the person to act on (a bad hostname, a grant that can't be kept). */
export class SiteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

interface GrantRow { grant: string; accounts: string; updated: number }

/** What a person's grant says about itself in its messages: what to do is theirs, with Connect Cloudflare where it shows. */
const WORDS = (login: string) => ({
  subject: `${login}'s Cloudflare connection`,
  fix: `${login} connects Cloudflare again`,
  none: `${login} hasn't connected Cloudflare.`,
});

export class CloudflareGrants {
  /** One credential for each person, so two calls at once share one refresh (Cloudflare rotates the refresh token). */
  private credentials = new Map<string, OAuthCredential>();

  constructor(private sql: Sql, private secret: string | null) {}

  /** Someone's connection, as their pages show it. */
  async info(login: string): Promise<ConnectionInfo> {
    const r = await this.row(login);
    const grant = r ? parseGrant(r.grant) : null;
    const unreadable = !!grant && !(await this.opens(login, grant));
    const dead = !!grant && !grant.refresh && grant.expiresAt <= Date.now();
    const lacks = grant ? SITE_NEEDS.filter((s) => !grant.scopes.includes(s)) : [];
    const error = grant?.error ?? (dead ? "it expired and had no refresh token" : lacks.length ? `it doesn't allow ${lacks.join(", ")}, which publishing needs now` : null);
    return { connected: !!grant && !unreadable && !error, accounts: r ? parseAccounts(r.accounts) : [], updated: grant ? grant.at : null, error, canStore: !!this.secret, unreadable };
  }

  /** The grant after a consent (Cloudflare's answer to the code exchange), in place of theirs. Answers the access token. */
  async connect(login: string, oauth: SiteOAuth, answer: TokenAnswer, via?: string | null): Promise<string> {
    const token = await this.credential(login, oauth).connect(answer, login.toLowerCase());
    if (via) await this.sql.run("UPDATE cloudflare_grants SET updated_via = ?2 WHERE login = ?1", login.toLowerCase(), via);
    return token;
  }

  /** The accounts the grant reaches, as read after the consent. */
  async setAccounts(login: string, accounts: CfAccount[]): Promise<void> {
    await this.sql.run("UPDATE cloudflare_grants SET accounts = ?2 WHERE login = ?1", login.toLowerCase(), JSON.stringify(accounts));
  }

  /** Revokes someone's grant on Cloudflare and forgets it. Their sites stay up as they are, but don't change again until they connect again. */
  async disconnect(login: string, oauth: SiteOAuth): Promise<ConnectionInfo> {
    if (this.secret) await this.credential(login, oauth).disconnect();
    await this.sql.run("DELETE FROM cloudflare_grants WHERE login = ?1", login.toLowerCase());
    return this.info(login);
  }

  /**
   * Someone's access token, for the server's own calls to Cloudflare (refreshed when it is about to expire); null if
   * they have no grant, or it doesn't open here. Throws (DeployError) when Cloudflare refuses the refresh. Never for a page.
   */
  async token(login: string, oauth: SiteOAuth): Promise<string | null> {
    const r = await this.row(login);
    const grant = r ? parseGrant(r.grant) : null;
    if (!grant || !(await this.opens(login, grant))) return null;
    return this.credential(login, oauth).token();
  }

  /** The grant's refresh, revoke and sealing (deploy/credential.ts), on this person's row. */
  private credential(login: string, oauth: SiteOAuth): OAuthCredential {
    const who = login.toLowerCase();
    if (!this.secret) throw new SiteError("This server has no FACTORY_KEY to seal a Cloudflare connection with, so it can't keep one.", 503);
    const kept = this.credentials.get(who);
    if (kept) return kept;
    const credential = new OAuthCredential({
      storage: {
        get: async <T>() => { const r = await this.row(who); return (r ? parseGrant(r.grant) : undefined) as T | undefined; },
        put: async (_key, value) => {
          await this.sql.run(`INSERT INTO cloudflare_grants (login, "grant", accounts, updated) VALUES (?1, ?2, '[]', ?3)
            ON CONFLICT (login) DO UPDATE SET "grant" = excluded."grant", updated = excluded.updated`, who, JSON.stringify(value), Date.now());
        },
        delete: async () => { await this.sql.run("DELETE FROM cloudflare_grants WHERE login = ?1", who); },
      },
      net: oauth.net,
      client: { id: oauth.clientId },
      sealKey: this.keyOf(who),
      words: WORDS(who),
    });
    this.credentials.set(who, credential);
    return credential;
  }

  private keyOf(login: string) { return sealKeyFrom(`cloudflare-grant:${login.toLowerCase()}:${this.secret}`); }

  private async opens(login: string, grant: StoredGrant): Promise<boolean> {
    if (!this.secret) return false;
    try { await open(grant.access, await this.keyOf(login)); return true; } catch { return false; }
  }

  private async row(login: string): Promise<GrantRow | null> {
    return (await this.sql.all<GrantRow>('SELECT "grant", accounts, updated FROM cloudflare_grants WHERE login = ?1', login.toLowerCase()))[0] ?? null;
  }
}

function parseGrant(s: string): StoredGrant | null {
  try { const g = JSON.parse(s); return g && typeof g == "object" && g.access ? (g as StoredGrant) : null; } catch { return null; }
}

function parseAccounts(s: string): CfAccount[] {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((x) => typeof x?.id == "string").map((x) => ({ id: x.id, name: String(x.name ?? x.id) })) : []; } catch { return []; }
}

interface SiteDbRow { doc_id: string; hostname: string; zone_id: string; zone_name: string; account_id: string; script: string; login: string; created: number; created_via: string | null }
const siteOf = (r: SiteDbRow): SiteRow => ({ docId: r.doc_id, hostname: r.hostname, zoneId: r.zone_id, zoneName: r.zone_name, accountId: r.account_id, script: r.script, login: r.login, created: Number(r.created), createdVia: r.created_via });
const COLUMNS = "doc_id, hostname, zone_id, zone_name, account_id, script, login, created, created_via";

export class Sites {
  constructor(private sql: Sql) {}

  async get(docId: string): Promise<SiteRow | null> {
    const [r] = await this.sql.all<SiteDbRow>(`SELECT ${COLUMNS} FROM sites WHERE doc_id = ?1`, docId);
    return r ? siteOf(r) : null;
  }

  async byHostname(hostname: string): Promise<SiteRow | null> {
    const [r] = await this.sql.all<SiteDbRow>(`SELECT ${COLUMNS} FROM sites WHERE hostname = ?1`, hostname.toLowerCase());
    return r ? siteOf(r) : null;
  }

  /** The sites someone's connection deploys. */
  async list(login: string): Promise<SiteRow[]> {
    return (await this.sql.all<SiteDbRow>(`SELECT ${COLUMNS} FROM sites WHERE login = ?1 ORDER BY created`, login.toLowerCase())).map(siteOf);
  }

  /** Records a document's site. Refuses a hostname another document has, or a second site for one document. */
  async add(site: Omit<SiteRow, "created" | "createdVia">, via?: string | null): Promise<SiteRow> {
    const other = await this.byHostname(site.hostname);
    if (other && other.docId != site.docId) throw new SiteError(`${site.hostname} already shows another document. Choose another name, or remove it from that document first.`, 409);
    const mine = await this.get(site.docId);
    if (mine && mine.hostname != site.hostname) throw new SiteError(`This document is already at ${mine.hostname}. Remove that domain first.`, 409);
    if (mine) return mine;
    await this.sql.run(`INSERT INTO sites (${COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      site.docId, site.hostname.toLowerCase(), site.zoneId, site.zoneName, site.accountId, site.script, site.login.toLowerCase(), Date.now(), via ?? null);
    return (await this.get(site.docId))!;
  }

  async remove(docId: string): Promise<void> {
    await this.sql.run("DELETE FROM sites WHERE doc_id = ?1", docId);
  }
}

/**
 * A hostname as typed ("Notes.Example.com.", "https://notes.example.com/"),
 * checked against the zones the grant reaches: the hostname, and the zone it
 * is on (the longest zone name that ends it).
 */
export function checkHostname(typed: string, zones: CfZone[]): { hostname: string; zone: CfZone } {
  const hostname = typed.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!hostname) throw new SiteError("Type the address for the site, such as notes.example.com.");
  if (hostname.length > 253 || !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(hostname)) {
    throw new SiteError(`${hostname} isn't a hostname: use letters, digits, dashes and dots, such as notes.example.com.`);
  }
  if (hostname.startsWith("*.")) throw new SiteError("A site needs one hostname, not a wildcard.");
  const zone = zones.filter((z) => hostname == z.name || hostname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) {
    throw new SiteError(zones.length
      ? `${hostname} isn't on a domain your Cloudflare connection reaches. Your domains: ${zones.map((z) => z.name).join(", ")}.`
      : "Your Cloudflare account has no domains. Add a domain to Cloudflare first.");
  }
  return { hostname, zone };
}

/** The Worker's name in their account: erga-<slug>-<id>, fixed when the site is made (a rename doesn't move it). */
export function scriptName(docId: string, slug: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `erga-${s ? `${s}-` : ""}${docId}`;
}
