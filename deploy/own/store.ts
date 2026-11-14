// Where `bun erga setup` keeps the setup in progress and the new servers' secrets on this machine: .erga/ in the main
// clone (deploy/cli/config.ts, ergaDir), which git ignores. Each worktree of the clone uses the same folder.
//
//   .erga/setup.json      the setup in progress: the flow (the person's answers, what the command observed, the state:
//                         flow.ts), the GitHub App's public values, the build's parts. The command and the setup page
//                         both write it, and the ops page watches it: this file is how the two talk.
//   .erga/secrets.json    mode 600: by host, the secrets `bun erga setup` gave that server one time (SESSION_SECRET,
//                         FACTORY_KEY, the GitHub App's secret, SNAPSHOT_TOKEN under a primary with a staging
//                         instance). Never printed.
//
// A person who loses .erga/ keeps a working server: the secrets stay on the server. Keep a copy of secrets.json in a
// password manager.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entryOf, ergaDir, isAws, readConfig } from "../cli/config";
import { ROOT } from "../root";
import { type Effect, type Event, type Flow, nothingSeen, type Part, step } from "./flow";
import { namesOf, noAnswers } from "./plan";

export const DIR = ergaDir(ROOT);

/** The names of the instance at `host`: its entry's in .erga/config.json, or a new instance's from its address (plan.ts, namesOf). */
export function namesAt(host: string, dir = DIR) {
  const entry = entryOf(readConfig(dir), host);
  return namesOf(host, entry && !isAws(entry) ? entry : null);
}

export interface Setup {
  flow: Flow;
  /** The GitHub App that the person made from the page: its public values. */
  github: { clientId: string; slug?: string; url?: string } | null;
  /** The build's parts, as the command runs them, and why it stopped. */
  build: { parts: Part[]; failed: string };
  /** The code of the request for the ops token that waits for the admin: the page's link carries it. */
  approve: string;
  /** Why the page's last form was not taken. */
  problem: string;
  /** AWS: the plan (plan.ts, planKey) that the templates in .erga/aws/ were written for. */
  planned: string;
  /** AWS: each template file's SHA-256 when it was applied (a change on disk shows as not applied). */
  applied: Record<string, string>;
}

/** By host: that server's secrets, by name. */
export type Secrets = Record<string, Record<string, string>>;

const read = <T>(name: string, dir: string): T | null => {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
  } catch {
    return null;
  }
};
const write = (name: string, value: unknown, secret: boolean, dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(path, 0o600);
};

export const newSetup = (host: string): Setup => ({
  flow: { answers: noAnswers(host), seen: nothingSeen, state: { at: "where" } },
  github: null,
  build: { parts: [], failed: "" },
  approve: "",
  problem: "",
  planned: "",
  applied: {},
});

/** The setup in progress, or null: none, or a file from before this flow. */
export function loadSetup(dir = DIR): Setup | null {
  const s = read<Setup>("setup.json", dir);
  return s?.flow?.answers?.host ? s : null;
}
export const saveSetup = (s: Setup, dir = DIR) => write("setup.json", s, false, dir);
/** Changes the file as it is now: the command and the page both write it. */
export function updateSetup(change: (s: Setup) => Setup, dir = DIR): Setup | null {
  const s = loadSetup(dir);
  if (!s) return null;
  const next = change(s);
  // Only a change is written: the ops page and the command that waits both wake at each write.
  if (JSON.stringify(next) != JSON.stringify(s)) saveSetup(next, dir);
  return next;
}

/**
 * Sends events to the setup's flow, and keeps the result: the one place that steps it, for the command and the page.
 * The result: the effect of the last event, and why each answer that was not taken was not.
 */
export function stepSetup(events: Event[], dir = DIR): { setup: Setup; effect: Effect; problems: string[] } {
  const problems: string[] = [];
  let effect: Effect = { do: "done" };
  const setup = updateSetup((s) => {
    let flow = s.flow;
    for (const e of events) {
      const r = step(flow, e);
      flow = r.flow;
      effect = r.effect;
      if (r.problem) problems.push(r.problem);
    }
    return { ...s, flow };
  }, dir)!;
  return { setup, effect, problems };
}

export const loadSecrets = (dir = DIR): Secrets => read<Secrets>("secrets.json", dir) ?? {};
export const saveSecrets = (s: Secrets, dir = DIR) => write("secrets.json", s, true, dir);
/** Sets one secret of `host` in the secrets file. */
export function putSecret(host: string, name: string, value: string, dir = DIR) {
  const s = loadSecrets(dir);
  s[host] = { ...s[host], [name]: value };
  saveSecrets(s, dir);
}
