// The server's settings: key/value pairs in the server_config table
// (migrations/), each a JSON value, with who set it and when. Only the keys
// declared in SETTINGS exist: each has a description, a default (what it is
// until an admin sets it) and a parser that checks a value and says what's
// wrong with a bad one, for a person or an agent to act on.
//
// Reading a setting is for anyone (the server reads them to do its work);
// listing them and changing them is for admins (users.ts).
//
// A key can also be fixed by the deploy (server.config.ts, and
// ERGA_SERVER_CONFIG over it): then its deployed value wins over the table,
// and nobody can change it here (admin page, API or agent): it's `locked`,
// and shows its deployed value. A key the deploy leaves out is the admins'
// to set. To add a setting, add it to SETTINGS; nothing in the database
// changes.

import type { Sql } from "./directory.ts";
import { NotAllowed, type Actor, type Users } from "./users.ts";

/** A value a setting won't take; the message says why. */
export class ConfigError extends Error {}

export interface Setting<T = unknown> {
  /** What it does, for the admin (or agent) changing it. */
  description: string;
  /** Its value until it's set. */
  default: T;
  /** A value as given (parsed JSON), checked: throws a ConfigError saying what's wrong. */
  parse(value: unknown): T;
}

/** A whole number from `min` to `max`. */
export const integer = (min: number, max: number) => (v: unknown): number => {
  if (typeof v != "number" || !Number.isInteger(v) || v < min || v > max) throw new ConfigError(`must be a whole number from ${min} to ${max}`);
  return v;
};
/** A string of at most `max` characters (trimmed). */
export const text = (max: number) => (v: unknown): string => {
  if (typeof v != "string") throw new ConfigError("must be a string");
  if (v.trim().length > max) throw new ConfigError(`must be at most ${max} characters`);
  return v.trim();
};
/** Either null or what `inner` takes. */
export const nullable = <T>(inner: (v: unknown) => T) => (v: unknown): T | null => (v === null ? null : inner(v));
export const boolean = (v: unknown): boolean => {
  if (typeof v != "boolean") throw new ConfigError("must be true or false");
  return v;
};

const setting = <T>(s: Setting<T>) => s;

/** Every setting the server has. */
export const SETTINGS = {
  delete_docs_after_hours: setting<number | null>({
    description: "How many hours a new document lasts if nobody edits it, before it's deleted; never (null) keeps unedited documents for good.",
    default: 24,
    // null, or "never" (as an agent or a deploy might say it), is never.
    parse: (v) => {
      if (v === null || (typeof v == "string" && v.trim().toLowerCase() == "never")) return null;
      if (typeof v != "number" || !Number.isInteger(v) || v < 1 || v > 24 * 365) throw new ConfigError(`must be a whole number of hours from 1 to ${24 * 365}, or null for never`);
      return v;
    },
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
  /** The value the deploy fixes it to (only when it's locked; then it's `value` too). */
  deployed?: unknown;
  /** When it was last set, and by whom (null if it never was, or it's locked). */
  updated: number | null;
  updatedBy: string | null;
}

/**
 * The values a deploy fixes, checked against `settings`: each key must be
 * one there is, and each value one it takes. Throws a ConfigError saying
 * what's wrong. `bun server.config.ts` runs it on what the deploy fixes, so a
 * bad one fails the deploy (site.sh) or `bun start` (dev.ts), not the server.
 */
export function deployedSettings(values: Record<string, unknown>, settings: Settings = SETTINGS): Record<string, unknown> {
  if (!values || typeof values != "object" || Array.isArray(values)) throw new ConfigError("the deploy's server config must be an object of settings by key");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const s = Object.hasOwn(settings, key) ? settings[key] : undefined;
    if (!s) throw new ConfigError(`the deploy fixes "${key}", which isn't a setting (the settings are: ${Object.keys(settings).sort().join(", ")})`);
    try { out[key] = s.parse(value); } catch (e) { throw new ConfigError(`the deploy fixes ${key} to ${JSON.stringify(value)}, but it ${(e as Error).message}`); }
  }
  return out;
}

/**
 * The deploy's values as the Worker gets them: the SERVER_CONFIG binding, a
 * JSON object (cloudflare.config.ts makes it from server.config.ts and
 * ERGA_SERVER_CONFIG). Empty or missing: nothing is locked. A bad one
 * throws, as the server starts (but the deploy checks it first).
 */
export function parseDeployed(json: string | undefined, settings: Settings = SETTINGS): Record<string, unknown> {
  if (!json?.trim()) return {};
  let values: unknown;
  try { values = JSON.parse(json); } catch { throw new ConfigError(`the deploy's server config isn't JSON: ${json.slice(0, 200)}`); }
  return deployedSettings(values as Record<string, unknown>, settings);
}

interface Row { key: string; value: string; updated: number; updated_by: string | null }
const REMEMBER_MS = 10_000;

export class ServerConfig<S extends Settings = typeof SETTINGS> {
  readonly settings: S;
  private locked: Record<string, unknown>;
  private rows: { at: number; byKey: Map<string, Row> } | null = null;

  /**
   * `settings`: the keys there are (SETTINGS). `locked`: values fixed by the
   * deploy, by key; each must be a key there is, and a value it takes.
   */
  constructor(private sql: Sql, private users: Users, opts: { settings?: S; locked?: Record<string, unknown> } = {}) {
    this.settings = opts.settings ?? (SETTINGS as unknown as S);
    this.locked = deployedSettings(opts.locked ?? {}, this.settings);
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
    const base = { key, description: s.description, default: s.default };
    // The deploy's value wins; a row set before it was locked stays in the table, and counts again once it isn't.
    if (this.isLocked(key)) return { ...base, value: this.locked[key], source: "locked", locked: true, deployed: this.locked[key], updated: null, updatedBy: null };
    if (row) {
      try {
        return { ...base, value: s.parse(JSON.parse(row.value)), source: "set", locked: false, updated: Number(row.updated), updatedBy: row.updated_by };
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
    if (this.isLocked(key)) throw new NotAllowed(`${key} is fixed by the deploy (server.config.ts), so it can't be changed here: it stays ${JSON.stringify(this.locked[key])}.`);
    let parsed: unknown;
    try { parsed = s.parse(value); } catch (e) { throw new ConfigError(`${key} ${(e as Error).message}.`); }
    await this.sql.run(
      `INSERT INTO server_config (key, value, updated, updated_by) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (key) DO UPDATE SET value = ?2, updated = ?3, updated_by = ?4`,
      key, JSON.stringify(parsed), Date.now(), by.login.toLowerCase());
    this.rows = null;
    return this.entry(key);
  }

  /** Puts a setting back to its default. Admins only; a locked one can't be. */
  async reset(by: Actor, key: string): Promise<ConfigEntry> {
    await this.users.mustAdmin(by);
    this.setting(key);
    if (this.isLocked(key)) throw new NotAllowed(`${key} is fixed by the deploy (server.config.ts), so it can't be changed here: it stays ${JSON.stringify(this.locked[key])}.`);
    await this.sql.run("DELETE FROM server_config WHERE key = ?1", key);
    this.rows = null;
    return this.entry(key);
  }

  private setting(key: string): Setting {
    const s = Object.hasOwn(this.settings, key) ? this.settings[key] : undefined;
    if (!s) throw new ConfigError(`There's no setting "${key}". The settings are: ${Object.keys(this.settings).sort().join(", ")}.`);
    return s;
  }

  /** The table, remembered for a few seconds (it's small, and read on ordinary requests). */
  private async table(): Promise<Map<string, Row>> {
    if (this.rows && Date.now() - this.rows.at < REMEMBER_MS) return this.rows.byKey;
    const byKey = new Map((await this.sql.all<Row>("SELECT * FROM server_config")).map((r) => [r.key, r]));
    this.rows = { at: Date.now(), byKey };
    return byKey;
  }
}
