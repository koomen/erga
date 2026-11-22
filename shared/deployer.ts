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

export const NO_TOKEN = "The deployer has no token: it deploys nothing.";
export const AWAY = "The deployer does not look at GitHub now: it deploys nothing.";

/** What a server with no deployer says. */
export const noDeployer = (host: string) =>
  `No deployer in the cloud deploys ${host}: its deploys come from a machine (bun erga deploy ${host}).`;

/** Why no ask goes to the deployer now, or null: the tip of a button that is off, and what the operation answers. */
export const blocked = (at: DeployerAt, host: string): string | null =>
  at == "none"
    ? noDeployer(host)
    : at == "waits"
      ? `${NO_TOKEN} Give it one on the Deploy page (/admin/deploy), under "The deployer's token".`
      : at == "away"
        ? AWAY
        : null;

const each = (mode: AutoMode, branch: string) =>
  mode == "releases" ? `each new tagged release (vX.Y.Z) on ${branch}` : `each new commit on ${branch}`;

/** The Auto-deploy row's words: what the saved mode does, or what the deployer waits for, and what the mode does then. */
export function autoText(at: DeployerAt, mode: AutoMode, branch: string): string {
  const does = `deploys ${each(mode, branch)} by itself.`;
  if (deploys(at)) return mode == "off" ? "Auto-deploy is off. Use Deploy on a row below to deploy by hand." : `D${does.slice(1)}`;
  const [why, then] =
    at == "waits" ? ["Waits for a token: the deployer has none. Give it one below.", "Then it"] : [AWAY, "When it looks again, it"];
  return `${why} ${mode == "off" ? "Auto-deploy is off." : `${then} ${does}`}`;
}

/** The token section's words about the saved mode: what the deployer does with its token, or will do with one. */
export function tokenText(at: DeployerAt, mode: AutoMode, branch: string): string {
  if (at != "ready" && at != "waits") return "";
  const does =
    mode == "off" ? "it deploys only when you use Deploy on a row above: auto-deploy is off" : `it deploys ${each(mode, branch)} by itself`;
  return at == "waits" ? `With a token, ${does}.` : `${does[0].toUpperCase()}${does.slice(1)}.`;
}

/** One line of the deployer's status. `bad`: it says that something is wrong. */
export interface StatusLine {
  key: "state" | "look" | "code" | "update";
  label: string;
  text: string;
  bad?: boolean;
}

const STATES: Record<Exclude<DeployerAt, "none">, string> = {
  ready: "Ready: it looks at GitHub each minute, and it can deploy.",
  waits: "Waiting for a token: it looks at GitHub, and it deploys nothing.",
  silent: "Silent:",
  away: "Away: it does not look at GitHub now, and it deploys nothing.",
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
  // (A line starts with a capital: "Just now.", "3 hours ago, ...".)
  const ago = (at: number) => timeAgo(at, o.now).replace(/^./, (c) => c.toUpperCase());
  const lines: StatusLine[] = [
    {
      key: "state",
      label: "State",
      text: d.at == "silent" ? `${STATES.silent} ${d.why}` : STATES[d.at],
      ...(d.at == "ready" ? {} : { bad: true }),
    },
    {
      key: "look",
      label: "Last look",
      text: o.looked == null ? "None yet." : `${ago(o.looked)}${o.error ? `: ${o.error}` : "."}`,
      ...(o.looked == null || o.error || d.at == "away" ? { bad: true } : {}),
    },
  ];
  // (A deployer that gave no answer, or one that needs no token: nothing says which code it runs.)
  if (!d.code) return lines;
  const { version, renewed } = d.code;
  const same = !!version && !!o.runs && (version.startsWith(o.runs) || o.runs.startsWith(version));
  lines.push({
    key: "code",
    label: "Its code",
    text: !version
      ? "Not known: this deployer is from before it said its release. The next deploy gives it newer code."
      : same
        ? `Release ${version}, as this server.`
        : `Release ${version}. This server runs ${o.runs ?? "no release that it knows"}.`,
    ...(version ? {} : { bad: true }),
  });
  if (!version) return lines;
  lines.push({
    key: "update",
    label: "Last update of its code",
    text: !renewed
      ? "None by itself yet: its code came from the setup command, or from a deploy from a machine."
      : renewed.why
        ? `${ago(renewed.at)}, after its deploy of release ${renewed.version}: it kept its code. ${renewed.why}`
        : renewed.version == version
          ? `${ago(renewed.at)}, after its deploy of release ${renewed.version}: done.`
          : `${ago(renewed.at)}, it asked Cloudflare for the code of release ${renewed.version}. It runs release ${version} now.`,
    ...(renewed?.why ? { bad: true } : {}),
  });
  return lines;
}
