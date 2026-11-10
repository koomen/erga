// One helper signs every cookie, token and key the server hands out and trusts when it comes back. A kind is
// `signed(purpose, schema, seconds)`: `seal` makes the signed string, and `open` gives its value back only if the
// signature is this server's, for this purpose, the value has the schema's shape, and it has not expired.
//
//   <claims>.<mac>    claims: base64url of the JSON { v: the value, e: when it expires (seconds; none: never) }
//                     mac: HMAC-SHA256 of "<purpose>.<claims>", keyed with the server's secret
//
// The purpose is in what is signed: a string sealed as one kind never opens as another. `mac` is the one place that
// computes a signature; an agent token and an OAuth client id use it directly, with keys of their own, in the formats
// they always had (their strings are kept by agents and apps for a long time).

import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { sameText } from "../shared/bytes.ts";

/** The signing keys, imported once each (per isolate): every file of a document's page checks a token. */
const keys = new Map<string, Promise<CryptoKey>>();

/** HMAC-SHA256 of `value` under `key`, as base64url. */
export async function mac(key: string, value: string): Promise<string> {
  let imported = keys.get(key);
  if (!imported) {
    imported = crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    if (keys.size > 8) keys.clear();
    keys.set(key, imported);
  }
  return Base64Url.encode(new Uint8Array(await crypto.subtle.sign("HMAC", await imported, new TextEncoder().encode(value))));
}

/** Whether `given` is `value`'s signature under `key` (compared in constant time). */
export const macOk = async (key: string, value: string, given: string) => sameText(given, await mac(key, value));

export interface Signed<A> {
  /** The signed string for `value`. `seconds`: another lifetime than the kind's; `until`: the expiry itself (seconds since the epoch). */
  seal(secret: string, value: A, o?: { now?: number; seconds?: number; until?: number }): Promise<string>;
  /** The value, if `text` is good and current; else null. */
  open(secret: string, text: string | null | undefined, now?: number): Promise<A | null>;
  /** The same, and whether it has expired: for a caller that treats an expired one apart from a bad one. */
  read(secret: string, text: string | null | undefined, now?: number): Promise<{ value: A; expired: boolean } | null>;
}

const Claims = Schema.fromJsonString(Schema.Struct({ v: Schema.Unknown, e: Schema.optionalKey(Schema.Finite) }));
/** The key of every sealed kind: apart from the keys `mac`'s direct callers use. */
const keyOf = (secret: string) => `erga-signed:${secret}`;

/** A kind of signed string. `seconds`: how long one is good (null: it never expires). */
export function signed<S extends Schema.Top>(purpose: string, schema: S, seconds: number | null): Signed<S["Type"]> {
  const decode = Schema.decodeUnknownOption(schema as unknown as Schema.Codec<S["Type"]>);
  const read: Signed<S["Type"]>["read"] = async (secret, text, now = Date.now()) => {
    const [claims, given, extra] = (text ?? "").split(".");
    if (!claims || !given || extra != null || !(await macOk(keyOf(secret), `${purpose}.${claims}`, given))) return null;
    const json = Base64Url.decodeString(claims);
    const c = Result.isSuccess(json) ? Option.getOrNull(Schema.decodeUnknownOption(Claims)(json.success)) : null;
    if (!c || (seconds != null && c.e == null)) return null;
    const value = decode(c.v);
    return value._tag == "Some" ? { value: value.value, expired: c.e != null && !(c.e > now / 1000) } : null;
  };
  return {
    async seal(secret, value, o = {}) {
      const life = o.seconds ?? seconds;
      const e = o.until ?? (life == null ? undefined : Math.floor((o.now ?? Date.now()) / 1000) + life);
      const claims = Base64Url.encode(JSON.stringify(e == null ? { v: value } : { v: value, e }));
      return `${claims}.${await mac(keyOf(secret), `${purpose}.${claims}`)}`;
    },
    read,
    open: async (secret, text, now) => {
      const r = await read(secret, text, now);
      return r && !r.expired ? r.value : null;
    },
  };
}
