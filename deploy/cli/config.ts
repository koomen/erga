// The instances this clone deploys: .erga/config.json in the main clone, which git ignores. `bun erga register <host>`
// adds an instance with its deploy facts (GET /api/ops), its plain settings and its ops token; `bun erga login <host>`
// gives it a new token. Each worktree of the clone uses the main clone's file. The file holds tokens: mode 600.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AwsFacts, CloudflareFacts } from "./ops";

const Own = {
  host: Schema.String,
  stagingOf: Schema.optionalKey(Schema.String),
  token: Schema.String,
};
/**
 * One instance: its host (its address on Cloudflare; on AWS, its name in setup), its primary if it is a staging
 * instance, its deploy facts and vars, and its ops token. On AWS, also the AWS CLI's profile this machine reaches it with.
 */
const Entry = Schema.Union([
  Schema.Struct({ ...Own, ...CloudflareFacts.fields }),
  Schema.Struct({ ...Own, ...AwsFacts.fields, profile: Schema.optionalKey(Schema.String) }),
]);
export type Entry = typeof Entry.Type;
export type CloudflareEntry = Extract<Entry, { worker: string }>;
export type AwsEntry = Extract<Entry, { aws: unknown }>;
export const isAws = (e: Entry): e is AwsEntry => "aws" in e;

/** Where an instance answers: its app's address. */
export const entryOrigin = (e: Entry) => (isAws(e) ? `https://${e.aws.app}` : originOf(e.host));

const ConfigFile = Schema.Struct({ instances: Schema.Array(Entry) });
export type Config = typeof ConfigFile.Type;

/** .erga/ in the main clone, from the clone or any of its worktrees: the folder above git's common directory. */
export function ergaDir(cwd = process.cwd()): string {
  const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode != 0) throw new Error(`${cwd} is not in a git clone: ${r.stderr.toString().trim()}`);
  return join(dirname(r.stdout.toString().trim()), ".erga");
}

export const configPath = (dir: string) => join(dir, "config.json");

/** The file's instances; none if there is no file yet. A file that doesn't parse is an error that names it. */
export function readConfig(dir: string): Config {
  const path = configPath(dir);
  if (!existsSync(path)) return { instances: [] };
  try {
    return Schema.decodeUnknownSync(ConfigFile)(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    throw new Error(`${path} is not a config file this CLI reads: ${(e as Error).message}`);
  }
}

export function writeConfig(dir: string, config: Config) {
  mkdirSync(dir, { recursive: true });
  const path = configPath(dir);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export const entryOf = (config: Config, host: string) => config.instances.find((e) => e.host == host) ?? null;

/** Why a staging instance of `primary` can't be registered as `host`, or null. */
export function stagingRefusal(config: Config, host: string, primary: string): string | null {
  if (primary == host) return `${host} can't be its own staging instance.`;
  const p = entryOf(config, primary);
  if (!p) return `${primary} has no entry in .erga/config.json. Register the primary first: bun erga register ${primary}`;
  if (p.stagingOf) return `${primary} is a staging instance of ${p.stagingOf}, not a primary.`;
  return null;
}

/** The config with `entry` in it: it replaces the entry of the same host, in its place. */
export function withEntry(config: Config, entry: Entry): Config {
  const i = config.instances.findIndex((e) => e.host == entry.host);
  return { instances: i < 0 ? [...config.instances, entry] : config.instances.map((e, j) => (j == i ? entry : e)) };
}

/** An instance's address from its host (a local server answers on http), or from a full URL. */
export function originOf(host: string): string {
  if (host.includes("://")) return new URL(host).origin;
  return /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? `http://${host}` : `https://${host}`;
}

export const secretsPath = (dir: string) => join(dir, "secrets.json");

const SnapshotSecret = Schema.Struct({ SNAPSHOT_TOKEN: Schema.String });

/**
 * A primary's SNAPSHOT_TOKEN, for a copy of its documents: SNAPSHOT_TOKEN in the environment, else
 * `{ "<primary host>": { "SNAPSHOT_TOKEN": "..." } }` in .erga/secrets.json. "" if neither has it.
 */
export function snapshotTokenOf(dir: string, primary: string): string {
  const own = process.env.SNAPSHOT_TOKEN?.trim();
  if (own) return own;
  const path = secretsPath(dir);
  if (!existsSync(path)) return "";
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return Option.getOrUndefined(Schema.decodeUnknownOption(SnapshotSecret)(file[primary]))?.SNAPSHOT_TOKEN.trim() ?? "";
}
