// A document's edit key: what the page's own editor shows to open the document's socket from the pages origin, where
// there are no cookies. The viewer (on the app's origin, signed in) asks for one (POST /<owner>/<slug>/api/key) and gives
// it to the page in its frame; the page opens /<owner>/<slug>/api/room?key=<key> with it (routes.ts). The key names the
// person and the one document, and holds for a short time: it is checked only when a socket opens, so the viewer gets a
// new one before it ends, for the next socket. It carries no admin power, and the document decides what the person may
// do (read or edit) as it does for any request: a share taken away holds for the next socket.

import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import type { Who } from "../directory/index.ts";
import { hmac, sameText } from "./pages-origin.ts";

/** How long a key holds, in seconds. */
export const KEY_SECONDS = 15 * 60;

/** The person a key names, as the document hears of them. */
export interface KeyPerson {
  login: string;
  name: string;
  avatar?: string;
  testBy?: string;
}

/** A key for `person` to open the socket of the document `id` (its owner `owner`), until `now` and KEY_SECONDS. */
export async function editKey(
  secret: string,
  owner: string,
  id: string,
  person: KeyPerson,
  now = Date.now()
): Promise<{ key: string; expires: number }> {
  const e = Math.floor(now / 1000) + KEY_SECONDS;
  const claims = Base64Url.encode(
    new TextEncoder().encode(
      JSON.stringify({
        d: `${owner.toLowerCase()}/${id}`,
        e,
        l: person.login.toLowerCase(),
        n: person.name,
        ...(person.avatar ? { a: person.avatar } : {}),
        ...(person.testBy ? { t: person.testBy.toLowerCase() } : {}),
      })
    )
  );
  // (Signed apart from a pages token: one is never the other.)
  return { key: `${claims}.${await hmac(secret, `key.${claims}`)}`, expires: e * 1000 };
}

/** The person a good, current key for this document names, or null. */
export async function readEditKey(secret: string, key: string, owner: string, id: string, now = Date.now()): Promise<KeyPerson | null> {
  const [claims, mac, extra] = key.split(".");
  if (!claims || !mac || extra != null || !sameText(mac, await hmac(secret, `key.${claims}`))) return null;
  try {
    const c = JSON.parse(Result.getOrThrow(Base64Url.decodeString(claims))) as Record<string, unknown>;
    if (c.d != `${owner.toLowerCase()}/${id}` || !(Number(c.e) > now / 1000) || typeof c.l != "string" || typeof c.n != "string")
      return null;
    return {
      login: c.l,
      name: c.n,
      ...(typeof c.a == "string" ? { avatar: c.a } : {}),
      ...(typeof c.t == "string" ? { testBy: c.t } : {}),
    };
  } catch {
    return null;
  }
}

/** Who a key's person is, to the document: this one document, and no admin power. */
export const keyWho = (person: KeyPerson, id: string): Who => ({
  login: person.login,
  test: !!person.testBy,
  ...(person.testBy ? { by: person.testBy } : {}),
  onlyDoc: id,
});
