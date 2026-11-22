// The deployer's token (worker.ts). No install gives the deployer a token: a person makes one for the instance's
// Worker and the deployer's and pastes it on the instance (a new server's /setup, later /admin/deploy). The instance keeps nothing
// of it: it hands the token to the deployer's fetch handler, over its service binding DEPLOYER (`answer`, below). The
// deployer checks the token with Cloudflare, seals it under its own secret (KEY) and keeps it in its own store. Each
// run opens it from there. A new token takes the same way, and takes the old one's place.
//
// The check, with reads only. First: does Cloudflare know the token (its verify, for an account's token and then for
// a user's)? Only that answer says so: to a read of a Worker, Cloudflare answers 401 [code 10000] both to a token that
// it does not know and to one that it knows, which may not read that Worker. Then the token must read the instance's
// Worker, and two reads that it must not be able to make must fail: the account's D1 databases, and another Worker
// that the token lists. A token that can do more than the deployer needs is refused: it would stay in the cloud.
//
// The token is for two Workers: the instance's, and the deployer's own, so that the deployer gives itself the code of
// each release that it deploys (worker.ts, renew). A token for the instance's Worker only is taken too: the deployer
// then deploys the instance, and its own code changes only with setup, or with a deploy from a machine.
//
// Plain TypeScript, as worker.ts: no Effect.
//
// Trap: the check proves little. A token can't read its own permissions, and a check makes no change. What the token
// may write, and each permission that no read here tries, stays unknown: the first deploy shows whether it may deploy.
// Trap: nothing here answers the token, or logs it.

import type { Renewed, Store } from "./store";
import { deployerName } from "./worker-form";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * What the deployer answers its instance: whether it holds a token, the head of the branch at its last look, the
 * release that its own code is of, and how the last update of that code went; or why a token is not taken.
 */
export type DeployerAnswer =
  | { ok: true; ready: boolean; head: string | null; version: string; renewed: Renewed | null }
  | { ok: false; why: string };

/** Why the token is not taken, or null. */
export async function tokenProblem(fetch: Fetch, env: { ACCOUNT: string; WORKER: string }, token: string): Promise<string | null> {
  if (!/^[\x21-\x7e]{16,400}$/.test(token)) return token ? "That isn't a token: it is one line, with no spaces." : "Paste the token.";
  const get = (path: string) =>
    fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
  /** Cloudflare's status for one read of the account with the token; 0: no answer. */
  const status = async (path: string) => (await get(`/accounts/${env.ACCOUNT}${path}`))?.status ?? 0;
  /** Cloudflare's verify: its status, and with 200 what it says of the token (active, disabled, expired). */
  const verify = async (path: string) => {
    const r = await get(path);
    const body = r?.status == 200 ? ((await r.json().catch(() => null)) as { result?: { status?: unknown } } | null) : null;
    return { status: r?.status ?? 0, is: String(body?.result?.status ?? "") };
  };
  const unclear = (what: string, s: number) =>
    `Cloudflare gave no clear answer about ${what} (${s ? `it answered ${s}` : "no answer"}). Paste the token again in a minute.`;
  const no = (s: number) => s == 401 || s == 403 || s == 404;
  // An account's token verifies at its account, and a user's token at the user.
  let known = await verify(`/accounts/${env.ACCOUNT}/tokens/verify`);
  if (known.status != 200) {
    const user = await verify("/user/tokens/verify");
    if (user.status == 200 || known.status == 401) known = user;
  }
  if (known.status == 401)
    return `Cloudflare does not know this token: it is not whole, it was deleted, or it is a token of another account than ${env.ACCOUNT}.`;
  if (known.status != 200) return unclear("whether it knows the token", known.status);
  if (known.is != "active") return `Cloudflare knows this token, but it is ${known.is || "not active"}. Make a new one.`;
  const own = await status(`/workers/scripts/${env.WORKER}/settings`);
  if (own == 401 || own == 403)
    return `Cloudflare knows this token, but the token can't read the Worker ${env.WORKER} of the account ${env.ACCOUNT} (Cloudflare answered ${own}). Give it that Worker, with the role Editor.`;
  if (own != 200) return unclear(`whether the token reads the Worker ${env.WORKER}`, own);
  // (Cloudflare answers 401 for D1 to a token for one Worker: recorded 2026-11-20, with a real one.)
  const d1 = await status("/d1/database?per_page=1");
  if (d1 == 200) return "The token can read the account's D1 databases. The deployer needs no permission for D1: make a token without it.";
  if (!no(d1)) return unclear("whether the token reads the account's D1 databases", d1);
  // Another Worker: the first one that the token itself lists, which is not the instance's or its deployer. A token
  // that lists none is one for these Workers only.
  const mine = [env.WORKER, deployerName(env.WORKER)];
  const list = await get(`/accounts/${env.ACCOUNT}/workers/scripts`);
  if (list?.status != 200 && !no(list?.status ?? 0)) return unclear("whether the token lists the account's Workers", list?.status ?? 0);
  const scripts = list?.status == 200 ? ((await list.json().catch(() => null)) as { result?: { id?: unknown }[] } | null)?.result : null;
  const other = scripts
    ?.map((x) => x.id)
    .find((id): id is string => typeof id == "string" && /^[\w-]{1,63}$/.test(id) && !mine.includes(id));
  const reaches = other ? await status(`/workers/scripts/${other}/settings`) : 404;
  if (reaches == 200) return `The token can read another Worker (${other}). Make a token for the Workers ${mine.join(" and ")} only.`;
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
  io: { fetch: Fetch; version: string },
  env: { ACCOUNT: string; WORKER: string; KEY: string },
  store: Pick<Store, "says">
): Promise<Response> {
  let token: string | undefined;
  if (request.method == "POST") {
    const why = await tokenProblem(io.fetch, env, (token = (await request.text()).trim()));
    if (why) return Response.json({ ok: false, why } satisfies DeployerAnswer);
  }
  const at = await store.says(token ? { token: await seal(env.KEY, token) } : {});
  return Response.json({ ok: true, ready: !!at.token, head: at.head, version: io.version, renewed: at.renewed } satisfies DeployerAnswer);
}
