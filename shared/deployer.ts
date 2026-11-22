// A server's deployer, as one value: where it is now. The Deploy page (server/admin/deploy.ts), its script
// (client/inline/admin-deploy.ts) and the operations (server/operations/deploys.ts) decide with this value, and say
// what it is with the words here. So the Auto-deploy row, the buttons and the token's section never say two things.
//
// The value comes from two facts (deployerOf): whether a deployer looked at GitHub lately (the instance's database),
// and what the deployer says of its token (its own answer).

export type AutoMode = "off" | "releases" | "commits";

export type Deployer =
  /** No deployer in the cloud: the server's deploys come from a machine. */
  | { at: "none" }
  /** It holds no token: it deploys nothing, until a person gives it one. */
  | { at: "waits" }
  /** It is there, and it does not look at GitHub: it deploys nothing now. */
  | { at: "away" }
  /** It looks, and it gave no answer about its token: `why`. Nothing says that it can't deploy. */
  | { at: "silent"; why: string }
  /** It deploys: it holds its token, or it needs none. `head`: the branch's head at its last look, where it said. */
  | { at: "ready"; head: string | null };
export type DeployerAt = Deployer["at"];

/** What a deployer says of its token (server/platform.ts, DeployerSays). */
type Says = { ok: true; ready: boolean; head: string | null } | { ok: false; why: string };

/**
 * The deployer's state. `looked`: a deployer looked at GitHub lately. `says`: its answer about its token; null: the
 * server has no deployer to ask (a machine deploys it, or a deployer that needs no token does: AWS's).
 */
export const deployerOf = (looked: boolean, says: Says | null): Deployer =>
  !says
    ? looked
      ? { at: "ready", head: null }
      : { at: "none" }
    : says.ok && !says.ready
      ? { at: "waits" }
      : !looked
        ? { at: "away" }
        : says.ok
          ? { at: "ready", head: says.head }
          : { at: "silent", why: says.why };

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
