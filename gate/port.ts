// The gate's tools (core.ts, Port) on Web Crypto: a Worker's, Lambda@Edge's (Node), and the tests'.

import type { Port } from "./core.ts";

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const text = new TextEncoder();
/** The edge key, imported once for each isolate. */
const keys = new Map<string, Promise<CryptoKey>>();

export const webPort: Port = {
  async hmac(key, value) {
    let k = keys.get(key);
    if (!k) {
      if (keys.size > 4) keys.clear();
      keys.set(key, (k = crypto.subtle.importKey("raw", text.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])));
    }
    return b64(new Uint8Array(await crypto.subtle.sign("HMAC", await k, text.encode(value))));
  },
  sha256: async (value) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", text.encode(value)))),
  enc: (value) => b64(text.encode(value)),
  dec(value) {
    try {
      const s = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(s, (ch) => ch.charCodeAt(0)));
    } catch {
      return null;
    }
  },
};
