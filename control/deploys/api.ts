// The deploys, as the Ops page and the agents reach them: the pipeline's object (control/deploys/branches.ts in
// control/deploys/pipeline-object.ts). Its calls are operations (control/deploys/operations.ts: POST /api/tools/<name>);
// what stays a route here is the event stream.
//
//   GET  /api/events                    admins: the events, over a WebSocket (Upgrade: websocket, as the Ops page asks), else
//                                       as server-sent events: {type: "deploys"} on each change, {type: "deploy-log", target,
//                                       deployId, lines} as a deploy's lines arrive, {type: "source"} on a push or merge
//
// The caller (the control Worker's gate, or the app's) has checked that it is an admin with admin power.

import type { CredentialStatus, TokenAnswer } from "./credential.ts";
import type { ReleasesView } from "./releases.ts";
import type { DomainNeed, DomainsView } from "./domains.ts";

/** This server's branch deploys, as the Ops page's operations ask them (control/deploys/operations.ts) (the pipeline's object answers, by RPC). */
export interface OpsDeploys {
  status(history?: number): Promise<object>;
  logOf(target: string, deploy?: string): Promise<object | null>;
  redeploy(name: string, trigger?: string): Promise<{ ok: boolean; status?: unknown; error?: string }>;
  redeployWith(name: string, trigger: string, o: { fresh?: boolean }): Promise<{ ok: boolean; status?: unknown; error?: string }>;
  /** Back to the Worker version before the target's live deploy (its restore point). */
  rollback(name: string, trigger?: string): Promise<{ ok: boolean; status?: unknown; error?: string }>;
  /** The release store (control/deploys/releases.ts): both channels (null: no store). */
  releases(): Promise<object | null>;
  /** Each environment's domains, and one added or removed (control/deploys/branches.ts). */
  domains(): Promise<object>;
  addDomain(target: string, hostname: string, by: string, o?: { replace?: boolean }): Promise<object>;
  removeDomain(target: string, hostname: string, by: string): Promise<object>;
  /** The control Worker's Cloudflare credential (control/deploys/credential.ts): its status, and revoked (the Ops page's card). */
  credentialStatus(): Promise<CredentialStatus>;
  disconnectCredential(): Promise<void>;
}

declare module "../../server/platform.ts" {
  interface Platform {
    /** The deploys: the pipeline's object (the control Worker's, over its binding, on erga.dev). */
    deploys: OpsDeploys;
  }
}

/** The pipeline's object, as the control routes need it: the operations' calls, a target's history, and the event stream. */
export interface DeploysObject extends OpsDeploys {
  historyOf(name: string, limit?: number): Promise<object[] | null>;
  /** The Cloudflare credential (control/deploys/credential.ts): its status; a consent's grant kept; forgotten (the control Worker's /install). */
  credentialStatus(): Promise<CredentialStatus>;
  connectCredential(answer: TokenAnswer, by: string): Promise<string>;
  disconnectCredential(): Promise<void>;
  /** Whether `origin` is the control Worker of an install made from here (control/deploys/pipeline-object.ts: the consent relay asks). */
  isInstall(origin: string): Promise<boolean>;
  /** The release store (control/deploys/releases.ts): both channels (null: no store). */
  releases(): Promise<ReleasesView | null>;
  /** Each environment's domains (its Worker's custom domains), and one added or removed (the operations deploys, view domains, and set_domain). */
  domains(): Promise<DomainsView | { error: string; status?: number }>;
  addDomain(
    target: string,
    hostname: string,
    by: string,
    o?: { replace?: boolean }
  ): Promise<DomainsView | { need: DomainNeed } | { error: string; status?: number }>;
  removeDomain(target: string, hostname: string, by: string): Promise<DomainsView | { error: string; status?: number }>;
  /** GET /api/events: the stream. */
  fetch(request: Request): Promise<Response>;
}

/** The event stream's address. */
export const isEventsPath = (path: string) => path == "/api/events";

/** GET /api/events: the stream, to the object as it came (a WebSocket's upgrade). */
export const deploysEvents = (request: Request, deploys: DeploysObject): Promise<Response> =>
  deploys.fetch(new Request(new URL(request.url), request));
