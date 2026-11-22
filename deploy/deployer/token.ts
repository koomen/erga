// The deployer's token (worker.ts). No install gives the deployer a token: a person makes one for the instance's
// Worker only and pastes it on the instance (a new server's /setup, later /admin/deploy). The instance keeps nothing
// of it: it hands the token to the deployer's fetch handler, over its service binding DEPLOYER (`answer`, below). The
// deployer checks the token with Cloudflare, seals it under its own secret (KEY) and keeps it in its own store. Each
// run opens it from there. A new token takes the same way, and takes the old one's place.
//
// The check, with reads only: the token must read the instance's Worker, and two reads that it must not be able to
// make must fail: the account's D1 databases, and another Worker (the deployer itself, which is there). A token that
// can do more than the deployer needs is refused: it would stay in the cloud.
//
// Plain TypeScript, as worker.ts: no Effect.
//
// Trap: the check proves little. A token can't read its own permissions, and a check makes no change. What the token
// may write, and each permission that no read here tries, stays unknown: the first deploy shows whether it may deploy.
// Trap: nothing here answers the token, or logs it.

import { deployerName } from "./worker-form";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The part of the deployer's store that holds the token (worker.ts, Store): with `sealed`, it keeps that one. `head`: the last look's. */
export interface TokenStore {
  token(sealed?: string): Promise<{ token: string | null; head: string | null }>;
}

/** What the deployer answers its instance: whether it holds a token, and the head of the branch at its last look; or why a token is not taken. */
export type DeployerAnswer = { ok: true; ready: boolean; head: string | null } | { ok: false; why: string };

/** Why the token is not taken, or null. */
export async function tokenProblem(fetch: Fetch, env: { ACCOUNT: string; WORKER: string }, token: string): Promise<string | null> {
  if (!/^[\x21-\x7e]{16,400}$/.test(token)) return token ? "That isn't a token: it is one line, with no spaces." : "Paste the token.";
  /** Cloudflare's status for one read with the token; 0: no answer. */
  const status = (path: string) =>
    fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    }).then(
      (r) => r.status,
      () => 0
    );
  const unclear = (what: string, s: number) =>
    `Cloudflare gave no clear answer about ${what} (${s ? `it answered ${s}` : "no answer"}). Paste the token again in a minute.`;
  const no = (s: number) => s == 401 || s == 403 || s == 404;
  const own = await status(`/workers/scripts/${env.WORKER}/settings`);
  if (own == 401) return "Cloudflare does not know this token: it is not whole, it expired, or it is not a token of this account.";
  if (own == 403) return `The token can't read the Worker ${env.WORKER}. Give it that Worker, with the role Editor.`;
  if (own != 200) return unclear(`whether the token reads the Worker ${env.WORKER}`, own);
  // (Cloudflare answers 401 for D1 to a token for one Worker, which it knows: recorded 2026-11-20, with a real one.)
  const d1 = await status("/d1/database?per_page=1");
  if (d1 == 200) return "The token can read the account's D1 databases. The deployer needs no permission for D1: make a token without it.";
  if (!no(d1)) return unclear("whether the token reads the account's D1 databases", d1);
  const other = deployerName(env.WORKER);
  const reaches = await status(`/workers/scripts/${other}/settings`);
  if (reaches == 200) return `The token can read another Worker (${other}). Make a token for the Worker ${env.WORKER} only.`;
  if (!no(reaches)) return unclear(`whether the token reads another Worker (${other})`, reaches);
  return null;
}

const keyOf = async (key: string) =>
  crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
const text = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** The token as the store keeps it: AES-GCM under the deployer's own secret, with a new IV each time. */
export async function seal(key: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `${text(iv)}.${text(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(key), new TextEncoder().encode(token)))}`;
}

/** The token of the store's value; null: none, or it does not open under this secret. */
export async function open(key: string, sealed: string | null): Promise<string | null> {
  const [iv, data] = (sealed ?? "").split(".");
  if (!iv || !data) return null;
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv) }, await keyOf(key), bytes(data)).then(
    (plain) => new TextDecoder().decode(plain),
    () => null
  );
}

/**
 * The deployer's answer to its instance. A POST brings a token, as the request's text: checked, then kept. Any other
 * request asks only where the deployer is.
 */
export async function answer(
  request: Request,
  fetch: Fetch,
  env: { ACCOUNT: string; WORKER: string; KEY: string },
  store: TokenStore
): Promise<Response> {
  const say = (a: DeployerAnswer) => Response.json(a);
  if (request.method != "POST") {
    const at = await store.token();
    return say({ ok: true, ready: !!at.token, head: at.head });
  }
  const token = (await request.text()).trim();
  const why = await tokenProblem(fetch, env, token);
  if (why) return say({ ok: false, why });
  return say({ ok: true, ready: true, head: (await store.token(await seal(env.KEY, token))).head });
}
