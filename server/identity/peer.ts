// Another of Erga's servers (production to staging, staging to production),
// proven by the secret they share (DEPLOY_HOOK_SECRET): branch moves, deploy
// status and sign-in settings pass between them with it.

import type { Platform } from "../platform.ts";

/** The request carries this server's shared secret, so it comes from the other of Erga's servers. */
export function isPeer(request: Request, platform: Pick<Platform, "deploy">): boolean {
  const secret = platform.deploy.hookSecret;
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (secret.length < 16 || bearer.length != secret.length) return false;
  let d = 0;
  for (let i = 0; i < secret.length; i++) d |= secret.charCodeAt(i) ^ bearer.charCodeAt(i);
  return d == 0;
}
