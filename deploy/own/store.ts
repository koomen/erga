// Where `bun erga setup` keeps the new servers' secrets on this machine: .erga/ in the main clone
// (deploy/cli/config.ts, ergaDir), which git ignores. Each worktree of the clone uses the same folder.
//
//   .erga/secrets.json    mode 600: by host, the secrets `bun erga setup` gave that server one time (SESSION_SECRET,
//                         FACTORY_KEY, the GitHub App's secret, SNAPSHOT_TOKEN under a primary with a staging
//                         instance), and the GitHub App's client id. Never printed.
//
// A person who loses .erga/ keeps a working server: the secrets stay on the server. Keep a copy of secrets.json in a
// password manager.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entryOf, ergaDir, isAws, readConfig } from "../cli/config";
import { ROOT } from "../root";
import { namesOf } from "./plan";

export const DIR = ergaDir(ROOT);

/** The names of the instance at `host`: its entry's in .erga/config.json, or a new instance's from its address (plan.ts, namesOf). */
export function namesAt(host: string, dir = DIR) {
  const entry = entryOf(readConfig(dir), host);
  return namesOf(host, entry && !isAws(entry) ? entry : null);
}

/** By host: that server's secrets, by name. */
export type Secrets = Record<string, Record<string, string>>;

export function loadSecrets(dir = DIR): Secrets {
  try {
    return JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")) as Secrets;
  } catch {
    return {};
  }
}
export function saveSecrets(s: Secrets, dir = DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "secrets.json");
  writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
/** Sets one secret of `host` in the secrets file. */
export function putSecret(host: string, name: string, value: string, dir = DIR) {
  const s = loadSecrets(dir);
  s[host] = { ...s[host], [name]: value };
  saveSecrets(s, dir);
}
/** The GitHub App's client id of `host`, as setup made it (or ""). */
export const githubIdOf = (host: string, dir = DIR) => loadSecrets(dir)[host]?.GITHUB_CLIENT_ID ?? "";
