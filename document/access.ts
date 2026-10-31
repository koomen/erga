// Who may do what with a document. The directory (server/directory/) decides
// it, by its own rule (Directory.decide); the document keeps a copy of its
// permissions (the directory pushes every change; D1 stays the truth) and
// asks that rule itself, so a request asks the database nothing
// (`DocumentAccess`, which Document runs).

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Storage } from "./storage.ts";

/** A person's role in a document: whoever made it owns it; others are given editor or viewer. */
export type Role = "owner" | "editor" | "viewer";

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

/** One person's role, as the document keeps it. */
export interface PersonRole {
  login: string;
  role: Role;
}

/** What a role lets someone do with the document's files and its agent (x-erga-access): edit, view, or nothing. */
export const accessOf = (role: Role | null): "edit" | "view" | null =>
  role == "owner" || role == "editor" ? "edit" : role == "viewer" ? "view" : null;

/** Where the copy of the permissions is kept in the document's storage. */
const PERMS = "perms";

/** How long a document trusts its copy of its permissions before it reads them again (in the background): changes are pushed, so this only covers one that didn't arrive. */
const PERMISSIONS_FRESH_MS = 5 * 60_000;

/** What the document's access needs: its storage, the directory's rule and its permissions, and the document as it is. */
export interface AccessOptions {
  storage: Storage;
  directory: {
    decide(who: Asker | null, doc: { id: string; owner: string; test: boolean }, permissions: readonly PersonRole[]): Promise<Role | null>;
    permissions(id: string): Promise<PersonRole[]>;
  };
  /** The document (null: there's none). */
  info: () => Promise<{ id: string; owner: string; test?: boolean } | null>;
  background: (work: Promise<unknown>) => void;
  log: (line: string) => void;
}

/** A document's access: its copy of its permissions, and the requests it decides with them. */
export class DocumentAccess {
  /** Its permissions as the directory last said, and when (undefined: not read yet; null: none kept). */
  private perms: { list: PersonRole[]; at: number } | null | undefined = undefined;

  constructor(private o: AccessOptions) {}

  /** Storage was emptied or replaced: the copy is read again. */
  forget(): void {
    this.perms = undefined;
  }

  /**
   * A request from the app, decided here: who it's from (x-erga-who,
   * the person the app signed in) and what their permission lets them
   * do, from this document's copy of its permissions (Directory.decide, the
   * directory's own rule). It goes on with x-erga-access; a Response refuses
   * it. A GET of a file with a key the app checked (x-erga-checked:
   * the viewer's files, the editor's pages origin) needs no one.
   */
  async authorize(request: Request): Promise<Request | Response> {
    const headers = new Headers(request.headers);
    headers.delete("x-erga-access");
    const url = new URL(request.url);
    const read = request.method == "GET" || request.method == "HEAD";
    if (headers.has("x-erga-checked")) {
      headers.delete("x-erga-who");
      if (read && url.pathname.startsWith("/doc/") && !headers.get("upgrade")) return new Request(request, { headers });
      return new Response("Not allowed", { status: 403 });
    }
    const who = askerFrom(headers);
    if (!who) return new Response("Sign in first", { status: 401 });
    const info = await this.o.info();
    if (!info) return new Response("No such document", { status: 404 });
    const access = accessOf(await this.roleOf(who));
    if (!access) return new Response("Not allowed", { status: 403 });
    headers.set("x-erga-access", access);
    return new Request(request, { headers });
  }

  /** What `who` may do with the document, as a role (null: nothing), from its copy of its permissions. */
  async roleOf(who: Asker): Promise<Role | null> {
    const info = await this.o.info();
    if (!info) return null;
    return this.o.directory.decide(who, { id: info.id, owner: info.owner, test: !!info.test }, await this.permissions(info.id));
  }

  /** The directory says who may do what with this document now (every change is pushed here). */
  async setPermissions(list: readonly PersonRole[], at = Date.now()): Promise<void> {
    if (this.perms === undefined) this.perms = (await this.o.storage.get<{ list: PersonRole[]; at: number }>(PERMS)) ?? null;
    if (this.perms && this.perms.at > at) return;
    this.perms = { list: list.map((p) => ({ login: p.login, role: p.role })), at };
    await this.o.storage.put(PERMS, this.perms);
  }

  /**
   * Its permissions: the copy it keeps, read from the directory when it has
   * none, and again (meanwhile answering with the copy) once the copy is
   * older than PERMISSIONS_FRESH_MS, in case a change didn't reach it.
   */
  private async permissions(id: string): Promise<PersonRole[]> {
    if (this.perms === undefined) this.perms = (await this.o.storage.get<{ list: PersonRole[]; at: number }>(PERMS)) ?? null;
    const kept = this.perms;
    if (kept && Date.now() - kept.at < PERMISSIONS_FRESH_MS) return kept.list;
    const fresh = this.readPermissions(id);
    if (!kept) return fresh;
    this.o.background(fresh.catch((e) => this.o.log(`couldn't read ${id}'s permissions: ${e}`)));
    return kept.list;
  }

  /** Its permissions, read from the directory now (and kept, if there are any). */
  async readPermissions(id: string): Promise<PersonRole[]> {
    const at = Date.now();
    const list = await this.o.directory.permissions(id);
    // (None: a row not there yet, or gone. Nothing is kept, so the next request asks again.)
    if (list.length) await this.setPermissions(list, at);
    return list;
  }
}
