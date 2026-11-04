// Where your own Erga's settings and secrets are on this machine: .erga/ in the checkout, which git ignores.
//
//   .erga/own.json        the person's answers, the account, the sign-in apps' public ids (no secret)
//   .erga/secrets.json    mode 600: each server's SESSION_SECRET and FACTORY_KEY, the sign-in apps' secrets, the
//                         agent's admin tokens. Never printed: `bun own status` names the keys only.
//   .erga/inbox.jsonl     the checklist page's conversation: the person's messages and the agent's answers
//
// A person who loses .erga/ keeps a working server: the secrets stay on the Workers. Only `bun own token` and a new
// server need them; keep a copy of secrets.json in a password manager.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Answers, defaultAnswers, type TargetName } from "./plan";

export const ROOT = new URL("../..", import.meta.url).pathname;
export const DIR = join(ROOT, ".erga");

export interface Own {
  answers: Answers | null;
  account: string | null;
  /** The sign-in apps' public values. */
  github: { clientId: string; slug?: string; url?: string } | null;
  google: { clientId: string } | null;
}

export interface Secrets {
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Each server's own: made at random before its first deploy. */
  servers?: Partial<Record<TargetName, { SESSION_SECRET: string; FACTORY_KEY: string }>>;
  /** The agent's admin token on each server (bun own token). */
  tokens?: Partial<Record<TargetName, string>>;
}

const read = <T>(name: string, empty: T): T => {
  try {
    return { ...empty, ...JSON.parse(readFileSync(join(DIR, name), "utf8")) };
  } catch {
    return empty;
  }
};
const write = (name: string, value: unknown, secret = false) => {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const path = join(DIR, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(path, 0o600);
};

export const loadOwn = (): Own => read<Own>("own.json", { answers: null, account: null, github: null, google: null });
export const saveOwn = (o: Own) => write("own.json", o);
export const loadSecrets = (): Secrets => read<Secrets>("secrets.json", {});
export const saveSecrets = (s: Secrets) => write("secrets.json", s, true);
export const answersOf = (o: Own, admin = ""): Answers => ({ ...defaultAnswers(admin), ...(o.answers ?? {}) });

/** The names of the secrets the file holds, for status: never their values. */
export function secretNames(s: Secrets): string[] {
  const out: string[] = (["GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"] as const).filter((k) => !!s[k]?.trim());
  for (const [t, v] of Object.entries(s.servers ?? {})) if (v?.SESSION_SECRET) out.push(`${t}:SESSION_SECRET`, `${t}:FACTORY_KEY`);
  for (const [t, v] of Object.entries(s.tokens ?? {})) if (v) out.push(`${t}:token`);
  return out;
}

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
