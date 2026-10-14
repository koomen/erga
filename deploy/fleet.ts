// What a control Worker deploys: its fleet. erga.dev's control Worker
// deploys Erga's own targets (deploy/targets.json: production and staging,
// from their branches, and itself). An install's control Worker
// (deploy/install.ts) deploys two things in its own account: the app
// ("app") and itself ("control"), both from the releases erga.dev publishes
// (deploy/releases.ts), on the channel it follows: stable, unless its
// CHANNEL setting says edge. The branch deploys (deploy/branches.ts) ask the
// fleet which targets there are and how each is deployed, and nothing else
// about where they run.

import { INSTALL_CONTROL_WORKER, type InstallSpec } from "./install";
import { targetHost, type Target } from "./pipeline";
import type { Channel } from "./releases";
import { CONTROL, CONTROL_ENTRYPOINT, type DeployName } from "./targets";

/** The control Worker's settings a fleet needs. */
export interface FleetEnv { CLOUDFLARE_ACCOUNT_ID?: string; SNAPSHOT_TOKEN?: string }

/** One target, as the branch deploys see it: its name, what moves it (a branch, or the channel it follows), its Worker and address. */
export interface FleetSpec { name: DeployName; branch: string; worker: string; host: string; snapshotFrom?: string; control: boolean }

export interface Fleet {
  kind: "erga" | "install";
  names: DeployName[];
  has(name: string): name is DeployName;
  specOf(name: DeployName): FleetSpec;
  targetFor(name: DeployName, env: FleetEnv, fresh?: { force?: boolean }): Target;
  /** An install: where its releases come from, and which channel it follows. */
  upstream?: { origin: string; channel: Channel };
}

/** The settings an install's control Worker carries about itself (deploy/install.ts set them), which its upgrades send on. */
export interface InstallEnv extends FleetEnv {
  UPSTREAM?: string; INSTALL?: string; CHANNEL?: string;
  ADMINS?: string; APP_URL?: string; GITHUB_CLIENT_ID?: string; CLOUDFLARE_OAUTH_CLIENT_ID?: string;
}

/** An install's fleet from its settings, or null where this isn't an install (no INSTALL). */
export function installFleet(env: InstallEnv): Fleet | null {
  if (!env.INSTALL?.trim() || !env.UPSTREAM?.trim()) return null;
  let spec: InstallSpec;
  try { spec = JSON.parse(env.INSTALL) as InstallSpec; } catch { return null; }
  const upstream = env.UPSTREAM.trim().replace(/\/+$/, "");
  const channel: Channel = env.CHANNEL?.trim() == "edge" ? "edge" : "stable";
  const appHost = spec.app.kind == "domain" ? spec.app.hostname : `${spec.worker}.${spec.subdomain}.workers.dev`;
  const controlHost = spec.control.host;
  const base = (accountId: string): Pick<Target, "accountId" | "subdomain" | "keepSecrets" | "checkVersion"> => ({ accountId, ...(spec.subdomain ? { subdomain: spec.subdomain } : {}), keepSecrets: true, checkVersion: true });
  return {
    kind: "install",
    names: ["app", "control"],
    has: (name): name is DeployName => name == "app" || name == "control",
    specOf: (name) => (name == "control"
      ? { name, branch: channel, worker: spec.control.worker, host: controlHost, control: true }
      : { name: "app", branch: channel, worker: spec.worker, host: appHost, control: false }),
    targetFor: (name, e) => {
      const accountId = e.CLOUDFLARE_ACCOUNT_ID?.trim() || spec.accountId;
      // What the control Worker tells itself, sent again on each upgrade (a text setting goes with each upload).
      const controlVars = {
        ADMINS: env.ADMINS ?? "", CLOUDFLARE_ACCOUNT_ID: accountId, APP_URL: env.APP_URL ?? `https://${appHost}`, GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID ?? "",
        CLOUDFLARE_OAUTH_CLIENT_ID: env.CLOUDFLARE_OAUTH_CLIENT_ID ?? "", UPSTREAM: upstream, INSTALL: env.INSTALL!, ...(env.CHANNEL?.trim() ? { CHANNEL: env.CHANNEL.trim() } : {}),
      };
      if (name == "control") {
        return {
          ...base(accountId), label: "control", workerName: spec.control.worker, databaseName: spec.database,
          app: spec.app.kind == "domain" ? { kind: "domain", zoneId: spec.app.zoneId, zoneName: spec.app.zoneName, hostname: controlHost } : { kind: "workers.dev" },
          pages: { kind: "shared" }, vars: controlVars, secrets: {}, control: true, install: { vars: controlVars },
        };
      }
      return {
        ...base(accountId), label: "app", workerName: spec.worker, databaseName: spec.database, app: spec.app, pages: spec.pages,
        vars: { ADMINS: env.ADMINS ?? "", GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID ?? "", SERVER_CONFIG: "{}", CLOUDFLARE_OAUTH_CLIENT_ID: "", DEPLOY_TARGET: "", CONTROL_URL: `https://${controlHost}` },
        secrets: {}, services: { CONTROL: { service: INSTALL_CONTROL_WORKER, entrypoint: CONTROL_ENTRYPOINT } },
      };
    },
    upstream: { origin: upstream, channel },
  };
}

/** Where a target answers (its hostname), for the fleet's words. */
export const fleetHost = (t: Target) => targetHost(t);
export { CONTROL };
