// The instances this clone deploys: .erga/config.json in the main clone, which git ignores. `bun erga register <host>`
// adds an instance with its deploy facts (GET /api/ops), its plain settings and its ops token; `bun erga login <host>`
// gives it a new token. Each worktree of the clone uses the main clone's file. The file holds tokens: mode 600.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Schema from "effect/Schema";
import { DeployFacts } from "./ops";

/** One instance: its host, its primary if it is a staging instance, its deploy facts and vars, and its ops token. */
const Entry = Schema.Struct({
  host: Schema.String,
  stagingOf: Schema.optionalKey(Schema.String),
  ...DeployFacts.fields,
  token: Schema.String,
});
export type Entry = typeof Entry.Type;

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
