// Who may do what with a document: the roles, what each lets someone do, and who a request is from, as the app
// said. The directory (server/directory/) decides a role, by its own rule (Directory.decide); the document keeps a
// copy of its permissions and asks that rule itself (document/api/permissions.ts).

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A person's role in a document: whoever made it owns it; others are given editor, commenter or viewer. */
export type Role = "owner" | "editor" | "commenter" | "viewer";

/** Someone asking, as the app said (x-erga-who): the directory's Who, which the document only passes on to the directory's rule. */
export interface Asker {
  login: string;
  test?: boolean;
  by?: string;
}

/** x-erga-who, as JSON: an Asker, its other fields kept as they are (they're the directory's, passed on). */
const AskerHeader = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ login: Schema.String }), [Schema.Record(Schema.String, Schema.Unknown)])
);
const askerOf = Schema.decodeUnknownOption(AskerHeader);

/** Who a request is from, as the app said (x-erga-who); null if it said no one. */
export const askerFrom = (headers: Headers): Asker | null => Option.getOrNull(askerOf(headers.get("x-erga-who") ?? "null")) as Asker | null;

export interface Person {
  id: string;
  name: string /** Their picture, as the app said (shared/avatars.ts); absent: none. */;
  avatar?: string;
}

/** Who a request is from, as the app said (x-erga-person: JSON {id, name, avatar?}). */
export function personOf(headers: Headers): Person {
  try {
    const p = JSON.parse(headers.get("x-erga-person") ?? "") as Person;
    if (typeof p.id == "string" && typeof p.name == "string")
      return { id: p.id, name: p.name, ...(typeof p.avatar == "string" ? { avatar: p.avatar } : {}) };
  } catch {
    /* none */
  }
  return { id: "anon", name: "Someone" };
}

/** How a user acts when not in person, as the app said (x-erga-via, JSON; shared/attribution.ts); null: in person. */
export function viaOf(header: string | null | undefined): string | null {
  try {
    const v = JSON.parse(header ?? "");
    if (typeof v == "string" && v) return v;
  } catch {
    /* none */
  }
  return null;
}

/** One person's role, as the document keeps it. */
export interface PersonRole {
  login: string;
  role: Role;
}

/** What a role lets someone do with the document's files and its agent (x-erga-access): edit, view, or nothing. */
export const accessOf = (role: Role | null): "edit" | "view" | null =>
  role == "owner" || role == "editor" ? "edit" : role == "commenter" || role == "viewer" ? "view" : null;

/** Whether a role sees the document's comments, adds them and replies: a commenter, an editor, the owner. A viewer sees none. */
export const mayComment = (role: Role | null): boolean => role == "commenter" || role == "editor" || role == "owner";

/** Whether a role resolves or reopens any thread: an editor, the owner. A commenter resolves only their own. */
export const mayResolveAny = (role: Role | null): boolean => role == "editor" || role == "owner";
