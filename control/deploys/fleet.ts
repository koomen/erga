// What a control Worker deploys: its fleet. erga.dev's control Worker
// deploys Erga's own targets (deploy/targets.json: production and staging,
// from their branches, and itself). An install's control Worker
// (control/install/install.ts) deploys the same three in its own account, from the
// branches of its own repository (a fork of erga.dev's, kept at erga.dev):
// production from main, staging from staging (a copy of production's data,
// as erga.dev's staging is), and itself from main after production. The
// branch deploys (control/deploys/branches.ts) ask the fleet which targets there are
// and how each is deployed, and nothing else about where they run.

import { INSTALL_CONTROL_WORKER, type InstallSpec } from "../install/install";
import type { Target } from "./pipeline";
import type { Channel } from "./releases";
import { CONTROL, CONTROL_ENTRYPOINT, type DeployName } from "../../deploy/targets";

/** The control Worker's settings a fleet needs. */
export interface FleetEnv { CLOUDFLARE_ACCOUNT_ID?: string; SNAPSHOT_TOKEN?: string }

/** One target, as the branch deploys see it: its name, the branch that moves it, its Worker and address. */
export interface FleetSpec { name: DeployName; branch: string; worker: string; host: string; snapshotFrom?: string; control: boolean }

export interface Fleet {
  kind: "erga" | "install";
  names: DeployName[];
  has(name: string): name is DeployName;
  specOf(name: DeployName): FleetSpec;
  targetFor(name: DeployName, env: FleetEnv, fresh?: { force?: boolean }): Target;
  /** An install: where upstream is (its releases, its fork's repository and builds), and which channel it follows. */
  upstream?: { origin: string; channel: Channel; fork: string | null };
}

/** The settings an install's control Worker carries about itself (control/install/install.ts set them), which its upgrades send on; and its secrets staging is given. */
export interface InstallEnv extends FleetEnv {
  UPSTREAM?: string; INSTALL?: string; CHANNEL?: string;
  ADMINS?: string; APP_URL?: string; GITHUB_APP_CLIENT_ID?: string; GITHUB_APP_SLUG?: string; CLOUDFLARE_OAUTH_CLIENT_ID?: string; GOOGLE_APP_CLIENT_ID?: string;
  SESSION_SECRET?: string;
}

/** An install's fleet from its settings, or null where this isn't an install (no INSTALL). */
export function installFleet(env: InstallEnv): Fleet | null {
  if (!env.INSTALL?.trim() || !env.UPSTREAM?.trim()) return null;
  let spec: InstallSpec;
  try { spec = JSON.parse(env.INSTALL) as InstallSpec; } catch { return null; }
  if (!spec.production || !spec.staging || !spec.control) return null;
  const upstream = env.UPSTREAM.trim().replace(/\/+$/, "");
  const channel: Channel = env.CHANNEL?.trim() == "edge" ? "edge" : "stable";
  const hostOf = (e: { worker: string; app: InstallSpec["production"]["app"] }) => (e.app.kind == "domain" ? e.app.hostname : `${e.worker}.${spec.subdomain}.workers.dev`);
  const hosts = { production: hostOf(spec.production), staging: hostOf(spec.staging), control: spec.control.host };
  const names: DeployName[] = ["production", "staging", "control"];
  const base = (accountId: string): Pick<Target, "accountId" | "subdomain" | "keepSecrets" | "checkVersion"> => ({ accountId, ...(spec.subdomain ? { subdomain: spec.subdomain } : {}), keepSecrets: true, checkVersion: true });
  const services = { CONTROL: { service: INSTALL_CONTROL_WORKER, entrypoint: CONTROL_ENTRYPOINT } };
  return {
    kind: "install",
    names,
    has: (name): name is DeployName => names.includes(name as DeployName),
    specOf: (name) => (name == "control"
      ? { name, branch: "main", worker: spec.control.worker, host: hosts.control, control: true }
      : name == "staging" ? { name, branch: "staging", worker: spec.staging.worker, host: hosts.staging, snapshotFrom: "production", control: false }
        : { name: "production", branch: "main", worker: spec.production.worker, host: hosts.production, control: false }),
    targetFor: (name, e, fresh) => {
      const accountId = e.CLOUDFLARE_ACCOUNT_ID?.trim() || spec.accountId;
      // What the control Worker tells itself, sent again on each upgrade (a text setting goes with each upload).
      const controlVars = {
        ADMINS: env.ADMINS ?? "", CLOUDFLARE_ACCOUNT_ID: accountId, APP_URL: env.APP_URL ?? `https://${hosts.production}`, GITHUB_APP_CLIENT_ID: env.GITHUB_APP_CLIENT_ID ?? "", GITHUB_APP_SLUG: env.GITHUB_APP_SLUG ?? "",
        ...(env.GOOGLE_APP_CLIENT_ID?.trim() ? { GOOGLE_APP_CLIENT_ID: env.GOOGLE_APP_CLIENT_ID.trim() } : {}),
        CLOUDFLARE_OAUTH_CLIENT_ID: env.CLOUDFLARE_OAUTH_CLIENT_ID ?? "", UPSTREAM: upstream, INSTALL: env.INSTALL!, ...(env.CHANNEL?.trim() ? { CHANNEL: env.CHANNEL.trim() } : {}),
      };
      if (name == "control") {
        return {
          ...base(accountId), label: "control", workerName: spec.control.worker, databaseName: spec.production.database,
          app: spec.production.app.kind == "domain" ? { kind: "domain", zoneId: spec.production.app.zoneId, zoneName: spec.production.app.zoneName, hostname: hosts.control } : { kind: "workers.dev" },
          pages: { kind: "shared" }, vars: controlVars, secrets: {}, control: true, install: { vars: controlVars },
        };
      }
      // Sign-in on the app Workers: Erga's GitHub App, through upstream's callback (the relay).
      const appVars = { ADMINS: env.ADMINS ?? "", GITHUB_CLIENT_ID: env.GITHUB_APP_CLIENT_ID ?? "", ...(env.GOOGLE_APP_CLIENT_ID?.trim() ? { GOOGLE_CLIENT_ID: env.GOOGLE_APP_CLIENT_ID.trim() } : {}), SIGN_IN_RELAY: upstream, SERVER_CONFIG: "{}", CLOUDFLARE_OAUTH_CLIENT_ID: "", CONTROL_URL: `https://${hosts.control}` };
      if (name == "staging") {
        // Staging's secrets go with each deploy (the install made none for it): its own session key, derived from the
        // control Worker's, and the token the copy of production's data goes through (sign-in needs no secret: the relay).
        const secrets = { ...(env.SESSION_SECRET ? { SESSION_SECRET: `${env.SESSION_SECRET}.staging` } : {}), ...(e.SNAPSHOT_TOKEN ? { SNAPSHOT_TOKEN: e.SNAPSHOT_TOKEN } : {}) };
        return {
          ...base(accountId), label: "staging", workerName: spec.staging.worker, databaseName: spec.staging.database, app: spec.staging.app, pages: spec.staging.pages,
          vars: { ...appVars, DEPLOY_TARGET: "staging", SNAPSHOT_IMPORT: "1" }, secrets, services,
          snapshot: { databaseName: spec.production.database, origin: `https://${hosts.production}`, token: e.SNAPSHOT_TOKEN?.trim() ?? "", ...(fresh?.force ? { fresh: true } : {}) },
        };
      }
      return {
        ...base(accountId), label: "production", workerName: spec.production.worker, databaseName: spec.production.database, app: spec.production.app, pages: spec.production.pages,
        vars: { ...appVars, DEPLOY_TARGET: "" }, secrets: {}, services,
      };
    },
    upstream: { origin: upstream, channel, fork: spec.fork ?? null },
  };
}

export { CONTROL };
