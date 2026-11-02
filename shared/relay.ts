// The relay of an install's consent through erga.dev: the state an install's
// Worker starts a consent with (its origin and a nonce), and what erga.dev's
// callback relays back to it, sealed under the nonce. erga.dev's control
// Worker relays (control/github-routes.ts); an install's sign-in and Connect GitHub
// read the answer (server/identity/sign-in.ts, control/github-routes.ts).

import { base64url, fromBase64url, randomBytes, sha256 } from "./bytes";

const enc = new TextEncoder();

/**
 * A state for a consent an install's Worker starts: its origin (base64url), a dot, a random nonce. erga.dev's callback
 * reads the origin and relays the answer there; the nonce (in the install's cookie, never sent on) opens what it relays.
 */
export const relayState = (origin: string, nonce: string) => `${base64url(enc.encode(origin))}.${nonce}`;
export function relayOrigin(state: string | null): string | null {
  const [head, rest] = (state ?? "").split(".");
  if (!head || !rest) return null;
  try {
    const origin = new TextDecoder().decode(fromBase64url(head));
    return /^https:\/\/[a-z0-9.-]+$/i.test(origin) ? origin : null;
  } catch { return null; }
}
export const relayNonce = (state: string) => state.split(".")[1] ?? "";

const relayKey = async (nonce: string) =>
  crypto.subtle.importKey("raw", await sha256(`erga-github-relay:${nonce}`), "AES-GCM", false, ["encrypt", "decrypt"]);

/** What erga.dev relays to an install (the person's token, GitHub's answer), sealed under the consent's nonce: only the browser that started it (its cookie) and the install's Worker open it. */
export async function sealRelay(nonce: string, payload: object): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await relayKey(nonce), enc.encode(JSON.stringify(payload))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return base64url(out);
}
export async function openRelay<T extends object>(nonce: string, sealed: string): Promise<T | null> {
  try {
    const bytes = fromBase64url(sealed);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, await relayKey(nonce), bytes.subarray(12));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch { return null; }
}
