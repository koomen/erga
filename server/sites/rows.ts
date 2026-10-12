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
//   - cloudflare_connections: each person's Cloudflare API token, pasted on
//     /settings, encrypted with AES-GCM under a key from FACTORY_KEY (as the
//     API keys are, server/directory/api-keys.ts), the login as the additional data, so a
//     row can't be moved to another person. Nothing answers a token to a
//     page: only its last four characters, and the accounts it reaches.
//   - sites: each document's hostname, the zone and account it is on, the
//     Worker that serves it, and whose connection deploys it. One site for
//     each document; one document for each hostname.
//
// Reached through the directory (dir.cloudflare, dir.sites).

import type { Sql } from "../directory/index.ts";

/** A Cloudflare account, as a token reaches it. */
export interface CfAccount { id: string; name: string }
/** A zone (a domain on Cloudflare), with the account it is in. */
export interface CfZone { id: string; name: string; account: CfAccount }

/** A person's connection, as their own pages show it: never the token. */
export interface ConnectionInfo {
  connected: boolean;
  last4: string | null;
  accounts: CfAccount[];
  updated: number | null;
  /** This server has the secret to encrypt with, so it can keep a token. */
  canStore: boolean;
  /** A token is kept, but it doesn't open here (another FACTORY_KEY: staging's copy of production's data). */
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

/** A refusal said for the person to act on (a bad hostname, a token that can't be kept). */
export class SiteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface ConnRow { login: string; iv: string; data: string; last4: string; accounts: string; updated: number }

export class CloudflareConnections {
  private aesKey: Promise<CryptoKey> | null;

  constructor(private sql: Sql, secret: string | null) {
    this.aesKey = secret ? (async () => {
      const raw = await crypto.subtle.digest("SHA-256", enc.encode(`erga-cloudflare:${secret}`));
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    })() : null;
  }

  /** Someone's connection, as their pages show it. */
  async info(login: string): Promise<ConnectionInfo> {
    const r = await this.row(login);
    const unreadable = !!r && (await this.decrypt(login, r)) == null;
    return { connected: !!r && !unreadable, last4: r?.last4 ?? null, accounts: r ? parseAccounts(r.accounts) : [], updated: r ? Number(r.updated) : null, canStore: !!this.aesKey, unreadable };
  }

  /** Keeps a token someone checked, in place of theirs. */
  async save(login: string, token: string, accounts: CfAccount[], via?: string | null): Promise<ConnectionInfo> {
    if (!this.aesKey) throw new SiteError("This server has no FACTORY_KEY to encrypt the token with, so it can't keep one.", 503);
    const who = login.toLowerCase();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(who) }, await this.aesKey, enc.encode(token)));
    await this.sql.run(`INSERT INTO cloudflare_connections (login, iv, data, last4, accounts, updated, updated_via) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT (login) DO UPDATE SET iv = excluded.iv, data = excluded.data, last4 = excluded.last4, accounts = excluded.accounts, updated = excluded.updated, updated_via = excluded.updated_via`,
      who, b64(iv), b64(data), token.slice(-4), JSON.stringify(accounts), Date.now(), via ?? null);
    return this.info(who);
  }

  /** Forgets someone's token. Their sites stay up as they are, but don't change again until they connect again. */
  async remove(login: string): Promise<ConnectionInfo> {
    await this.sql.run("DELETE FROM cloudflare_connections WHERE login = ?1", login.toLowerCase());
    return this.info(login);
  }

  /** Someone's token, decrypted, for the server's own calls to Cloudflare; null if none, or it doesn't open here. Never for a page. */
  async token(login: string): Promise<string | null> {
    const r = await this.row(login);
    return r ? this.decrypt(login, r) : null;
  }

  private async row(login: string): Promise<ConnRow | null> {
    return (await this.sql.all<ConnRow>("SELECT login, iv, data, last4, accounts, updated FROM cloudflare_connections WHERE login = ?1", login.toLowerCase()))[0] ?? null;
  }

  private async decrypt(login: string, r: Pick<ConnRow, "iv" | "data">): Promise<string | null> {
    if (!this.aesKey) return null;
    try {
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(r.iv), additionalData: enc.encode(login.toLowerCase()) }, await this.aesKey, unb64(r.data)));
    } catch {
      return null;
    }
  }
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
 * checked against the zones the token reaches: the hostname, and the zone it
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
      ? `${hostname} isn't on a domain your Cloudflare token reaches. Your domains: ${zones.map((z) => z.name).join(", ")}.`
      : "Your Cloudflare token reaches no domains. Add a domain to Cloudflare, or give the token Zone Read on your domains.");
  }
  return { hostname, zone };
}

/** The Worker's name in their account: erga-<slug>-<id>, fixed when the site is made (a rename doesn't move it). */
export function scriptName(docId: string, slug: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `erga-${s ? `${s}-` : ""}${docId}`;
}
