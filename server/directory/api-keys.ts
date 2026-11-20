// The API keys an admin enters on the Agents and models page (/admin/agents): one for each provider of
// models (Anthropic, OpenAI, Google, OpenRouter), for each person's agent
// (agents/models.ts), and Anthropic's for version descriptions. They are kept so:
//
//   - Each key is encrypted with AES-GCM, a fresh IV each time, its name as
//     the additional data, under a key derived from a deploy-time secret
//     (SECRETS_KEY; locally the session secret), in a table of its own
//     (credentials, server/migrations/0140_credentials.sql). Not in the settings,
//     whose values are plain and copied into the changelog.
//   - Nothing here answers a key to a page: `list` says only whether there is
//     one, its last four characters, and who set it when. `value` is for the
//     server's own calls to the providers.
//   - The changelog gets "ANTHROPIC_API_KEY set by …", never the value.
//   - Admins only (Users.mustAdmin); server/admin/routes.ts takes changes only from an
//     admin, in a browser, with a same-origin request.
//   - A server with no key stored uses the Worker secret of the same name
//     (agents/models.ts), so a server deployed without this page still works.
//
// Each server has a SECRETS_KEY of its own, so keys in a copy of another
// server's database don't open here. A
// key that doesn't open is shown as such (`unreadable`), and the agents
// say so. The last four characters are kept in plain text, for the page.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { changeLogEntry } from "../../shared/attribution.ts";
import type { Sql, Statement } from "./model.ts";
import type { Actor, Users } from "./index.ts";
import { randomBytes, sha256 } from "../../shared/bytes.ts";

/** A request to a provider: its address, and its headers (the key is in one). */
type Ask = { url: string; headers: Record<string, string> };

/**
 * The keys there are, by name: the Worker secret each stands in for, the service it is for, and the request that
 * checks a key with that service before it is kept (keyCheck): a free one that works with any key the service knows.
 * Nothing here looks at a key's shape: a provider changes it (Google's keys of 2026 start in a new way).
 * The requests and the refusals were read on 2026-11-19: Anthropic's, OpenAI's and Google's list of models
 * (platform.claude.com/docs/en/api/models/list, developers.openai.com/api/reference/resources/models/methods/list,
 * ai.google.dev/api/models), and OpenRouter's own facts of a key (its list of models asks for no key).
 */
export const CREDENTIALS = {
  anthropic: {
    env: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    service: "Anthropic",
    ask: (key: string): Ask => ({
      url: "https://api.anthropic.com/v1/models?limit=1",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }),
    description: "Each user's agent can use Claude with it, and the descriptions of versions call Anthropic's API with it.",
  },
  openai: {
    env: "OPENAI_API_KEY",
    label: "OpenAI API key",
    service: "OpenAI",
    ask: (key: string): Ask => ({ url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${key}` } }),
    description: "Each user's agent can use OpenAI's GPT models with it.",
  },
  google: {
    env: "GEMINI_API_KEY",
    label: "Google Gemini API key",
    service: "Google",
    ask: (key: string): Ask => ({
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      headers: { "x-goog-api-key": key },
    }),
    description: "Each user's agent can use Google's Gemini models with it.",
  },
  openrouter: {
    env: "OPENROUTER_API_KEY",
    label: "OpenRouter API key",
    service: "OpenRouter",
    ask: (key: string): Ask => ({ url: "https://openrouter.ai/api/v1/key", headers: { Authorization: `Bearer ${key}` } }),
    description: "Each user's agent can use the models Erga lists from OpenRouter (Grok, Kimi, DeepSeek) with it.",
  },
} as const satisfies Record<string, { env: string; label: string; service: string; ask: (key: string) => Ask; description: string }>;

/**
 * The secrets only the deploy sets (Worker secrets). Each admin page lists those for what it governs (server/admin/),
 * but can't change them: each is a root key, guards the sign-in, or is
 * shared with the other server, so a wrong value there could lock the admins
 * out or break both servers. A key here may be wrong at no greater cost than
 * the one feature it serves.
 */
export const DEPLOY_SECRETS = [
  {
    env: "SESSION_SECRET",
    service: "Erga",
    description: "Signs sessions and tokens. A change signs everyone out.",
    why: "It is the root key of every sign-in.",
  },
  {
    env: "SECRETS_KEY",
    service: "Erga",
    description: "Encrypts the secrets that this server stores.",
    why: "The API keys and the sign-in secrets that this server stores are encrypted with it.",
  },
  {
    env: "GITHUB_CLIENT_SECRET",
    service: "GitHub",
    description: "The secret of the GitHub OAuth app that signs people in.",
    why: "A wrong value stops every sign-in, the admin's too: the Sign-in page checks values with GitHub before it uses them.",
  },
  {
    env: "GITHUB_ISSUES_TOKEN",
    service: "GitHub",
    description: "Opens an issue for each feedback message. It needs only Issues: read and write.",
    why: "It writes to a repository on GitHub.",
  },
] as const;

/** A deploy-time secret as an admin sees it: only whether the deploy has it. */
export interface DeploySecretEntry {
  env: string;
  service: string;
  description: string;
  why: string;
  set: boolean /** Not set, but something stands in for it (SECRETS_KEY: the session secret, locally). */;
  standIn: boolean;
}

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
  /** A key is stored, but it doesn't open here: it was encrypted under another SECRETS_KEY. The server can't use it. */
  unreadable: boolean;
}

/** A key that can't be stored (not one, or no secret to encrypt it with): the message says why. */
export class CredentialError extends Schema.TaggedError<CredentialError>()("CredentialError", { message: Schema.String }) {
  readonly status = 400;
}

interface Row { name: string; iv: string; data: string; last4: string; updated: number; updated_by: string; updated_via?: string | null }

const enc = new TextEncoder();
const NO_SECRETS_KEY = "This server has no SECRETS_KEY to encrypt the key with: bun deploy/setup.ts makes it.";

/** Tidies a key as pasted, and refuses what no request can carry. Whether it is a key, its provider says (keyCheck). */
export function checkKey(name: CredentialName, value: string): string {
  const key = value.trim();
  if (!key) throw new CredentialError({ message: `Paste the ${CREDENTIALS[name].label}, or use Clear to remove it.` });
  if (!/^[\x21-\x7e]{1,400}$/.test(key))
    throw new CredentialError({ message: "A key is one line of 400 characters at most, with no spaces." });
  return key;
}

/** A key's check with its provider, before the key is kept: it throws what the provider says (a CredentialError). */
export type KeyCheck = (name: CredentialName, key: string) => Promise<void>;

/** A provider's refusal: all four say why in error.message. */
const Refusal = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }));

/**
 * The provider says whether a key is one: one request (CREDENTIALS, `ask`), with 8 s for the answer. Refused, or no
 * answer: the key is not kept, and the page says the provider's own reason. `standIn`: an origin that answers in each
 * provider's place, at /<name> (local development and the tests: dev/vite-plugin.ts).
 */
export const keyCheck =
  (standIn: string | null, f: typeof fetch = fetch): KeyCheck =>
  async (name, key) => {
    const { service, ask } = CREDENTIALS[name];
    const { url, headers } = ask(key);
    const answer = await Effect.runPromise(
      Effect.tryPromise({ try: (signal) => f(standIn ? `${standIn}/${name}` : url, { headers, signal }), catch: () => null }).pipe(
        Effect.timeoutOption(Duration.seconds(8)),
        Effect.map(Option.getOrNull),
        Effect.catch(() => Effect.succeed(null))
      )
    );
    if (answer?.ok) return;
    if (!answer) throw new CredentialError({ message: `${service} gave no answer, so the key isn't checked or saved. Try again.` });
    const said = Option.match(Schema.decodeOption(Refusal)(await answer.text().catch(() => "")), {
      onNone: () => `HTTP ${answer.status}`,
      onSome: (a) => a.error.message.replaceAll(key, "…"),
    });
    throw new CredentialError({ message: `${service} refuses this key, so it isn't saved. ${service} says: ${said}` });
  };

/**
 * AES-GCM under a key derived from the deploy-time secret: a value sealed with a fresh IV, bound to its `label` (the
 * additional data), so a row opens only under the same label: a key's name, a person and a provider, or a sign-in app.
 * `purpose` is in the derivation: each kind of value has a key of its own from the one secret.
 */
export class KeyBox {
  private key: Promise<CryptoKey>;
  constructor(secret: string, purpose: "erga-credentials" | "erga-auth-apps") {
    this.key = (async () =>
      crypto.subtle.importKey("raw", await sha256(`${purpose}:${secret}`), "AES-GCM", false, ["encrypt", "decrypt"]))();
  }
  async seal(label: string, value: string): Promise<{ iv: string; data: string }> {
    const iv = randomBytes(12);
    const data = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(label) }, await this.key, enc.encode(value))
    );
    return { iv: Base64.encode(iv), data: Base64.encode(data) };
  }
  /** The value, or null if it doesn't open (sealed under another secret, or another label). */
  async open(label: string, r: { iv: string; data: string }): Promise<string | null> {
    try {
      return new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: Result.getOrThrow(Base64.decode(r.iv)) as Uint8Array<ArrayBuffer>, additionalData: enc.encode(label) },
          await this.key,
          Result.getOrThrow(Base64.decode(r.data)) as Uint8Array<ArrayBuffer>
        )
      );
    } catch {
      return null;
    }
  }
}

export class Credentials {
  private box: KeyBox | null;

  /**
   * `secret`: the deploy-time secret the keys are encrypted with (null: this
   * server can't store any). `fallback`: the Worker secrets the deploy has,
   * by name (e.g. ANTHROPIC_API_KEY), so the page can say one stands in. `check`: a new key's check with its provider.
   */
  constructor(
    private sql: Sql,
    private users: Users,
    secret: string | null,
    private fallback: (env: string) => boolean = () => false,
    private check: KeyCheck = async () => {}
  ) {
    this.box = secret ? new KeyBox(secret, "erga-credentials") : null;
  }

  /** Every key, as an admin sees it. Admins only. */
  async list(by: Actor): Promise<CredentialEntry[]> {
    await this.users.mustAdmin(by);
    const rows = new Map((await this.sql.all<Row>("SELECT name, iv, data, last4, updated, updated_by, updated_via FROM credentials")).map((r) => [r.name, r]));
    return Promise.all(
      (Object.keys(CREDENTIALS) as CredentialName[]).map(async (name) => {
        const c = CREDENTIALS[name],
          r = rows.get(name);
        const unreadable = !!r && (await this.decrypt(name, r)) == null;
        return {
          name,
          env: c.env,
          label: c.label,
          service: c.service,
          description: c.description,
          set: !!r,
          last4: r?.last4 ?? null,
          updated: r ? Number(r.updated) : null,
          updatedBy: r?.updated_by ?? null,
          updatedVia: r?.updated_via ?? null,
          fallback: this.fallback(c.env),
          canStore: !!this.box,
          unreadable,
        };
      })
    );
  }

  /** The secrets only the deploy sets, and whether this server has each (never a value). Admins only. */
  async deployed(by: Actor): Promise<DeploySecretEntry[]> {
    await this.users.mustAdmin(by);
    return DEPLOY_SECRETS.map((s) => {
      const set = this.fallback(s.env);
      return { ...s, set, standIn: !set && s.env == "SECRETS_KEY" && !!this.box };
    });
  }

  /**
   * The server stores keys, and has no SECRETS_KEY to open them: its deploy lost the key (server/health.ts fails, and the
   * deploy puts the release before back). A server that has the key asks the database nothing.
   */
  async locked(): Promise<boolean> {
    return !this.box && (await this.sql.all("SELECT 1 FROM credentials UNION ALL SELECT 1 FROM person_keys LIMIT 1")).length > 0;
  }

  /** Stores a key, in place of the one there was. Admins only. Answers it as `list` shows it. */
  async set(by: Actor, name: string, value: string): Promise<CredentialEntry> {
    await this.users.mustAdmin(by);
    const n = nameOf(name);
    const key = checkKey(n, value);
    if (!this.box) throw new CredentialError({ message: NO_SECRETS_KEY });
    await this.check(n, key);
    const { iv, data } = await this.box.seal(n, key);
    const had = await this.has(n), at = Date.now(), login = by.login.toLowerCase();
    await this.sql.batch([
      [`INSERT INTO credentials (name, iv, data, last4, updated, updated_by, updated_via) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (name) DO UPDATE SET iv = excluded.iv, data = excluded.data, last4 = excluded.last4, updated = excluded.updated, updated_by = excluded.updated_by, updated_via = excluded.updated_via`,
        n,
        iv,
        data,
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
    const n = nameOf(name);
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
   * secret: a copy of another server's database).
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
    return this.box ? this.box.open(name, r) : null;
  }

  private async has(name: CredentialName): Promise<boolean> {
    return (await this.sql.all("SELECT 1 FROM credentials WHERE name = ?1", name)).length > 0;
  }

  /** The changelog's line for it (server/directory/settings.ts's server_config_versions): what happened to which key, never the key. */
  private logged(name: CredentialName, what: "set" | "replaced" | "cleared", at: number, by: string, via?: string): Statement {
    return changeLogEntry(at, by, via, [{ key: CREDENTIALS[name].env, from: null, to: null, credential: what }]);
  }
}

/** A person's own key, as they see it: never the key itself. */
export interface PersonKeyEntry {
  name: CredentialName;
  label: string;
  service: string;
  /** A key of theirs is stored. */
  set: boolean;
  last4: string | null;
  updated: number | null;
  /** Stored, but it doesn't open here (another server's SECRETS_KEY: a copy of its database). */
  unreadable: boolean;
  /** This server can store a key. */
  canStore: boolean;
}

/**
 * Each person's own API keys, for their own agent only (server/migrations/0290_person_keys.sql). Kept as the server's
 * keys are, each bound to its person and provider; every call reads and changes only the caller's own (`by.login`).
 * Nothing here answers a key to a page; `opened` is for that person's agent. Not in the changelog: it is the person's,
 * not the server's. A key is set only on its page (POST /api/agent/keys), never by an agent.
 */
export class PersonKeys {
  private box: KeyBox | null;
  constructor(
    private sql: Sql,
    secret: string | null,
    private check: KeyCheck = async () => {}
  ) {
    this.box = secret ? new KeyBox(secret, "erga-credentials") : null;
  }

  private label = (login: string, name: CredentialName) => `person:${login.toLowerCase()}:${name}`;

  private rows(login: string) {
    return this.sql.all<{ name: string; iv: string; data: string; last4: string; updated: number }>(
      "SELECT name, iv, data, last4, updated FROM person_keys WHERE login = ?1",
      login.toLowerCase()
    );
  }

  /** The person's own keys, one entry for each provider. */
  async list(by: Actor): Promise<PersonKeyEntry[]> {
    const rows = new Map((await this.rows(by.login)).map((r) => [r.name, r]));
    return Promise.all(
      (Object.keys(CREDENTIALS) as CredentialName[]).map(async (name) => {
        const c = CREDENTIALS[name],
          r = rows.get(name);
        const unreadable = !!r && (!this.box || (await this.box.open(this.label(by.login, name), r)) == null);
        return {
          name,
          label: c.label,
          service: c.service,
          set: !!r,
          last4: r?.last4 ?? null,
          updated: r ? Number(r.updated) : null,
          unreadable,
          canStore: !!this.box,
        };
      })
    );
  }

  /** Stores the person's key for a provider, in place of the one there was. */
  async set(by: Actor, name: string, value: string): Promise<PersonKeyEntry> {
    const n = nameOf(name),
      key = checkKey(n, value);
    if (!this.box) throw new CredentialError({ message: NO_SECRETS_KEY });
    await this.check(n, key);
    const { iv, data } = await this.box.seal(this.label(by.login, n), key);
    await this.sql.run(
      `INSERT INTO person_keys (login, name, iv, data, last4, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT (login, name) DO UPDATE SET iv = excluded.iv, data = excluded.data, last4 = excluded.last4, updated = excluded.updated`,
      by.login.toLowerCase(),
      n,
      iv,
      data,
      key.slice(-4),
      Date.now()
    );
    return (await this.list(by)).find((e) => e.name == n)!;
  }

  /** Removes the person's key for a provider. */
  async clear(by: Actor, name: string): Promise<PersonKeyEntry> {
    const n = nameOf(name);
    await this.sql.run("DELETE FROM person_keys WHERE login = ?1 AND name = ?2", by.login.toLowerCase(), n);
    return (await this.list(by)).find((e) => e.name == n)!;
  }

  /** The person's keys that open here, decrypted, by provider: for their own agent's calls, never for a page. */
  async opened(login: string): Promise<Partial<Record<CredentialName, string>>> {
    const box = this.box;
    if (!box) return {};
    const out: Partial<Record<CredentialName, string>> = {};
    for (const r of await this.rows(login)) {
      if (!isCredentialName(r.name)) continue;
      const key = await box.open(this.label(login, r.name), r);
      if (key) out[r.name] = key;
    }
    return out;
  }
}

function nameOf(name: string): CredentialName {
  if (!isCredentialName(name))
    throw new CredentialError({ message: `There's no key "${name}": the keys are ${Object.keys(CREDENTIALS).join(", ")}.` });
  return name;
}
