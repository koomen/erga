// The server's settings: key/value pairs in the server_config table,
// each a JSON value, with who set it and when. Only the keys
// declared in SETTINGS exist: each has a description, a default (what it is
// until an admin sets it) and a parser that checks a value and says what's
// wrong with a bad one, for a person or an agent to act on.
//
// Reading a setting is for anyone (the server reads them to do its work);
// listing them and changing them is for admins.
//
// A key can also be fixed by the deploy (deploy/locked-settings.ts, and
// ERGA_SERVER_CONFIG over it): then its deployed value wins over the table,
// and nobody can change it here (admin page, API or agent): it's `locked`,
// and shows its deployed value. A key the deploy leaves out is the admins'
// to set. To add a setting, add it to SETTINGS; nothing in the database
// changes.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Sql, Statement } from "./directory.ts";
import type { SignInProvider } from "./identities.ts";
import { NotAllowed, type Actor, type Users } from "./index.ts";

/** A write another write came in on the middle of: it tries again. */
class Interleaved extends Data.TaggedError("Interleaved") {}

/** A value a setting won't take; the message says why. */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", { message: Schema.String }) {}

export interface Setting<T = unknown> {
  /** Its name on the admin page, where it isn't the key. */
  label?: string;
  /** What it does, for the admin (or agent) changing it. */
  description: string;
  /** Its value until it's set. */
  default: T;
  /** A value as given (parsed JSON), checked: throws a ConfigError saying what's wrong. */
  parse(value: unknown): T;
  /** What the value names, when it isn't just a number or text: "document" (one of the server's documents, by id), "users" (a list of logins). */
  kind?: "document" | "users";
  /** The values the admin page offers, as a select (as a switch when they're "off" and "on"). The parser may take others too. */
  choices?: string[];
}

/** A whole number from `min` to `max`. */
export const integer =
  (min: number, max: number) =>
  (v: unknown): number => {
    if (typeof v != "number" || !Number.isInteger(v) || v < min || v > max)
      throw new ConfigError({ message: `must be a whole number from ${min} to ${max}` });
    return v;
  };
/** A string of at most `max` characters (trimmed). */
export const text =
  (max: number) =>
  (v: unknown): string => {
    if (typeof v != "string") throw new ConfigError({ message: "must be a string" });
    if (v.trim().length > max) throw new ConfigError({ message: `must be at most ${max} characters` });
  return v.trim();
};
/** A list of GitHub logins (lowercased, no "@", each once); a string of them, split by commas or spaces, too. */
export const logins = (v: unknown): string[] => {
  const list = typeof v == "string" ? v.split(/[\s,]+/) : v;
  if (!Array.isArray(list) || list.some((l) => typeof l != "string")) throw new ConfigError({ message: "must be a list of GitHub logins" });
  const out = [...new Set((list as string[]).map((l) => l.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
  const bad = out.find((l) => !/^[a-z0-9][a-z0-9-]{0,38}$/.test(l));
  if (bad) throw new ConfigError({ message: `has "${bad}", which isn't a GitHub login` });
  return out;
};
export const boolean = (v: unknown): boolean => {
  if (typeof v != "boolean") throw new ConfigError({ message: "must be true or false" });
  return v;
};

const setting = <T>(s: Setting<T>) => s;

/** The settings the Access page sets (/admin/access), not the Settings page. */
export const ACCESS_SETTINGS: readonly string[] = ["public_sharing"];

/** Every setting the server has. */
export const SETTINGS = {
  delete_docs_after_hours: setting<number | null>({
    description: "Hours before an unedited new document is deleted; null: never.",
    default: 24,
    // null, or "never" (as an agent or a deploy might say it), is never.
    parse: (v) => {
      if (v === null || (typeof v == "string" && v.trim().toLowerCase() == "never")) return null;
      if (typeof v != "number" || !Number.isInteger(v) || v < 1 || v > 24 * 365)
        throw new ConfigError({ message: `must be a whole number from 1 to ${24 * 365} (hours), or null for never` });
      return v;
    },
  }),
  landing_document: setting<string | null>({
    label: "Homepage Project",
    description: "Document or project shown at /; empty: a fresh copy of the repo's demo page.",
    default: null,
    parse: (v) => (v === null || v === "" ? null : text(300)(v) || null),
    kind: "document",
  }),
  max_file_mb: setting<number>({
    description: "The most megabytes one file may have, as someone or their agent adds it to a document (an upload, a write of bytes).",
    default: 100,
    parse: integer(1, 500),
  }),
  max_project_gb: setting<number>({
    description: "The most gigabytes the files of one project (a document is a project with one page) may have together; an upload that would pass it is refused.",
    default: 5,
    parse: integer(1, 1000),
  }),
  public_sharing: setting<boolean>({
    description:
      "Users can share content publicly: a document shared with anyone with the link opens for people who aren't signed in too, as viewers (the Access page). Off: nobody may share with anyone with the link, and such shares made before open only for people who sign in. The homepage is public either way.",
    default: false,
    parse: boolean,
  }),
  deploy_page: setting<"off" | "admins" | "users">({
    description: "Who may use /deploy, to deploy Erga to their own Cloudflare account: off, admins (and users with the deploy role, on /admin/users) or users (anyone signed in).",
    default: "users",
    parse: (v) => {
      const s = typeof v == "string" ? v.trim().toLowerCase() : v;
      if (s === "off" || s === "admins" || s === "users") return s;
      throw new ConfigError({ message: 'must be "off", "admins" or "users"' });
    },
    choices: ["off", "admins", "users"],
  }),
};

export type Settings = Record<string, Setting>;
type ValueOf<S extends Setting> = S extends Setting<infer T> ? T : never;

/** A setting as an admin sees it. */
export interface ConfigEntry {
  key: string;
  description: string;
  /** What it is now: the locked value, else the one set, else the default. */
  value: unknown;
  default: unknown;
  /** Where `value` comes from. */
  source: "default" | "set" | "locked";
  /** Fixed by the deploy: nobody can set or reset it here (show it read-only). */
  locked: boolean;
  /** What the value names, if it isn't plain (Setting.kind). */
  kind?: "document" | "users";
  /** Its name on the admin page, where it isn't the key (Setting.label). */
  label?: string;
  /** The values the admin page offers (Setting.choices). */
  choices?: string[];
  /** The value the deploy fixes it to (only when it's locked; then it's `value` too). */
  deployed?: unknown;
  /** When it was last set, and by whom (null if it never was, or it's locked). */
  updated: number | null;
  updatedBy: string | null;
  /** How `updatedBy` set it, when not in person: "their admin agent", "a shared agent (label)". */
  updatedVia?: string | null;
}

/**
 * The values a deploy fixes, checked against `settings`: each key must be
 * one there is, and each value one it takes. Throws a ConfigError saying
 * what's wrong. `bun deploy/locked-settings.ts` runs it on what the deploy fixes, so a
 * bad one fails the deploy or `bun start`, not the server.
 */
export function deployedSettings(values: Record<string, unknown>, settings: Settings = SETTINGS): Record<string, unknown> {
  if (!values || typeof values != "object" || Array.isArray(values))
    throw new ConfigError({ message: "the deploy's server config must be an object of settings by key" });
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const s = Object.hasOwn(settings, key) ? settings[key] : undefined;
    if (!s)
      throw new ConfigError({
        message: `the deploy fixes "${key}", which isn't a setting (the settings are: ${Object.keys(settings).sort().join(", ")})`,
      });
    try {
      out[key] = s.parse(value);
    } catch (e) {
      throw new ConfigError({ message: `the deploy fixes ${key} to ${JSON.stringify(value)}, but it ${(e as Error).message}` });
    }
  }
  return out;
}

/**
 * The deploy's values as the Worker gets them: the SERVER_CONFIG binding, a
 * JSON object (cloudflare.config.ts makes it from deploy/locked-settings.ts and
 * ERGA_SERVER_CONFIG). Empty or missing: nothing is locked. A bad one
 * throws, as the server starts (but the deploy checks it first).
 */
export function parseDeployed(json: string | undefined, settings: Settings = SETTINGS): Record<string, unknown> {
  if (!json?.trim()) return {};
  let values: unknown;
  try {
    values = JSON.parse(json);
  } catch {
    throw new ConfigError({ message: `the deploy's server config isn't JSON: ${json.slice(0, 200)}` });
  }
  return deployedSettings(values as Record<string, unknown>, settings);
}

/** One setting's change, in a version of the settings: its value as it applied before and after. */
export interface SettingChange {
  key: string;
  from: unknown;
  to: unknown;
  /** Put back to its default (Reset). */
  reset?: boolean;
  /** An API key admins enter, by its Worker secret's name: what happened to it. `from` and `to` are null, never the key. */
  credential?: "set" | "replaced" | "cleared";
  /** A factory task (key "task", from before the factory was removed): added to the board, or merged into staging (`commit`: the merge commit). `from` and `to` are null. */
  task?: { id: number; title: string; event: "added" | "merged"; commit?: string };
  /** main moved forward to staging (key "main"): the production deploy; or staging moved by a push past the staging rule (key "staging", with `override`). `from` and `to` are the branch's old and new heads (null: none); `commits`, the newest that came (at most 50), of `total`. */
  release?: {
    commits: { sha: string; subject: string }[]; total: number;
    /** main moved past the production gate (its tests hadn't passed), or staging past the staging rule: an admin's emergency override, with their reason and what the gate or rule said. */
    override?: { reason: string; gate: string };
  };
  /** An admin opened an override of the staging rule (key "staging"; control/source/repo.ts, STAGING_RULE): their pushes to staging land until `until` (ms). `from` and `to` are null. A push made under it is a `release` with `override`. */
  stagingOverride?: { reason: string; until: number };
  /** A user (key "user"): added, their role or deploy role changed, or removed. `from` and `to` are null. */
  user?: { login: string; event: "added" | "role" | "deploy" | "removed"; role?: string; deploy?: boolean };
  /** An access rule (key "access"; server/directory/access.ts): added, its access changed, or removed. `from` and `to` are null. */
  access?: { event: "added" | "changed" | "removed"; kind: string; value: string; access: string; from?: string };
  /** An agent token (key "token"): revoked (`by` revoked it; `of`, whose it was). `from` and `to` are null. */
  token?: { id: string; label: string; event: "revoked"; of: string };
  /** A server's sign-in app (key "sign-in"; server/identity/sign-in.ts): set, waiting for a test sign-in, put in use by one, discarded or cleared. Never the secret. */
  signIn?: SignInChange;
  /** Before #69, how the version's `by` did it, kept on the change; now on the version (SettingsVersion.via). */
  via?: string;
}

/** A server's sign-in app changed (server/identity/apps.ts): its line in the change log. */
export interface SignInChange {
  provider: SignInProvider;
  /** The server whose app changed ("" for one that isn't a deploy target). */
  target: string;
  event: "set" | "pending" | "tested" | "discarded" | "cleared" | "on" | "off";
  /** The client ID it changed to (public), if any. */
  clientId?: string | null;
}

/** A version of the settings (server_config_versions): who changed them, when, and what changed. */
export interface SettingsVersion {
  /** 1, 2, 3..., in the order they were made. */
  n: number;
  at: number;
  /** The person's login (SYSTEM for the server itself: shared/attribution.ts). */
  by: string;
  /** How they did it, when not in person: "their admin agent", "a shared agent (label)", "the factory (task #3)". */
  via?: string;
  changes: SettingChange[];
}

interface Row { key: string; value: string; updated: number; updated_by: string | null; updated_via?: string | null }
/**
 * By key: a parsed value someone sets, checked against more than the
 * setting's parser knows (the directory, who's setting it). Answers the value
 * to keep, or throws a ConfigError or NotAllowed saying why not.
 */
export type Checks = Record<string, (by: Actor, value: unknown) => Promise<unknown>>;
const REMEMBER_MS = 10_000;

export class ServerConfig<S extends Settings = typeof SETTINGS> {
  readonly settings: S;
  private locked: Record<string, unknown>;
  private checks: Checks;
  private changed: (key: string) => Promise<void>;
  private rows: { at: number; byKey: Map<string, Row> } | null = null;

  /**
   * `settings`: the keys there are (SETTINGS). `locked`: values fixed by the
   * deploy, by key; each must be a key there is, and a value it takes.
   * `checks`: by key, what else a value set by someone must pass, beyond its
   * parser (the directory's: a landing document must be the setter's own).
   * `changed`: told of every change to a key (set, reset or claimed), once
   * it's written (the Worker tells the homepage's deploys: server/home/deploys.ts).
   */
  /** `defaults`: other defaults than SETTINGS' (local development's), still the admins' to change. */
  constructor(private sql: Sql, private users: Users, opts: { settings?: S; locked?: Record<string, unknown>; defaults?: Record<string, unknown>; checks?: Checks; changed?: (key: string) => Promise<void> } = {}) {
    const base = opts.settings ?? (SETTINGS as unknown as S);
    this.settings = { ...base, ...Object.fromEntries(Object.entries(opts.defaults ?? {}).filter(([k]) => k in base).map(([k, v]) => [k, { ...base[k], default: base[k].parse(v) }])) } as S;
    this.locked = deployedSettings(opts.locked ?? {}, this.settings);
    this.checks = opts.checks ?? {};
    this.changed = opts.changed ?? (async () => {});
  }

  /** Tells `changed`; a failure there is logged, never the setter's. */
  private async tell(key: string): Promise<void> {
    try { await this.changed(key); } catch (e) { console.log(`couldn't pass on the change to ${key}: ${e}`); }
  }

  /** Whether the deploy fixes this key's value. */
  isLocked(key: string): boolean {
    return Object.hasOwn(this.locked, key);
  }

  /** A setting's value now (for the server's own use: anyone may read). */
  async get<K extends keyof S & string>(key: K): Promise<ValueOf<S[K]>> {
    return (await this.entry(key)).value as ValueOf<S[K]>;
  }

  /** A setting as an admin sees it. */
  async entry(key: string): Promise<ConfigEntry> {
    const s = this.setting(key);
    const row = (await this.table()).get(key);
    const base = {
      key,
      description: s.description,
      default: s.default,
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.label ? { label: s.label } : {}),
      ...(s.choices ? { choices: s.choices } : {}),
    };
    // The deploy's value wins; a row set before it was locked stays in the table, and counts again once it isn't.
    if (this.isLocked(key)) return { ...base, value: this.locked[key], source: "locked", locked: true, deployed: this.locked[key], updated: null, updatedBy: null };
    if (row) {
      try {
        return { ...base, value: s.parse(JSON.parse(row.value)), source: "set", locked: false, updated: Number(row.updated), updatedBy: row.updated_by, updatedVia: row.updated_via ?? null };
      } catch { /* a value an older or newer version took: the default stands */ }
    }
    return { ...base, value: s.default, source: "default", locked: false, updated: null, updatedBy: null };
  }

  /** Every setting, as an admin sees it. Admins only. */
  async list(by: Actor): Promise<ConfigEntry[]> {
    await this.users.mustAdmin(by);
    return Promise.all(Object.keys(this.settings).sort().map((k) => this.entry(k)));
  }

  /** Sets a setting (a JSON-able value it takes). Admins only; a locked one can't be. */
  async set(by: Actor, key: string, value: unknown): Promise<ConfigEntry> {
    await this.users.mustAdmin(by);
    const s = this.setting(key);
    if (this.isLocked(key))
      throw new NotAllowed({
        message: `${key} is fixed by the deploy (deploy/locked-settings.ts), so it can't be changed here: it stays ${JSON.stringify(this.locked[key])}.`,
      });
    let parsed: unknown;
    try {
      parsed = s.parse(value);
    } catch (e) {
      throw new ConfigError({ message: `${key} ${(e as Error).message}.` });
    }
    const check = Object.hasOwn(this.checks, key) ? this.checks[key] : undefined;
    if (check && parsed != null) parsed = await check(by, parsed);
    await this.write(key, JSON.stringify(parsed), by.login.toLowerCase(), by.via ?? null);
    this.rows = null;
    await this.tell(key);
    return this.entry(key);
  }

  /**
   * The server's own write, nobody's request: sets `key` to `value` only if
   * its row is still `expected` (its stored JSON as `stored` read it, null
   * for no row), so of several at once only one wins. Answers whether this
   * one did. Not for locked keys (the caller checks). `by`: who to record.
   */
  async claim(key: string, expected: string | null, value: unknown, by: string): Promise<boolean> {
    this.setting(key);
    const json = JSON.stringify(value);
    if (expected == null) {
      await this.sql.run("INSERT INTO server_config (key, value, updated, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (key) DO NOTHING", key, json, Date.now(), by.toLowerCase());
    } else {
      await this.sql.run("UPDATE server_config SET value = ?2, updated = ?3, updated_by = ?4 WHERE key = ?1 AND value = ?5", key, json, Date.now(), by.toLowerCase(), expected);
    }
    this.rows = null;
    const won = (await this.stored(key)) == json;
    // Only the winner records the change, from the row it replaced.
    if (won) {
      const recorded = this.version(Date.now(), by.toLowerCase(), this.change(key, expected, json));
      if (recorded.length) await this.sql.batch(recorded);
      await this.tell(key);
    }
    return won;
  }

  /** A setting's row as stored now (its JSON), read afresh; null if it has none. */
  async stored(key: string): Promise<string | null> {
    const [row] = await this.sql.all<Row>("SELECT * FROM server_config WHERE key = ?1", key);
    return row ? row.value : null;
  }

  /** Puts a setting back to its default. Admins only; a locked one can't be. */
  async reset(by: Actor, key: string): Promise<ConfigEntry> {
    await this.users.mustAdmin(by);
    this.setting(key);
    if (this.isLocked(key))
      throw new NotAllowed({
        message: `${key} is fixed by the deploy (deploy/locked-settings.ts), so it can't be changed here: it stays ${JSON.stringify(this.locked[key])}.`,
      });
    await this.write(key, null, by.login.toLowerCase(), by.via ?? null);
    this.rows = null;
    await this.tell(key);
    return this.entry(key);
  }

  /**
   * The settings' versions, newest first: who changed what, when, from what
   * to what. `before`: only those older than version n; `limit`: at most this
   * many (20 by default). `total`: how many there are. Admins only.
   */
  async history(by: Actor, opts: { before?: number; limit?: number } = {}): Promise<{ versions: SettingsVersion[]; total: number }> {
    await this.users.mustAdmin(by);
    const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 20), 1000));
    const [rows, [count]] = await Promise.all([
      this.sql.all<{ n: number; at: number; by: string; via?: string | null; changes: string }>(
        "SELECT * FROM server_config_versions WHERE n < ?1 ORDER BY n DESC LIMIT ?2", opts.before ?? Number.MAX_SAFE_INTEGER, limit),
      this.sql.all<{ total: number }>("SELECT COUNT(*) AS total FROM server_config_versions"),
    ]);
    const versions = rows.map((r) => {
      let changes: SettingChange[] = [];
      try { changes = JSON.parse(r.changes); } catch { /* a row nobody can read: no changes to show */ }
      // Before #69 a version's via was on its change.
      const via = r.via ?? changes.find((c) => c.via)?.via;
      return { n: Number(r.n), at: Number(r.at), by: r.by, ...(via ? { via } : {}), changes };
    });
    return { versions, total: Number(count?.total ?? 0) };
  }

  /**
   * The server's own record of something an admin did that isn't a setting
   * (a factory task added or merged, main moved to production): a version
   * with these changes, by `by` (a login, or SYSTEM), `via` how when not in
   * person. No check here: the caller made the change
   * already, as `by`.
   */
  async record(by: string, changes: SettingChange[], at = Date.now(), via: string | null = null): Promise<void> {
    if (!changes.length) return;
    await this.sql.run(
      "INSERT INTO server_config_versions (at, by, changes, via) VALUES (?1, ?2, ?3, ?4)",
      at,
      by.toLowerCase(),
      JSON.stringify(changes),
      via
    );
    // The open admin pages: the change log's new line, and the sign-in page's cards for a change to sign-in.
    await this.users.pagesChanged(changes.some((c) => c.signIn) ? ["auth:github", "auth:google"] : []);
  }

  /** A key's value as a row's JSON makes it (null: no row), as `entry` reads it: its default when there's none, or it won't parse. */
  private applied(key: string, json: string | null): unknown {
    const s = this.setting(key);
    if (json == null) return s.default;
    try { return s.parse(JSON.parse(json)); } catch { return s.default; }
  }

  /** What changes when key's row goes from `before` to `after` (JSON, null for no row); null when its value stays the same. */
  private change(key: string, before: string | null, after: string | null): SettingChange | null {
    const from = this.applied(key, before), to = this.applied(key, after);
    return JSON.stringify(from) === JSON.stringify(to) ? null : { key, from, to };
  }

  /** The statement that records a version of the settings with this change (none for no change). */
  private version(at: number, by: string, change: SettingChange | null): Statement[] {
    return change ? [["INSERT INTO server_config_versions (at, by, changes) VALUES (?1, ?2, ?3)", at, by, JSON.stringify([change])]] : [];
  }

  /**
   * Sets key's row to `json` (null: deletes it, back to its default), with
   * the version that says what changed, in one batch, only while the row is
   * still the one read: of two writes at once (a switch saved twice, two
   * admins), each version says truly what it changed, and none is recorded
   * twice. If another write came in between, it reads again and tries again.
   */
  private async write(key: string, json: string | null, by: string, via: string | null): Promise<void> {
    const once = async () => {
      const before = await this.stored(key), at = Date.now();
      const change = this.change(key, before, json);
      const still = "(SELECT value FROM server_config WHERE key = ?1) IS ?2";
      await this.sql.batch([
        ...(change ? [[`INSERT INTO server_config_versions (at, by, changes, via) SELECT ?3, ?4, ?5, ?6 WHERE ${still}`, key, before, at, by, JSON.stringify([json == null ? { ...change, reset: true } : change]), via] as Statement] : []),
        json == null
          ? ["DELETE FROM server_config WHERE key = ?1 AND value IS ?2", key, before]
          : [`INSERT INTO server_config (key, value, updated, updated_by, updated_via) SELECT ?1, ?3, ?4, ?5, ?6 WHERE ${still}
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = excluded.updated, updated_by = excluded.updated_by, updated_via = excluded.updated_via`, key, before, json, at, by, via],
      ]);
      if ((await this.stored(key)) !== json) throw new Interleaved();
    };
    // Another write came in between: read again and try again, five times in all.
    await Effect.runPromise(
      Effect.tryPromise({ try: once, catch: (e) => e }).pipe(
        Effect.retry({ times: 4, while: (e) => e instanceof Interleaved }),
        Effect.mapError((e) =>
          e instanceof Interleaved ? new ConfigError({ message: `${key} is changing too often at once to save: try again.` }) : e
        )
      )
    );
  }

  private setting(key: string): Setting {
    const s = Object.hasOwn(this.settings, key) ? this.settings[key] : undefined;
    if (!s)
      throw new ConfigError({ message: `There's no setting "${key}". The settings are: ${Object.keys(this.settings).sort().join(", ")}.` });
    return s;
  }

  /** Forgets the table remembered: the next read is the database's (an open page asks for a row that just changed elsewhere). */
  forget(): void {
    this.rows = null;
  }

  /** The table, remembered for a few seconds (it's small, and read on ordinary requests). */
  private async table(): Promise<Map<string, Row>> {
    if (this.rows && Date.now() - this.rows.at < REMEMBER_MS) return this.rows.byKey;
    const byKey = new Map((await this.sql.all<Row>("SELECT * FROM server_config")).map((r) => [r.key, r]));
    this.rows = { at: Date.now(), byKey };
    return byKey;
  }
}
