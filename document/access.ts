// Who may do what with a document. The directory (server/directory/) decides
// it, by its own rule (Directory.decide); the document keeps a copy of its
// permissions (the directory pushes every change; D1 stays the truth) and
// asks that rule itself, so a request asks the database nothing
// (`DocumentAccess`, which Document runs).

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Storage } from "./storage.ts";
import { VIA } from "../shared/attribution.ts";

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

/** How an outside agent's person acts through it, as the app said (x-erga-via, JSON; shared/attribution.ts). */
export function viaOf(header: string | undefined): string {
  try { const v = JSON.parse(header ?? ""); if (typeof v == "string" && v) return v; } catch { /* none */ }
  return VIA.token("");
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

/** Where the copy of the permissions is kept in the document's storage. */
const PERMS = "perms";

/** Where its share counter is kept: how many times a share of it ended (DocumentAccess.shares). */
const SHARES = "shares";

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

  /** Its share counter (undefined: not read yet). */
  private ended: number | undefined = undefined;

  constructor(private o: AccessOptions) {}

  /** Storage was emptied or replaced: the copy is read again. */
  forget(): void {
    this.perms = undefined;
    this.ended = undefined;
  }

  /**
   * The share counter: how many times a share of the document ended. A pass to its files (server/documents/pages-origin.ts)
   * carries the counter of when it was made, and opens them only while that is still the counter: whoever lost their
   * share keeps no pass that works, and the others get a new one at their next load.
   */
  async shares(): Promise<number> {
    this.ended ??= (await this.o.storage.get<number>(SHARES)) ?? 0;
    return this.ended;
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
      if (!read || !url.pathname.startsWith("/doc/") || headers.get("upgrade")) return new Response("Not allowed", { status: 403 });
      // The pass is from before a share ended (x-erga-shares: its counter).
      if (Number(headers.get("x-erga-shares")) != (await this.shares()))
        return new Response("This link has expired: reload the page.", {
          status: 403,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      return new Request(request, { headers });
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

  /**
   * The document's owner as its permissions say (Directory.decide does the same): the host's own copy is the one it was
   * made with, and the homepage project's adoption (adoptHome) changes the owner only in the directory.
   */
  async owner(): Promise<string | null> {
    const info = await this.o.info();
    if (!info) return null;
    return (await this.permissions(info.id)).find((p) => p.role == "owner")?.login ?? info.owner;
  }

  /** The directory says who may do what with this document now (every change is pushed here). */
  async setPermissions(list: readonly PersonRole[], at = Date.now()): Promise<void> {
    if (this.perms === undefined) this.perms = (await this.o.storage.get<{ list: PersonRole[]; at: number }>(PERMS)) ?? null;
    if (this.perms && this.perms.at > at) return;
    // Someone (or anyone with the link) is no longer on the list: a share ended, and the passes made before stop.
    const ended = this.perms?.list.some((had) => !list.some((p) => p.login == had.login));
    this.perms = { list: list.map((p) => ({ login: p.login, role: p.role })), at };
    await this.o.storage.put(PERMS, this.perms);
    if (ended) await this.o.storage.put(SHARES, (this.ended = (await this.shares()) + 1));
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
