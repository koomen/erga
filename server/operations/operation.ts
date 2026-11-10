// An operation: one thing a person can do on the server, defined once, with its
// arguments' Schema, its checks and its answer. The front end calls it over
// POST /api/tools/<name> (server/api.ts) with the person's session; every agent
// calls the same operation as a tool, as its person (agents/tools.ts): the
// embedded agents in-process, an outside agent over the same HTTP, REST or MCP.
//
// Who calls is a Caller: the person (Who), and how they act (in person, or `via`
// one of their agents). Admin power (Who.admin) comes with a person's own
// session and an admin-scope token, and with an admin's own agent (agents/person/);
// never with a document token. An operation marked `admin` is only
// for a caller with it, and the directory checks again on every call
// (Users.mustAdmin).

import * as Schema from "effect/Schema";
import {
  ConfigError,
  CredentialError,
  type Directory,
  type DocRow,
  ID,
  LOCKED,
  NotAllowed,
  NotFound,
  OWNER,
  type Action,
  type Route,
  type Who,
} from "../directory/index.ts";
import { AuthError, type AgentToken, type AuthOps } from "../identity/index.ts";
import { forwardedAs } from "../documents/index.ts";
import type { Platform } from "../platform.ts";
import type { ToolContent } from "../../document/agent.ts";
import { HOME_OWNER, HOME_SLUG, nameOf } from "../../document/names.ts";

/** An operation's failure, worded for a person or an agent to act on; `status` is the HTTP status the API answers. */
export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  message: Schema.String,
  status: Schema.Number,
}) {}

/** Who calls an operation, and what it runs with. */
export interface Caller {
  readonly dir: Directory;
  readonly who: Who;
  /** The person's name, for a request to a document's host. */
  readonly name?: string;
  /** The document open on the person's page, as their own agent's message said (agents/person/): the default for a `document` argument. */
  readonly here?: string;
  /** The server's origin, for URLs in answers (else addresses only). */
  readonly origin?: string;
  /** The platform: for the operations on documents, their files and the person's tokens. */
  readonly platform?: Platform;
  /** Sign-in's settings, where the server has them: for the sign-in operations. */
  readonly auth?: AuthOps;
  /** An outside agent's token, when it calls with one. */
  readonly token?: AgentToken;
  /**
   * The call came with a page's edit key (server/api.ts, fromPage). The page's own scripts can send one as the person,
   * so it never asks the person's agent by itself (comments.ts).
   */
  readonly fromPage?: true;
  /** A person's own agent hears each document its tools ran in (callDocument), to say when its turn is done there. */
  readonly ranIn?: (doc: Route) => void;
}

/** One operation, for the front end and every agent alike. */
export interface Operation {
  readonly name: string;
  /** For the agent panel (the name, if not given). */
  readonly label?: string;
  /** What the agent is doing while it runs ("sharing the document"): the agent's panel shows it. */
  readonly activity?: string;
  readonly description: string;
  /** Its arguments (outside agents get their JSON Schema). */
  readonly parameters: Schema.Top;
  /** Only for a caller with admin power. */
  readonly admin?: boolean;
  /** Reaches beyond one document (lists or makes documents, manages tokens): never for a document token. */
  readonly wide?: boolean;
  /** Checks its own arguments (files take more than their schema says): only the required ones are checked first. */
  readonly loose?: boolean;
  /**
   * What the person's own agent must have approved before it runs this call, in words for their panel ("Delete
   * /ada/notes for good"); null for a call that needs no approval. The agent's run stops at such a call until the
   * person clicks Approve there (agents/turn.ts, asking). The pages and outside agents with a token run it at once.
   */
  readonly asks?: (args: Record<string, unknown>) => string | null;
  /** Where a person does it in the UI ("Users: Add user"): the audit lists it (tests/agent-actions.test.ts). */
  readonly ui: string;
  /** Its answer: text, JSON, or content items. Throws an OperationError (or NotAllowed, ConfigError) to act on. */
  run(args: Record<string, unknown>, caller: Caller): Promise<string | object | ToolContent[]>;
}

/** Whether `caller` may use `op` at all: admin power for an admin one, and a reach beyond one document for a wide one. */
export async function offered(op: Pick<Operation, "admin" | "wide">, caller: Caller): Promise<boolean> {
  if (op.wide && caller.who.onlyDoc != null) return false;
  return !op.admin || (await caller.dir.users.actsAsAdmin(caller.who));
}

/** Runs one, as `caller`; what the directory throws becomes an OperationError (not allowed: 403; a bad value: 400). */
export async function runOperation(op: Operation, args: Record<string, unknown>, caller: Caller): Promise<string | object | ToolContent[]> {
  if (op.admin && !(await caller.dir.users.actsAsAdmin(caller.who)))
    throw new OperationError({
      message: (await caller.dir.users.isAdmin(caller.who))
        ? caller.token
          ? `${op.name} needs an admin token: ${LOCKED}`
          : caller.who.via
            ? `${op.name} is an admin's, and your agent here has no admin power: ask on the admin pages (/admin).`
            : LOCKED
        : `${op.name} is for the server's admins only, and ${caller.who.login} isn't one.`,
      status: 403,
    });
  if (op.wide && caller.who.onlyDoc != null)
    throw new OperationError({
      message: `${op.name} isn't for a document token: it reaches one document only. Make a token with the documents scope at /tokens.`,
      status: 403,
    });
  try {
    return await op.run(args, caller);
  } catch (e) {
    if (e instanceof OperationError) throw e;
    // A refusal carries its status (server/directory/users.ts).
    if (
      e instanceof NotFound ||
      e instanceof NotAllowed ||
      e instanceof ConfigError ||
      e instanceof CredentialError ||
      e instanceof AuthError
    )
      throw new OperationError({ message: e.message, status: e.status });
    throw e;
  }
}

// ---------------------------------------------------------------- what the operations share

export const str = (description: string) => Schema.String.annotate({ description });
/** A document, by any of its names; the person's own agent may leave it out for the document open on their page. */
export const DOCUMENT = Schema.optionalKey(
  str("The document: /<owner>/<slug>, its URL or id, or one of your slugs. Your own agent may leave it out: the open one.")
);
/** The same, always given. */
export const ANY_DOCUMENT = str("The document: /<owner>/<slug>, its URL or id, or one of your slugs.");
export const LOGIN = str("A GitHub login");

/** A value the agent gave, as the person reads it in the question their panel asks (an operation's `asks`). */
export const said = (v: unknown) => (typeof v == "string" ? v : (JSON.stringify(v) ?? "(none)")).slice(0, 200);

export const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);

/** The platform, for the operations that need it. */
export function platformOf(caller: Caller): Platform {
  if (!caller.platform) throw new OperationError({ message: "That isn't reachable from here.", status: 501 });
  return caller.platform;
}

/**
 * The document a caller names (an address, a URL, an id, or one of the
 * person's slugs; nothing for the one open on the page of the person's own agent), if they may do `action` with it.
 */
export async function findDocument(caller: Caller, ref: unknown, action: Action): Promise<DocRow> {
  const { dir, who } = caller;
  if ((ref == null || ref === "") && caller.here) ref = caller.here;
  if (typeof ref != "string" || !ref.trim())
    throw new OperationError({ message: "Name the document: its address (/<owner>/<slug>), URL or id.", status: 400 });
  let path = ref.trim();
  try {
    path = new URL(path).pathname;
  } catch {
    /* not a URL */
  }
  const parts = path.split("/").filter(Boolean);
  let route: Route | null = null;
  if (parts[0] == "_home") route = await routeAt(dir, HOME_OWNER, HOME_SLUG);
  else if (parts.length >= 2)
    route = parts[0] == "d" ? (ID.test(parts[1]) ? await dir.route(parts[1]) : null) : await routeAt(dir, parts[0], parts[1]);
  else if (parts.length == 1) {
    route = ID.test(parts[0]) ? await dir.route(parts[0]) : null;
    route ??= await routeAt(dir, who.login, parts[0]);
  }
  const doc = route && (await dir.get(route.id));
  if (!doc) throw new OperationError({ message: `There's no document "${ref}". list_documents lists yours.`, status: 404 });
  if (who.onlyDoc != null && doc.id != who.onlyDoc)
    throw new OperationError({ message: "This token reaches one document only, and that isn't it.", status: 403 });
  if (!(await dir.may(who, action, doc))) {
    throw new OperationError({
      message:
        action == "delete"
          ? "Only its owner can delete a document."
          : action == "share"
            ? "Only its owner can share a document, or see who it's shared with."
            : action == "comment"
              ? "You can't see or add comments on that document."
              : `You can't ${action} that document.`,
      status: 403,
    });
  }
  return doc;
}

/** The document at /<owner>/<segment>: by id (if it's theirs), slug, or an old slug. */
async function routeAt(dir: Directory, owner: string, segment: string): Promise<Route | null> {
  if (!OWNER.test(owner)) return null;
  owner = owner.toLowerCase();
  if (ID.test(segment)) {
    const byId = await dir.route(segment);
    if (byId?.owner == owner) return byId;
  }
  const found = await dir.locate(owner, segment);
  return found && { id: found.doc.id, owner: found.doc.owner, test: found.doc.test };
}

/** A document as answers name it: its id, title, address, and URL where the origin is known. */
export function described(doc: DocRow, { origin }: Caller) {
  const name = nameOf(doc);
  return { id: doc.id, title: name.title, address: name.address, ...(origin ? { url: origin + name.address } : {}) };
}

/**
 * A request to a document's own host, as the caller: their person, what they may do there, and how they act
 * (an agent's request says so, and may then run the document's tools there: /api/tools/<name>).
 */
export async function callDocument(caller: Caller, doc: Route, path: string, init: RequestInit): Promise<Response> {
  const platform = platformOf(caller),
    origin = caller.origin ?? "https://erga.invalid";
  const url = new URL(path, origin);
  const person = { login: caller.who.login, name: caller.name ?? caller.who.login };
  caller.ranIn?.(doc);
  return platform.docs.fetch(doc, forwardedAs(new Request(url, init), url, path, person, caller.who));
}

/** A document tool, run in the document's host as the caller's agent (POST /api/tools/<name> there, which only the server reaches). */
export async function runInDocument(caller: Caller, doc: Route, name: string, args: Record<string, unknown>): Promise<ToolContent[]> {
  const r = await callDocument(caller, doc, `/api/tools/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const body = (await r.json().catch(() => ({ ok: false, error: `The document answered ${r.status}.` }))) as {
    ok: boolean;
    content?: ToolContent[];
    error?: string;
  };
  if (!body.ok)
    throw new OperationError({ message: body.error ?? "The tool failed.", status: r.status >= 400 && r.status < 500 ? r.status : 500 });
  return body.content ?? [];
}
