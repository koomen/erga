// Bytes as text and back (base64, base64url, hex), their SHA-256, and random tokens: Web Crypto, in the browser and
// in the Workers alike.

const utf8 = new TextEncoder();

type Native = { toBase64?: () => string };
const NativeArray = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> };

/** Bytes as base64, with its padding: natively where the runtime can (Bun, the Workers, new browsers). */
export function base64(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof (b as Native).toBase64 == "function") return (b as Native).toBase64!();
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Base64 (padded or not) as bytes, natively where the runtime can. Throws on a character that isn't base64. */
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  if (typeof NativeArray.fromBase64 == "function") return NativeArray.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes as base64url: "-" and "_" for "+" and "/", no padding. */
export const base64url = (bytes: Uint8Array | ArrayBuffer) => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Base64url as bytes. */
export const fromBase64url = (s: string) => fromBase64(s.replace(/-/g, "+").replace(/_/g, "/"));

/** Bytes as lowercase hex, two digits each. */
export const hex = (bytes: Uint8Array | ArrayBuffer) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** The SHA-256 of bytes, or of a string as UTF-8. */
export async function sha256(data: string | Uint8Array | ArrayBuffer): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", (typeof data == "string" ? utf8.encode(data) : data) as BufferSource));
}

/** The SHA-256 of bytes or a string, as hex. */
export const sha256Hex = async (data: string | Uint8Array | ArrayBuffer) => hex(await sha256(data));

/** `n` random bytes. */
export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** `n` random bytes as base64url: a nonce, a secret, a token. */
export const randomToken = (n = 32) => base64url(randomBytes(n));

/** `n` random characters of `alphabet`, one random byte each. */
export const randomString = (n: number, alphabet: string) => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
