// A server's deployer, as one value: where it is now. The Deploy page (server/admin/deploy.ts), its script
// (client/inline/admin-deploy.ts) and the operations (server/operations/deploys.ts) decide with this value, and say
// what it is with the words here. So the Auto-deploy row, the buttons and the token's section never say two things.
//
// The value comes from two facts (deployerOf): whether a deployer looked at GitHub lately (the instance's database),
// and what the deployer says of its token and of its own code (its own answer). The deployer's status (`status`) is
// that value in a person's words, line by line: the page's section "The deployer", and the read of the operation.

import { timeAgo } from "./time.ts";

export type AutoMode = "off" | "releases" | "commits";

/** The last time that a deployer gave itself a release's deployer code (deploy/deployer/store.ts): `why` null: done; else why it kept its code. */
export interface Renewed {
  at: number;
  version: string;
  why: string | null;
}
/** What a deployer says of its own code: the release that it is of, and its last update of it. None of both: a deployer from before it said so. */
export interface Code {
  version?: string;
  renewed?: Renewed | null;
}

export type Deployer =
  /** No deployer in the cloud: the server's deploys come from a machine. */
  (
    | { at: "none" }
    /** It holds no token: it deploys nothing, until a person gives it one. */
    | { at: "waits" }
    /** It is there, and it does not look at GitHub: it deploys nothing now. */
    | { at: "away" }
    /** It looks, and it gave no answer about its token: `why`. Nothing says that it can't deploy. */
    | { at: "silent"; why: string }
    /** It deploys: it holds its token, or it needs none. `head`: the branch's head at its last look, where it said. */
    | { at: "ready"; head: string | null }
  ) & {
    /** What it says of its own code, when it answered. */
    code?: Code;
  };
export type DeployerAt = Deployer["at"];

/** What a deployer says of its token and of its code (server/platform.ts, DeployerSays). */
type Says = ({ ok: true; ready: boolean; head: string | null } & Code) | { ok: false; why: string };

/**
 * The deployer's state. `looked`: a deployer looked at GitHub lately. `says`: its answer about its token; null: the
 * server has no deployer to ask (a machine deploys it, or a deployer that needs no token does: AWS's).
 */
export function deployerOf(looked: boolean, says: Says | null): Deployer {
  if (!says) return looked ? { at: "ready", head: null } : { at: "none" };
  if (!says.ok) return looked ? { at: "silent", why: says.why } : { at: "away" };
  const code: Code = { ...(says.version ? { version: says.version } : {}), ...(says.renewed ? { renewed: says.renewed } : {}) };
  return { ...(!says.ready ? { at: "waits" } : looked ? { at: "ready", head: says.head } : { at: "away" }), code };
}

/** Whether an ask reaches a deployer that deploys. Only then are the page's controls on. */
export const deploys = (at: DeployerAt) => at == "ready" || at == "silent";

export const NO_TOKEN = "No token set.";
export const AWAY = "Deployer hasn't checked GitHub recently.";

/** What a server with no deployer says. */
export const noDeployer = (host: string) => `No cloud deployer for ${host}. Deploy from a machine with bun erga deploy ${host}.`;

/** Why no ask goes to the deployer now, or null: the tip of a button that is off, and what the operation answers. */
export const blocked = (at: DeployerAt, host: string): string | null =>
  at == "none" ? noDeployer(host) : at == "waits" ? "Deployer has no token. Add one on /admin/deploy." : at == "away" ? AWAY : null;

const each = (mode: AutoMode, branch: string) =>
  mode == "releases" ? "tagged releases (vX.Y.Z) of the repository" : `every commit on ${branch}`;

/** The Auto-deploy row's words: what the saved mode does, or what the deployer waits for, and what the mode does then. */
export function autoText(at: DeployerAt, mode: AutoMode, branch: string): string {
  if (deploys(at)) return mode == "off" ? "Manual only." : `Deploys ${each(mode, branch)}.`;
  const why = at == "waits" ? "Add a token below." : "Deployer offline.";
  if (mode == "off") return `${why} Manual only.`;
  return at == "waits" ? `${why} Will deploy ${each(mode, branch)}.` : `${why} Will deploy ${each(mode, branch)} when back.`;
}

/** The token section's words about the saved mode: what the deployer does with its token, or will do with one. */
export function tokenText(at: DeployerAt, mode: AutoMode, branch: string): string {
  if (at != "ready" && at != "waits") return "";
  if (mode == "off") return "Auto-deploy is off.";
  return at == "waits" ? `Once set, auto-deploys ${each(mode, branch)}.` : `Auto-deploys ${each(mode, branch)}.`;
}

/** One line of the deployer's status. `bad`: it says that something is wrong. */
export interface StatusLine {
  key: "state" | "look" | "code" | "update";
  label: string;
  text: string;
  bad?: boolean;
}

const STATES: Record<Exclude<DeployerAt, "none">, string> = {
  ready: "Ready",
  waits: "Waiting for token",
  silent: "No response:",
  away: "Offline (not checking GitHub)",
};

/**
 * The status of a deployer in the cloud, line by line: its state, its last look, the release that its own code is of
 * beside the server's, and how its last update of that code went, with the reason. `looked`: its last look at GitHub,
 * however old (null: none), and `error`: what that look said. `runs`: the release that the server runs.
 */
export function status(
  d: Exclude<Deployer, { at: "none" }>,
  o: { looked: number | null; error: string | null; runs: string | null; now: number }
): StatusLine[] {
  // (A line starts with a capital: "Just now", "3 hours ago ...".)
  const ago = (at: number) => timeAgo(at, o.now).replace(/^./, (c) => c.toUpperCase());
  const lines: StatusLine[] = [
    {
      key: "state",
      label: "Status",
      text: d.at == "silent" ? `${STATES.silent} ${d.why}` : STATES[d.at],
      ...(d.at == "ready" ? {} : { bad: true }),
    },
    {
      key: "look",
      label: "Last check",
      text: o.looked == null ? "Never" : `${ago(o.looked)}${o.error ? `: ${o.error}` : ""}`,
      ...(o.looked == null || o.error || d.at == "away" ? { bad: true } : {}),
    },
  ];
  // (A deployer that gave no answer, or one that needs no token: nothing says which code it runs.)
  if (!d.code) return lines;
  const { version, renewed } = d.code;
  const same = !!version && !!o.runs && (version.startsWith(o.runs) || o.runs.startsWith(version));
  lines.push({
    key: "code",
    label: "Version",
    text: !version
      ? "Unknown (updates on next deploy)"
      : same
        ? `${version} (matches server)`
        : `${version} (server runs ${o.runs ?? "unknown"})`,
    ...(version ? {} : { bad: true }),
  });
  if (!version) return lines;
  lines.push({
    key: "update",
    label: "Last self-update",
    text: !renewed
      ? "Never (installed manually)"
      : renewed.why
        ? `${ago(renewed.at)}, ${renewed.version} failed: ${renewed.why}`
        : renewed.version == version
          ? `${ago(renewed.at)} (${renewed.version})`
          : `${ago(renewed.at)} (requested ${renewed.version}; now on ${version})`,
    ...(renewed?.why ? { bad: true } : {}),
  });
  return lines;
}
