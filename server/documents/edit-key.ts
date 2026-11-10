// A document's edit key: what the page's own editor shows to open the document's socket from the pages origin, where
// there are no cookies. The viewer (on the app's origin, signed in) asks for one (POST /<owner>/<slug>/api/key) and gives
// it to the page in its frame; the page opens /<owner>/<slug>/api/room?key=<key> with it (routes.ts). The key names the
// person and the one document, and holds for a short time: it is checked only when a socket opens, so the viewer gets a
// new one before it ends, for the next socket. It carries the person's admin power only if their session has it (an
// admin edits the homepage project, which is nobody's), and only for this one document. The document decides what the
// person may do (read or edit) as it does for any request: a share taken away holds for the next socket.

import * as Schema from "effect/Schema";
import type { Who } from "../directory/index.ts";
import { signed } from "../signed.ts";

/** How long a key holds, in seconds. */
export const KEY_SECONDS = 15 * 60;

/** The person a key names, as the document hears of them. */
export interface KeyPerson {
  login: string;
  name: string;
  avatar?: string;
  admin?: boolean;
}

/** An edit key's value (server/signed.ts): the document (d), and the person: login (l), name (n), picture (a), admin power (m). */
const EditKey = signed(
  "edit-key",
  Schema.Struct({
    d: Schema.String,
    l: Schema.String,
    n: Schema.String,
    a: Schema.optionalKey(Schema.String),
    m: Schema.optionalKey(Schema.Literal(1)),
  }),
  KEY_SECONDS
);

/** A key for `person` to open the socket of the document `id` (its owner `owner`), until `now` and KEY_SECONDS. */
export async function editKey(
  secret: string,
  owner: string,
  id: string,
  person: KeyPerson,
  now = Date.now()
): Promise<{ key: string; expires: number }> {
  const key = await EditKey.seal(
    secret,
    {
      d: `${owner.toLowerCase()}/${id}`,
      l: person.login.toLowerCase(),
      n: person.name,
      ...(person.avatar ? { a: person.avatar } : {}),
      ...(person.admin ? { m: 1 as const } : {}),
    },
    { now }
  );
  return { key, expires: (Math.floor(now / 1000) + KEY_SECONDS) * 1000 };
}

/** The person a good, current key for this document names, or null. */
export async function readEditKey(secret: string, key: string, owner: string, id: string, now = Date.now()): Promise<KeyPerson | null> {
  const c = await EditKey.open(secret, key, now);
  if (!c || c.d != `${owner.toLowerCase()}/${id}`) return null;
  return { login: c.l, name: c.n, ...(c.a != null ? { avatar: c.a } : {}), ...(c.m === 1 ? { admin: true } : {}) };
}

/** Who a key's person is, to the document: this one document, with admin power only if their session had it. */
export const keyWho = (person: KeyPerson, id: string): Who => ({
  login: person.login,
  ...(person.admin ? { admin: true } : {}),
  onlyDoc: id,
});
