// Sealing the deploy page's Cloudflare token: AES-GCM,
// with a key the app makes from the browser's half (a cookie) and the
// server's SESSION_SECRET, so neither alone opens it.

import * as Result from "effect/Result";
import { Base64Url } from "effect/encoding";
import { randomBytes } from "../../shared/bytes";

export interface Sealed { iv: string; data: string }

/** Base64url as bytes; it throws on text that isn't base64url (a cookie someone changed: it doesn't open). */
const bytesOf = (s: string) => Result.getOrThrow(Base64Url.decode(s)) as Uint8Array<ArrayBuffer>;

const aes = (key: string) => crypto.subtle.importKey("raw", bytesOf(key), "AES-GCM", false, ["encrypt", "decrypt"]);

export async function seal(token: string, key: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(key), new TextEncoder().encode(token)));
  return { iv: Base64Url.encode(iv), data: Base64Url.encode(data) };
}
export async function open(sealed: Sealed, key: string): Promise<string> {
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesOf(sealed.iv) }, await aes(key), bytesOf(sealed.data))
  );
}
