// The API keys an admin enters on /admin/api-keys: Anthropic's,
// for the document agent, the admin's agent and version descriptions. They
// are kept so:
//
//   - Each key is encrypted with AES-GCM, a fresh IV each time, its name as
//     the additional data, under a key derived from a deploy-time secret
//     (FACTORY_KEY; locally the session secret), in a table of its own
//     (credentials, server/migrations/0140_credentials.sql). Not in the settings,
//     whose values are plain and copied into the change log.
//   - Nothing here answers a key to a page: `list` says only whether there is
//     one, its last four characters, and who set it when. `value` is for the
//     server's own calls to the providers.
//   - The change log gets "ANTHROPIC_API_KEY set by …", never the value.
//   - Admins only (Users.mustAdmin); server/admin/routes.ts takes changes only from an
//     admin, in a browser, with a same-origin request.
//   - A server with no key stored uses the Worker secret of the same name
//     (agents/models.ts), so a server deployed without this page still works.
//
// Staging has a FACTORY_KEY of its own, so production's keys, copied into
// staging's database, don't open there: on each new copy the deploy removes
// them and puts staging's own back. A
// key that still doesn't open is shown as such (`unreadable`), and the agents
// say so. The last four characters are kept in plain text, for the page.

import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { changeLogEntry } from "../../shared/attribution.ts";
import type { Sql, Statement } from "./directory.ts";
import type { Actor, Users } from "./index.ts";
import { randomBytes, sha256 } from "../../shared/bytes.ts";

/**
 * The keys there are, by name: the Worker secret each stands in for, the
 * service it is for, and how a real one starts (any start, if none).
 */
export const CREDENTIALS = {
  anthropic: {
    env: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    service: "Anthropic",
    prefixes: ["sk-ant-"],
    description: "The document agent, the admin's agent and the descriptions of versions call Anthropic's API with it.",
  },
} as const satisfies Record<string, { env: string; label: string; service: string; prefixes: readonly string[]; description: string }>;

/**
 * The secrets only the deploy sets (Worker secrets). The API keys page lists
 * them but can't change them: each is a root key, guards the sign-in, or is
 * shared with the other server, so a wrong value there could lock the admins
 * out or break both servers. A key here may be wrong at no greater cost than
 * the one feature it serves.
 */
export const DEPLOY_SECRETS = [
  { env: "SESSION_SECRET", service: "Erga", description: "Signs sessions, agent tokens and admin tokens. If it changes, everyone is signed out.", why: "It is the root key of every sign-in." },
  { env: "FACTORY_KEY", service: "Erga", description: "Encrypts the keys on this page and the sign-in secrets.", why: "The keys on this page are encrypted with it." },
  { env: "GITHUB_CLIENT_SECRET", service: "GitHub", description: "Signs people in with GitHub (the OAuth app). The Authentication page (/admin/auth) shows whether it works, and can set another app's values over it.", why: "A wrong value stops every sign-in, the admin's too: the Authentication page checks values with GitHub before it uses them." },
  { env: "SNAPSHOT_TOKEN", service: "Erga", description: "Lets staging copy production's documents.", why: "Production and staging must have the same value." },
] as const;

/** A deploy-time secret as an admin sees it: only whether the deploy has it. */
export interface DeploySecretEntry { env: string; service: string; description: string; why: string; set: boolean; /** Not set, but something stands in for it (FACTORY_KEY: the session secret, locally). */ standIn: boolean }

const aOrAn = (label: string) => `${/^[AEIOU]/.test(label) ? "an" : "a"} ${label}`;
export type CredentialName = keyof typeof CREDENTIALS;
export const isCredentialName = (s: string): s is CredentialName => Object.hasOwn(CREDENTIALS, s);

/** A key as an admin sees it: never the key itself. */
export interface CredentialEntry {
  name: CredentialName;
  env: string;
  label: string;
  service: string;
  description: string;
  /** A key is stored here. */
  set: boolean;
  /** Its last four characters, if it is. */
  last4: string | null;
  updated: number | null;
  updatedBy: string | null;
  /** How `updatedBy` did it, when not in person. */
  updatedVia?: string | null;
  /** The deploy has a Worker secret of the same name: the server uses it while none is stored here. */
  fallback: boolean;
  /** This server has the secret to encrypt with, so it can store a key. */
  canStore: boolean;
  /** A key is stored, but it doesn't open here: it was encrypted under another FACTORY_KEY. The server can't use it. */
  unreadable: boolean;
}

/** A key that can't be stored (not one, or no secret to encrypt it with): the message says why. */
export class CredentialError extends Schema.TaggedError<CredentialError>()("CredentialError", { message: Schema.String }) {}

interface Row { name: string; iv: string; data: string; last4: string; updated: number; updated_by: string; updated_via?: string | null }

const enc = new TextEncoder();

/** Checks and tidies a key as pasted: its own provider's, one line, no spaces. */
export function checkKey(name: CredentialName, value: string): string {
  const c = CREDENTIALS[name], key = value.trim();
  if (!key) throw new CredentialError({ message: `Paste the ${c.label}, or use Clear to remove it.` });
  if (name == "anthropic" && key.startsWith("sk-ant-oat"))
    throw new CredentialError({ message: `That is a Claude plan token (sk-ant-oat…), not an API key. An API key starts with sk-ant-api.` });
  const prefixes: readonly string[] = c.prefixes;
  if (prefixes.length && !prefixes.some((p) => key.startsWith(p)))
    throw new CredentialError({ message: `That isn't ${aOrAn(c.label)}: one starts with ${prefixes.join(" or ")}.` });
  if (!/^[\x21-\x7e]{20,400}$/.test(key))
    throw new CredentialError({ message: `That isn't ${aOrAn(c.label)}: a key is 20 to 400 characters, with no spaces.` });
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
          const raw = await sha256(`erga-credentials:${secret}`);
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    })() : null;
  }

  /** Every key, as an admin sees it. Admins only. */
  async list(by: Actor): Promise<CredentialEntry[]> {
    await this.users.mustAdmin(by);
    const rows = new Map((await this.sql.all<Row>("SELECT name, iv, data, last4, updated, updated_by, updated_via FROM credentials")).map((r) => [r.name, r]));
    return Promise.all((Object.keys(CREDENTIALS) as CredentialName[]).map(async (name) => {
      const c = CREDENTIALS[name], r = rows.get(name);
      const unreadable = !!r && (await this.decrypt(name, r)) == null;
      return { name, env: c.env, label: c.label, service: c.service, description: c.description, set: !!r, last4: r?.last4 ?? null, updated: r ? Number(r.updated) : null, updatedBy: r?.updated_by ?? null, updatedVia: r?.updated_via ?? null, fallback: this.fallback(c.env), canStore: !!this.aesKey, unreadable };
    }));
  }

  /** The secrets only the deploy sets, and whether this server has each (never a value). Admins only. */
  async deployed(by: Actor): Promise<DeploySecretEntry[]> {
    await this.users.mustAdmin(by);
    return DEPLOY_SECRETS.map((s) => {
      const set = this.fallback(s.env);
      return { ...s, set, standIn: !set && s.env == "FACTORY_KEY" && !!this.aesKey };
    });
  }

  /** Stores a key, in place of the one there was. Admins only. Answers it as `list` shows it. */
  async set(by: Actor, name: string, value: string): Promise<CredentialEntry> {
    await this.users.mustAdmin(by);
    const n = this.nameOf(name);
    const key = checkKey(n, value);
    if (!this.aesKey)
      throw new CredentialError({ message: "This server has no FACTORY_KEY to encrypt the key with: bun deploy/setup.ts makes it." });
    const iv = randomBytes(12);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(n) }, await this.aesKey, enc.encode(key)));
    const had = await this.has(n), at = Date.now(), login = by.login.toLowerCase();
    await this.sql.batch([
      [`INSERT INTO credentials (name, iv, data, last4, updated, updated_by, updated_via) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (name) DO UPDATE SET iv = excluded.iv, data = excluded.data, last4 = excluded.last4, updated = excluded.updated, updated_by = excluded.updated_by, updated_via = excluded.updated_via`,
        n,
        Base64.encode(iv),
        Base64.encode(data),
        key.slice(-4),
        at,
        login,
        by.via ?? null,
      ],
      this.logged(n, had ? "replaced" : "set", at, login, by.via),
    ]);
    await this.users.pagesChanged([`apikey:${n}`]);
    return (await this.list(by)).find((e) => e.name == n)!;
  }

  /** Removes a key: the server goes back to the Worker secret, if there is one. Admins only. */
  async clear(by: Actor, name: string): Promise<CredentialEntry> {
    await this.users.mustAdmin(by);
    const n = this.nameOf(name);
    if (await this.has(n)) {
      const at = Date.now(), login = by.login.toLowerCase();
      await this.sql.batch([["DELETE FROM credentials WHERE name = ?1", n], this.logged(n, "cleared", at, login, by.via)]);
      await this.users.pagesChanged([`apikey:${n}`]);
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
    return (await this.opened(name)).key;
  }

  /** The stored key, decrypted (null if none), and whether one is stored that doesn't open here. Never for a page. */
  async opened(name: CredentialName): Promise<{ key: string | null; unreadable: boolean }> {
    const [r] = await this.sql.all<Row>("SELECT iv, data FROM credentials WHERE name = ?1", name);
    if (!r) return { key: null, unreadable: false };
    const key = await this.decrypt(name, r);
    return { key, unreadable: key == null };
  }

  /** A row's key, or null if it doesn't open with this server's secret (or the server has none). */
  private async decrypt(name: CredentialName, r: Pick<Row, "iv" | "data">): Promise<string | null> {
    if (!this.aesKey) return null;
    try {
      return new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: Result.getOrThrow(Base64.decode(r.iv)) as Uint8Array<ArrayBuffer>, additionalData: enc.encode(name) },
          await this.aesKey,
          Result.getOrThrow(Base64.decode(r.data)) as Uint8Array<ArrayBuffer>
        )
      );
    } catch {
      return null;
    }
  }

  private async has(name: CredentialName): Promise<boolean> {
    return (await this.sql.all("SELECT 1 FROM credentials WHERE name = ?1", name)).length > 0;
  }

  private nameOf(name: string): CredentialName {
    if (!isCredentialName(name))
      throw new CredentialError({ message: `There's no key "${name}": the keys are ${Object.keys(CREDENTIALS).join(", ")}.` });
    return name;
  }

  /** The change log's line for it (server/directory/settings.ts's server_config_versions): what happened to which key, never the key. */
  private logged(name: CredentialName, what: "set" | "replaced" | "cleared", at: number, by: string, via?: string): Statement {
    return changeLogEntry(at, by, via, [{ key: CREDENTIALS[name].env, from: null, to: null, credential: what }]);
  }
}
