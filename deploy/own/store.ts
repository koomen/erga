// Where `bun erga setup` keeps its answers and the new servers' secrets on this machine: .erga/ in the main clone
// (deploy/cli/config.ts, ergaDir), which git ignores. Each worktree of the clone uses the same folder.
//
//   .erga/setup.json      the person's answers for the setup in progress, the account, the sign-in apps' public ids
//   .erga/secrets.json    mode 600: by host, the secrets `bun erga setup` gave that server's Worker one time
//                         (SESSION_SECRET, FACTORY_KEY, the sign-in apps' secrets, SNAPSHOT_TOKEN under a primary with
//                         a staging server), and the agent's admin token (ADMIN_TOKEN). Never printed: status names the
//                         keys only.
//   .erga/inbox.jsonl     the Setup tab's conversation: the person's messages and the agent's answers
//
// A person who loses .erga/ keeps a working server: the secrets stay on the Workers. Only `bun erga setup <host> token`
// and a new server need them; keep a copy of secrets.json in a password manager.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ergaDir } from "../cli/config";
import { type Answers, defaultAnswers } from "./plan";

export const ROOT = new URL("../..", import.meta.url).pathname;
export const DIR = ergaDir(ROOT);

export interface Own {
  answers: Answers | null;
  account: string | null;
  /** The sign-in apps' public values. */
  github: { clientId: string; slug?: string; url?: string } | null;
  google: { clientId: string } | null;
  /** AWS: each template file's SHA-256 when its change set was applied (a change on disk shows as not applied). */
  applied?: Record<string, string>;
}

/** By host: that server's secrets, by name. */
export type Secrets = Record<string, Record<string, string>>;

const read = <T>(name: string, empty: T, dir = DIR): T => {
  try {
    return { ...empty, ...JSON.parse(readFileSync(join(dir, name), "utf8")) };
  } catch {
    return empty;
  }
};
const write = (name: string, value: unknown, secret = false, dir = DIR) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(path, 0o600);
};

export const loadOwn = (): Own => read<Own>("setup.json", { answers: null, account: null, github: null, google: null });
export const saveOwn = (o: Own) => write("setup.json", o);
export const loadSecrets = (dir = DIR): Secrets => read<Secrets>("secrets.json", {}, dir);
export const saveSecrets = (s: Secrets, dir = DIR) => write("secrets.json", s, true, dir);
/** Sets one secret of `host` in the secrets file. */
export function putSecret(host: string, name: string, value: string, dir = DIR) {
  const s = loadSecrets(dir);
  s[host] = { ...s[host], [name]: value };
  saveSecrets(s, dir);
}
export const answersOf = (o: Own, admin = ""): Answers => ({ ...defaultAnswers(admin), ...(o.answers ?? {}) });

/** The names of the secrets the file holds, as host:NAME, for status: never their values. */
export const secretNames = (s: Secrets): string[] =>
  Object.entries(s).flatMap(([host, v]) =>
    Object.keys(v ?? {})
      .filter((k) => v[k]?.trim())
      .map((k) => `${host}:${k}`)
  );

/** Reads KEY=value lines (a .env file), for --from-file: the values go to secrets.json, never to the output. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`${path} isn't there.`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

// ------------------------------------------------------------------ the page's conversation

export interface Message {
  at: number;
  from: "person" | "agent";
  text: string;
}
const INBOX = join(DIR, "inbox.jsonl");

export function messages(): Message[] {
  try {
    return readFileSync(INBOX, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Message);
  } catch {
    return [];
  }
}
export function addMessage(from: Message["from"], text: string): Message {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const m: Message = { at: Date.now(), from, text: text.slice(0, 4000) };
  writeFileSync(INBOX, `${JSON.stringify(m)}\n`, { flag: "a" });
  return m;
}
