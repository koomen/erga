// Sealing the deploy page's Cloudflare token: AES-GCM,
// with a key the app makes from the browser's half (a cookie) and the
// server's SESSION_SECRET, so neither alone opens it.

import { base64url, fromBase64url, randomBytes } from "../../shared/bytes";

export interface Sealed { iv: string; data: string }

const aes = (key: string) => crypto.subtle.importKey("raw", fromBase64url(key), "AES-GCM", false, ["encrypt", "decrypt"]);

export async function seal(token: string, key: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(key), new TextEncoder().encode(token)));
  return { iv: base64url(iv), data: base64url(data) };
}
export async function open(sealed: Sealed, key: string): Promise<string> {
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(sealed.iv) }, await aes(key), fromBase64url(sealed.data))
  );
}
