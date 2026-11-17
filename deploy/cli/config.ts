// The instances this clone deploys: .erga/config.json in the main clone, which git ignores. An instance is a host that
// tracks one branch of one repository: `bun erga deploy <host>` deploys that branch's head. `bun erga register <host>`
// adds an instance with its deploy facts (GET /api/ops), its plain settings and its ops token; `bun erga track <host>`
// changes its repository and branch; `bun erga login <host>` gives it a new token. Each worktree of the clone uses the
// main clone's file. The file holds tokens: mode 600.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Schema from "effect/Schema";
import { AwsFacts, CloudflareFacts } from "./ops";
import { sh } from "../root";

/** The repository and the branch of an instance that names none. */
export const DEFAULT_REPO = "github.com/koomen/erga";
export const DEFAULT_BRANCH = "main";

const Own = {
  host: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
  token: Schema.String,
};
/**
 * One instance: its host (its address on Cloudflare; on AWS, its name in setup), the repository and the branch whose
 * commits it runs, its deploy facts and vars, and its ops token. On AWS, also the AWS CLI's profile this machine
 * reaches it with.
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
  const r = sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (!r.ok) throw new Error(`${cwd} is not in a git clone: ${r.err}`);
  return join(dirname(r.out), ".erga");
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

/** A repository's name from a git address: github.com/owner/name for an https, ssh or scp-like address; a path as it is. */
export const repoName = (url: string) =>
  url
    .trim()
    .replace(/^[a-z+]+:\/\/([^@/]+@)?/i, "")
    .replace(/^[^@/]+@([^:/]+):/, "$1/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

/** What git fetches for `repo`: https for the short form (host/owner/name), else the address as it is. */
export const repoUrl = (repo: string) => (/^[\w.-]+\.[a-z]{2,}(\/[\w.-]+){2}$/i.test(repo) ? `https://${repo}` : repo);

/** The clone's remote for `repo`: origin when origin is that repository (its own sign-in works), else the address. */
export function remoteOf(clone: string, repo: string): string {
  const origin = sh(["git", "remote", "get-url", "origin"], { cwd: clone });
  return origin.ok && repoName(origin.out) == repoName(repo) ? "origin" : repoUrl(repo);
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
