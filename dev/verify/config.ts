// The verify suite's settings on this machine: .erga/verify.json in the main clone, which git ignores (as
// .erga/config.json, the instances). The code names no organization's domain or account: this file does. The zones in
// it are the suite's own, and hold nothing else. The accounts are the suite's own too (dedicated.ts refuses a run on
// any other), or they are `shared`: they hold other work, which the suite never touches (safe.ts). No value of the
// environment changes one of them.
//
//   {
//     "cloudflare": {
//       "account": "<32 hex digits>",        the Cloudflare account's ID
//       "shell": "verify-shell.example",     a zone of that account: the shells' hosts are s<n>.<shell>
//       "content": "verify-pages.example",   a zone of that account, on another site: other-site content is
//                                            <label>.c<n>.<content>
//       "team": "verify",                    that account's Zero Trust team: the part before .cloudflareaccess.com
//       "shared": true,                      the account holds other work too, and so does its team: the suite makes,
//                                            changes and deletes only what is named erga-verify-..., and only hosts
//                                            under the two zones
//       "login": "cf"                        the API token is the cf CLI's login on this machine (bunx cf auth login),
//                                            not the token's file
//     },
//     "aws": {
//       "profile": "verify",                 the AWS CLI's profile for the dedicated AWS account
//       "account": "123456789012",           that account's ID
//       "shell": "aws.verify-shell.example", a public Route 53 zone of that account: the apps are
//                                            erga-verify-<setting>.<shell>
//       "content": "aws.verify-pages.example", a public Route 53 zone of that account, on another site: the documents'
//                                            pages are <label>.<content>
//       "shared": true                       the account holds other work too: the suite makes, changes and deletes
//                                            only stacks named erga-verify-..., and what those stacks hold
//     },
//     "refuse": ["example.org"]              names that no test zone may be under (safe.ts)
//   }
//
// The Cloudflare API token is a secret, so it is not in that file: .erga/verify-cloudflare.token (one line, a file of
// this user's only), a token of the account with the permissions of a run only; or, with "login": "cf", the cf CLI's
// own login. It is never in a command's environment but wrangler's: each call takes it at its own time
// (dedicated.ts, tokenNow), and the suite's rule is asked before each call (safe.ts, apiProblem). This machine's other
// Cloudflare sign-ins are not used.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Config, isAws } from "../../deploy/cli/config.ts";
import { cfLogin } from "../../deploy/local-credential.ts";
import { zoneProblem } from "./safe.ts";

export interface Local {
  cloudflare: { account: string; shell: string; content: string; team: string; shared: boolean; login: "file" | "cf" };
  aws: { profile: string; account: string; shell: string; content: string; shared: boolean };
  refuse: string[];
  /** Each host of a registered instance: no test zone holds one. */
  instances: string[];
  /** Why the settings can't be used, or null. */
  problem: string | null;
}

export const localPath = (dir: string) => join(dir, "verify.json");
export const tokenPath = (dir: string) => join(dir, "verify-cloudflare.token");

/** Each host that an instance has: its own, its app's, its pages' domain, its custom domains. */
export const hostsOf = (config: Config): string[] =>
  config.instances.flatMap((e) =>
    isAws(e)
      ? [e.host, e.aws.app, e.aws.pages.kind == "domain" ? e.aws.pages.domain : e.aws.pages.host]
      : [
          e.host,
          ...(e.app.kind == "domain" ? [e.app.hostname] : []),
          ...(e.pages.kind == "zone" ? [e.pages.domain ?? e.pages.zoneName] : []),
          ...(e.domains ?? []),
        ]
  );

/** A host's site: its last two labels (the test zones' own names). */
export const siteOf = (host: string) => host.split(".").slice(-2).join(".");

/** The settings from the file's text (null: no file), with each name checked. Pure. */
export function localOf(text: string | null, instances: string[]): Local {
  let file: Record<string, unknown> = {};
  let unread = "";
  try {
    file = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch (e) {
    unread = `.erga/verify.json is not JSON: ${(e as Error).message}`;
  }
  const part = (name: string) => (file[name] && typeof file[name] == "object" ? (file[name] as Record<string, unknown>) : {});
  const s = (v: unknown) => (typeof v == "string" ? v.trim() : "");
  const [cf, aws] = [part("cloudflare"), part("aws")];
  const l: Local = {
    cloudflare: {
      account: s(cf.account).toLowerCase(),
      shell: s(cf.shell).toLowerCase(),
      content: s(cf.content).toLowerCase(),
      team: s(cf.team),
      shared: cf.shared === true,
      login: cf.login == "cf" ? "cf" : "file",
    },
    aws: {
      profile: s(aws.profile),
      account: s(aws.account),
      shell: s(aws.shell).toLowerCase(),
      content: s(aws.content).toLowerCase(),
      shared: aws.shared === true,
    },
    refuse: Array.isArray(file.refuse) ? file.refuse.map((r) => s(r).toLowerCase()).filter(Boolean) : [],
    instances,
    problem: null,
  };
  const c = l.cloudflare;
  const a = l.aws;
  const zones = [c.shell, c.content, a.shell, a.content].filter(Boolean);
  const oneSite = (x: string, y: string) => !!x && !!y && siteOf(x) == siteOf(y);
  l.problem =
    unread ||
    (!c.account || !c.shell || !c.content ? "The suite's Cloudflare account and its two test zones are not set." : null) ||
    (/^[0-9a-f]{32}$/.test(c.account) ? null : `${c.account} is not a Cloudflare account's ID (32 hex digits).`) ||
    ([cf.shared, aws.shared].some((v) => v != null && typeof v != "boolean") ? '"shared" is true or false.' : null) ||
    (cf.login != null && cf.login != "cf" ? '"login" is "cf" (the cf CLI\'s login), or it is not set (the token\'s file).' : null) ||
    (c.team && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(c.team) ? `${c.team} is not a Zero Trust team's name.` : null) ||
    (a.account && !/^\d{12}$/.test(a.account) ? `${a.account} is not an AWS account's ID (12 digits).` : null) ||
    (a.profile && !/^[\w.+@-]{1,64}$/.test(a.profile) ? `${a.profile} is not an AWS CLI profile's name.` : null) ||
    // (The deploy's code names no profile for "default": the CLI then takes whatever the environment has.)
    (a.profile == "default" ? 'The AWS profile is a profile of its own for the dedicated account, not "default".' : null) ||
    zones.map((z) => zoneProblem(z, l)).find(Boolean) ||
    (oneSite(c.shell, c.content) ? `${c.shell} and ${c.content} are on one site: the content's zone is on another site.` : null) ||
    (oneSite(a.shell, a.content) ? `${a.shell} and ${a.content} are on one site: the content's zone is on another site.` : null) ||
    null;
  return l;
}

/** This machine's settings: the file in `dir` (.erga/ of the main clone), and the registered instances. */
export function readLocal(dir: string, instances: string[]): Local {
  const path = localPath(dir);
  return localOf(existsSync(path) ? readFileSync(path, "utf8") : null, instances);
}

/**
 * The suite's Cloudflare API token, or why there is none. Never printed. The file must be this user's only. The cf
 * CLI's login (`"login": "cf"`) has the time of its end (ms): the CLI renews it after that time only.
 */
export function tokenOf(dir: string, l: Pick<Local, "cloudflare">): { token: string; expires?: number } | { why: string } {
  if (l.cloudflare.login == "cf")
    return cfLogin() ?? { why: 'The cf CLI is not signed in on this machine (the settings say: "login": "cf").' };
  const path = tokenPath(dir);
  if (!existsSync(path)) return { why: `No ${path}: the Cloudflare account's API token, on one line.` };
  if (statSync(path).mode & 0o077) return { why: `${path} is open to other users of this machine: chmod 600 ${path}` };
  const token = readFileSync(path, "utf8").trim();
  return token ? { token } : { why: `${path} is empty.` };
}

/**
 * The environment of the suite's commands: wrangler takes the suite's Cloudflare account from it, and the AWS CLI the
 * suite's profile. The token is not in it: each call takes it at its own time (dedicated.ts, tokenNow).
 */
export const dedicatedEnv = (l: Local): Record<string, string> => ({
  CLOUDFLARE_ACCOUNT_ID: l.cloudflare.account,
  ...(l.aws.profile ? { AWS_PROFILE: l.aws.profile } : {}),
});
