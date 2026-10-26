// A document's object, as the Worker (and the other objects) call it.
//
// Cloudflare moves a running Durable Object to new code only when the object
// restarts. An object that tabs keep busy can run the old code for minutes
// after a deploy, while the new Worker already asks it for what only the new
// code has (2026-10-19: "The RPC receiver does not implement the method
// view", 5 minutes of 500s on the documents open at the deploy).
//
// So each call carries the caller's deploy (ERGA_DEPLOYED: when the pipeline
// uploaded it, ms). An object from an older deploy runs nothing: it writes
// what it holds, answers STALE and stops (DocumentObject.call, and its fetch
// for the sockets and HTTP). The call goes again, to the object on the new
// code. Without ERGA_DEPLOYED (local development, the tests' servers) every
// deploy is 0 and nothing is ever stale.
//
// `call(deployed, method, args)` is the one method each version of the object
// shares with the next: keep its signature.

import type { DocumentObject } from "./document";
import type { Env } from "../env";

/** The header a fetch to a document carries the caller's deploy in. */
export const DEPLOYED_HEADER = "x-erga-deployed";
/** An object from an older deploy answers this, and stops: the caller asks again. */
export const STALE = "erga:stale-deploy";
/** How many times a call goes again to an object that answered STALE, and the wait before each (ms, times the try). */
const TRIES = 6, WAIT_MS = 50;

/** When this code's deploy was uploaded (ms), or 0: the pipeline sets ERGA_DEPLOYED. */
export const deployedOf = (env: { ERGA_DEPLOYED?: string }) => Number(env.ERGA_DEPLOYED) || 0;

/**
 * The object's side: whether a caller is from a newer deploy. The first such
 * caller starts `stop` (write what it holds, then restart); each such call
 * waits for it and runs nothing.
 */
export class DeployGate {
  private stopping: Promise<void> | null = null;
  constructor(private mine: number, private stop: () => Promise<void>) {}
  /** True: the caller (of deploy `theirs`) is newer, and the object stops. */
  async stale(theirs: number): Promise<boolean> {
    if (!(theirs > this.mine)) return false;
    await (this.stopping ??= this.stop());
    return true;
  }
}

/** What the Worker calls on a document: the object's methods it lists (DocumentObject's CALLS), and fetch. */
export const CALLS = [
  "create", "link", "publish", "paths", "index", "snapshot", "delete", "notify", "diskPath", "exists",
  "exportStorage", "importStorage", "wipeStorage", "versionsState", "restore", "currentFiles",
  "setPermissions", "view", "resumeAgent",
] as const;
export type Call = (typeof CALLS)[number];

export type DocumentHost = { [K in Call]: DocumentObject[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never } & {
  fetch(request: Request): Promise<Response>;
};

/** What a document's object takes: the one method, and fetch (a stub, or a test's stand-in). */
export interface DocumentStub {
  call(deployed: number, method: string, args: unknown[]): Promise<unknown>;
  fetch(request: Request): Promise<Response>;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The document `id`'s object, for code of this deploy. */
export const documentOf = (env: Pick<Env, "DOCUMENTS" | "ERGA_DEPLOYED">, id: string): DocumentHost =>
  documentHost(() => env.DOCUMENTS.getByName(id) as unknown as DocumentStub, deployedOf(env));

/**
 * A document's object, for a caller from deploy `deployed`. `stub` gives a
 * new stub each time: after an object stops, the next call needs a stub of
 * its own.
 */
export function documentHost(stub: () => DocumentStub, deployed: number): DocumentHost {
  const host = {} as Record<string, unknown>;
  for (const method of CALLS) {
    host[method] = async (...args: unknown[]) => {
      for (let i = 1; ; i++) {
        const answer = await stub().call(deployed, method, args);
        if (answer !== STALE) return answer;
        if (i == TRIES) throw new Error(`The document still runs the code before this deploy (${method})`);
        await pause(WAIT_MS * i);
      }
    };
  }
  host.fetch = async (request: Request) => {
    for (let i = 1; ; i++) {
      // A copy for each try but the last: a body is read once.
      const sent = new Request(i < TRIES ? request.clone() : request);
      sent.headers.set(DEPLOYED_HEADER, String(deployed));
      const response = await stub().fetch(sent);
      if (response.headers.get(DEPLOYED_HEADER) != STALE || i == TRIES) return response;
      await pause(WAIT_MS * i);
    }
  };
  return host as DocumentHost;
}

/** The answer of a fetch to an object from an older deploy: the caller asks again. */
export const staleResponse = () => new Response("This document is restarting for a new deploy.", { status: 503, headers: { [DEPLOYED_HEADER]: STALE, "Retry-After": "1" } });
