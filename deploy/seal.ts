// Sealing the deploy page's Cloudflare token (worker/deployer.ts): AES-GCM,
// with a key the front door makes from the browser's half (a cookie) and the
// server's SESSION_SECRET (worker/deploy.ts), so neither alone opens it.

export interface Sealed { iv: string; data: string }

const b64u = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const aes = (key: string) => crypto.subtle.importKey("raw", unb64u(key), "AES-GCM", false, ["encrypt", "decrypt"]);

/** A random secret: 32 bytes, base64url. */
export const randomSecret = () => b64u(crypto.getRandomValues(new Uint8Array(32)));

export async function seal(token: string, key: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(key), new TextEncoder().encode(token)));
  return { iv: b64u(iv), data: b64u(data) };
}
export async function open(sealed: Sealed, key: string): Promise<string> {
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(sealed.iv) }, await aes(key), unb64u(sealed.data)));
}
