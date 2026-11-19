// Cloudflare Access in front of the gate: Access signs each person in, and adds its proof to each request it lets
// through (Cf-Access-Jwt-Assertion, a JWT the team signs). The gate then needs no sign-in of its own: no callback, no
// state, no client secret and no shell cookie. This file is that proof's check, the one thing here the core can't do
// (RS256, and the team's keys from the network): a mount gives its result to the core as Req.access.
//
// A proof counts only when the team's key signed it, it is for this Access application (`aud`), and it has not ended.
// Trap: every application of a team has the team's signature. Without the check of `aud`, anyone with an Access
// application of the same team signs in here as anyone.
// The paths that Access lets through with no sign-in (an agent's, with its token; the vouch, in the frame) carry no
// proof: the gate checks its own values there, as everywhere.

import type { Identity } from "../core.ts";

export interface Access {
  /** The Zero Trust team's name: its keys are at https://<team>.cloudflareaccess.com. */
  team: string;
  /** The Access application's audience tag. */
  aud: string;
}

type Jwk = JsonWebKey & { kid?: string };
/** The team's keys, kept for an hour (they change rarely; a proof signed with a key not among them asks again, once a minute at most). */
const kept = new Map<string, { keys: Jwk[]; at: number }>();

async function keysOf(team: string, ask: typeof fetch, now: number, fresh: boolean): Promise<Jwk[]> {
  const had = kept.get(team);
  if (had && now - had.at < (fresh ? 60_000 : 3_600_000)) return had.keys;
  const answer = await ask(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`).catch(() => null);
  const body = answer?.ok ? ((await answer.json().catch(() => null)) as { keys?: Jwk[] } | null) : null;
  if (!body?.keys) return had?.keys ?? [];
  kept.set(team, { keys: body.keys, at: now });
  return body.keys;
}

const bytes = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
const json = (b64url: string) => JSON.parse(new TextDecoder().decode(bytes(b64url)));

/** The person of a request's Access proof (`e`: its end, seconds), or null. */
export async function accessOf(
  request: Request,
  o: Access,
  ask: typeof fetch = fetch,
  now = Date.now()
): Promise<(Identity & { e: number }) | null> {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt || jwt.length > 8192) return null;
  try {
    const [head, body, mac, more] = jwt.split(".");
    if (!head || !body || !mac || more != null) return null;
    const h = json(head);
    if (h.alg != "RS256" || typeof h.kid != "string") return null;
    let jwk = (await keysOf(o.team, ask, now, false)).find((k) => k.kid == h.kid);
    jwk ??= (await keysOf(o.team, ask, now, true)).find((k) => k.kid == h.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(mac), new TextEncoder().encode(`${head}.${body}`)))) return null;
    const c = json(body);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (c.iss !== `https://${o.team}.cloudflareaccess.com` || !aud.includes(o.aud)) return null;
    if (typeof c.exp != "number" || c.exp * 1000 <= now || typeof c.sub != "string" || !c.sub) return null;
    const email = typeof c.email == "string" ? c.email : "";
    return { p: "access", sub: c.sub, email, name: typeof c.name == "string" ? c.name : "", e: c.exp };
  } catch {
    return null;
  }
}
