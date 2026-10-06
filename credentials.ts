// The API keys an admin enters on /admin (admin.ts): Anthropic's, for the
// editor's agent, the factory's agent and version descriptions, and
// OpenAI's, for OpenAI's models. docs/secrets.md ("Keys entered on the admin
// pages") says how they are kept, and this does it:
//
//   - Each key is encrypted with AES-GCM, a fresh IV each time, its name as
//     the additional data, under a key derived from a deploy-time secret
//     (FACTORY_KEY; locally the session secret), in a table of its own
//     (credentials, migrations/0140_credentials.sql). Not in the settings,
//     whose values are plain and copied into the change log.
//   - Nothing here answers a key to a page: `list` says only whether there is
//     one, its last four characters, and who set it when. `value` is for the
//     server's own calls to the providers.
//   - The change log gets "ANTHROPIC_API_KEY set by …", never the value.
//   - Admins only (Users.mustAdmin); admin.ts takes changes only from an
//     unlocked admin, in a browser, with a same-origin request.
//   - A server with no key stored uses the Worker secret of the same name
//     (`withCredentials`), so a server deployed without this page still works.

import type { Param, Sql, Statement } from "./directory.ts";
import type { Actor, Users } from "./users.ts";

/** The keys there are, by name: the Worker secret each stands in for, and how a real one starts. */
export const CREDENTIALS = {
  anthropic: { env: "ANTHROPIC_API_KEY", label: "Anthropic API key", prefix: "sk-ant-", description: "The editor's agent, the factory's agent and the descriptions of versions call Anthropic's API with it." },
  openai: { env: "OPENAI_API_KEY", label: "OpenAI API key", prefix: "sk-", description: "For OpenAI's models. Erga doesn't call OpenAI yet: a key set here is ready for when it does." },
} as const;
export type CredentialName = keyof typeof CREDENTIALS;
export const isCredentialName = (s: string): s is CredentialName => Object.hasOwn(CREDENTIALS, s);

/** A key as an admin sees it: never the key itself. */
export interface CredentialEntry {
  name: CredentialName;
  env: string;
  label: string;
  description: string;
  /** A key is stored here. */
  set: boolean;
  /** Its last four characters, if it is. */
  last4: string | null;
  updated: number | null;
  updatedBy: string | null;
  /** The deploy has a Worker secret of the same name: the server uses it while none is stored here. */
  fallback: boolean;
  /** This server has the secret to encrypt with, so it can store a key. */
  canStore: boolean;
}

/** A key that can't be stored (not one, or no secret to encrypt it with): the message says why. */
export class CredentialError extends Error {}

interface Row { name: string; iv: string; data: string; last4: string; updated: number; updated_by: string }

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Checks and tidies a key as pasted: its own provider's, one line, no spaces. */
export function checkKey(name: CredentialName, value: string): string {
  const c = CREDENTIALS[name], key = value.trim();
  if (!key) throw new CredentialError(`Paste the ${c.label}, or use Clear to remove it.`);
  if (name == "anthropic" && key.startsWith("sk-ant-oat")) throw new CredentialError(`That is a Claude plan token (sk-ant-oat…), not an API key: it goes on the Factory page. An API key starts with sk-ant-api.`);
  if (!key.startsWith(c.prefix)) throw new CredentialError(`That isn't an ${c.label}: one starts with ${c.prefix}.`);
  if (!/^[\x21-\x7e]{20,400}$/.test(key)) throw new CredentialError(`That isn't an ${c.label}: a key is 20 to 400 characters, with no spaces.`);
  return key;
}

export class Credentials {
  private aesKey: Promise<CryptoKey> | null;

  /**
   * `secret`: the deploy-time secret the keys are encrypted with (null: this
   * server can't store any). `fallback`: the Worker secrets the deploy has,
   * by name (e.g. ANTHROPIC_API_KEY), so the page can say one stands in.
   */
  constructor(private sql: Sql, private users: Users, secret: string | null, private fallback: (env: string) => boolean = () => false) {
    this.aesKey = secret ? (async () => {
      const raw = await crypto.subtle.digest("SHA-256", enc.encode(`erga-credentials:${secret}`));
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    })() : null;
  }

  /** Every key, as an admin sees it. Admins only. */
  async list(by: Actor): Promise<CredentialEntry[]> {
    await this.users.mustAdmin(by);
    const rows = new Map((await this.sql.all<Row>("SELECT name, last4, updated, updated_by FROM credentials")).map((r) => [r.name, r]));
    return (Object.keys(CREDENTIALS) as CredentialName[]).map((name) => {
      const c = CREDENTIALS[name], r = rows.get(name);
      return { name, env: c.env, label: c.label, description: c.description, set: !!r, last4: r?.last4 ?? null, updated: r ? Number(r.updated) : null, updatedBy: r?.updated_by ?? null, fallback: this.fallback(c.env), canStore: !!this.aesKey };
    });
  }

  /** Stores a key, in place of the one there was. Admins only. Answers it as `list` shows it. */
  async set(by: Actor, name: string, value: string): Promise<CredentialEntry> {
    await this.users.mustAdmin(by);
    const n = this.nameOf(name);
    const key = checkKey(n, value);
    if (!this.aesKey) throw new CredentialError("This server has no FACTORY_KEY to encrypt the key with: bun deploy/setup.ts --factory makes it (docs/secrets.md).");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(n) }, await this.aesKey, enc.encode(key)));
    const had = await this.has(n), at = Date.now(), login = by.login.toLowerCase();
    await this.sql.batch([
      [`INSERT INTO credentials (name, iv, data, last4, updated, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT (name) DO UPDATE SET iv = excluded.iv, data = excluded.data, last4 = excluded.last4, updated = excluded.updated, updated_by = excluded.updated_by`,
        n, b64(iv), b64(data), key.slice(-4), at, login],
      this.logged(n, had ? "replaced" : "set", at, login),
    ]);
    return (await this.list(by)).find((e) => e.name == n)!;
  }

  /** Removes a key: the server goes back to the Worker secret, if there is one. Admins only. */
  async clear(by: Actor, name: string): Promise<CredentialEntry> {
    await this.users.mustAdmin(by);
    const n = this.nameOf(name);
    if (await this.has(n)) {
      const at = Date.now(), login = by.login.toLowerCase();
      await this.sql.batch([["DELETE FROM credentials WHERE name = ?1", n], this.logged(n, "cleared", at, login)]);
    }
    return (await this.list(by)).find((e) => e.name == n)!;
  }

  /**
   * The stored key, decrypted, for the server's own calls to the provider;
   * null if there is none, or it can't be opened (stored under another
   * secret, as on staging, whose database is a copy of production's).
   * Never for a page.
   */
  async value(name: CredentialName): Promise<string | null> {
    if (!this.aesKey) return null;
    const [r] = await this.sql.all<Row>("SELECT iv, data FROM credentials WHERE name = ?1", name);
    if (!r) return null;
    try {
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(r.iv), additionalData: enc.encode(name) }, await this.aesKey, unb64(r.data)));
    } catch {
      return null;
    }
  }

  private async has(name: CredentialName): Promise<boolean> {
    return (await this.sql.all("SELECT 1 FROM credentials WHERE name = ?1", name)).length > 0;
  }

  private nameOf(name: string): CredentialName {
    if (!isCredentialName(name)) throw new CredentialError(`There's no key "${name}": the keys are ${Object.keys(CREDENTIALS).join(" and ")}.`);
    return name;
  }

  /** The change log's line for it (config.ts's server_config_versions): what happened to which key, never the key. */
  private logged(name: CredentialName, what: "set" | "replaced" | "cleared", at: number, by: string): Statement {
    const change = { key: CREDENTIALS[name].env, from: null, to: null, credential: what };
    return ["INSERT INTO server_config_versions (at, by, changes) VALUES (?1, ?2, ?3)", at, by, JSON.stringify([change]) as Param];
  }
}

/**
 * The Worker's bindings with the stored keys in place of the Worker secrets
 * of the same name: what the code that calls Anthropic or OpenAI reads its
 * key from. A key that isn't stored, or a database that doesn't answer,
 * leaves the Worker secret (if any) as it is.
 */
export async function withCredentials<E extends object>(env: E, credentials: Credentials | null): Promise<E> {
  if (!credentials) return env;
  const out = { ...env } as Record<string, unknown>;
  await Promise.all((Object.keys(CREDENTIALS) as CredentialName[]).map(async (name) => {
    try {
      const key = await credentials.value(name);
      if (key) out[CREDENTIALS[name].env] = key;
    } catch (e) {
      console.log(`couldn't read the stored ${CREDENTIALS[name].label}, so the Worker secret stands: ${e instanceof Error ? e.message : e}`);
    }
  }));
  return out as unknown as E;
}

