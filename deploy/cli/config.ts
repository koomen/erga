// The instances this clone deploys: .erga/config.json in the main clone, which git ignores. An instance is a host that
// tracks one branch of one repository: `bun erga deploy <host>` deploys that branch's head. `bun erga setup <host>`
// writes a new instance's entry; `bun erga register <host>` adds an instance that runs already, with the deploy facts
// that its platform holds (running.ts); `bun erga track <host>` changes its repository and branch. Each worktree of the
// clone uses the main clone's file. The file holds no secret and no token: the platform's own login (Cloudflare's, AWS's)
// is the authority of every command.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as Schema from "effect/Schema";
import { sh } from "../root";

/** The app's address: its workers.dev address, or a hostname on one of the account's zones (deploy/pipeline/pipeline.ts, Target). */
const App = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("workers.dev") }),
  Schema.Struct({
    kind: Schema.Literal("domain"),
    zoneId: Schema.optionalKey(Schema.String),
    zoneName: Schema.String,
    hostname: Schema.String,
  }),
]);
/** Where documents' pages run: the shared workers.dev host, or a domain of their own (Target's pages). */
const Pages = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("shared") }),
  Schema.Struct({
    kind: Schema.Literal("zone"),
    zoneId: Schema.optionalKey(Schema.String),
    zoneName: Schema.String,
    domain: Schema.optionalKey(Schema.String),
  }),
]);

/**
 * Where a deploy finds an instance on Cloudflare: the pipeline's own names for it, and the Worker's plain settings as
 * the pipeline sent them (deploy/pipeline/account.ts, deployFacts). The Worker holds them too, in its binding
 * ERGA_DEPLOY: `bun erga register` reads them there, through Cloudflare's API.
 */
export const CloudflareFacts = Schema.Struct({
  account: Schema.String,
  worker: Schema.String,
  database: Schema.String,
  subdomain: Schema.optionalKey(Schema.String),
  app: App,
  pages: Pages,
  /** The custom domains registered for publishing (Target's domains). */
  domains: Schema.optionalKey(Schema.Array(Schema.String)),
  vars: Schema.Record(Schema.String, Schema.String),
});

/**
 * Where a deploy finds an instance on AWS: its stack and what the stack made (deploy/aws/deploy.ts, awsFacts), and the
 * Worker's plain settings.
 */
export const AwsFacts = Schema.Struct({
  aws: Schema.Struct({
    account: Schema.String,
    region: Schema.String,
    stack: Schema.String,
    bucket: Schema.String,
    machine: Schema.String,
    /** The app's host: its domain, or its CloudFront name. */
    app: Schema.String,
    /** Documents' pages: one shared CloudFront name, or an origin each under a domain. */
    pages: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("shared"), host: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("domain"), domain: Schema.String }),
    ]),
  }),
  vars: Schema.Record(Schema.String, Schema.String),
});
export type AwsFacts = typeof AwsFacts.Type;

/** The repository and the branch of an instance that names none. */
export const DEFAULT_REPO = "github.com/koomen/erga";
export const DEFAULT_BRANCH = "main";

const Own = {
  host: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
  upstream: Schema.optionalKey(Schema.Struct({ repo: Schema.String, branch: Schema.String })),
};
/**
 * One instance: its host (its address on Cloudflare; on AWS, its name in setup), the repository and the branch whose
 * commits it runs, and its deploy facts and vars. On AWS, also the AWS CLI's profile this machine reaches it with.
 * `upstream`: a repository and a branch that the ops page and `bun erga status` compare its branch with (observe.ts,
 * compare). Nothing else reads it: no deploy, and no command that moves a branch.
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

/**
 * The entry with the upstream that `bun erga track`'s options say: --upstream <branch> names a branch of the instance's
 * own repository, or of --upstream-repo <repo>; --no-upstream removes it; no option leaves it. Or why the options
 * don't fit.
 */
export function withUpstream(e: Entry, o: { upstream?: string; upstreamRepo?: string; noUpstream?: boolean }): Entry | string {
  if (o.noUpstream) {
    if (o.upstream || o.upstreamRepo) return "--no-upstream takes no --upstream and no --upstream-repo.";
    const { upstream: _, ...rest } = e;
    return rest;
  }
  if (!o.upstream) return o.upstreamRepo ? "--upstream-repo needs --upstream <branch>: the branch of that repository." : e;
  const upstream = { repo: o.upstreamRepo ? repoName(o.upstreamRepo) : e.repo, branch: o.upstream };
  if (upstream.repo == e.repo && upstream.branch == e.branch)
    return `${e.host} tracks ${e.repo} ${e.branch} itself: an upstream is another branch.`;
  return { ...e, upstream };
}

/** An instance's upstream in words: its branch, with its repository when that is another one. */
export const upstreamName = (e: Pick<Entry, "repo"> & { upstream: { repo: string; branch: string } }) =>
  e.upstream.repo == e.repo ? e.upstream.branch : `${e.upstream.repo} ${e.upstream.branch}`;

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
