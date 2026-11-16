// The host's HTTP API, declared once: what each endpoint takes, what it
// answers and how it fails. document/api/host.ts implements it; the editor
// imports its types only, so none of this lands in the
// browser bundle.
//
// Failures keep the shape callers already know ({ ok: false, error } from the operations),
// plus a _tag naming which failure it was. A body or parameter that doesn't
// decode is a 400 saying what's wrong (BadRequest).
//
// The share button's /api/share isn't here either: tokens are the app.s, which answers it before it reaches a document.
//
// Not here: the WebSocket (/api/room: the room, and with ?events=1 the person's events), the editor's start (/api/start:
// binary, shared/room-socket.ts), the files (the editor's
// own, and the document's under /doc/), and /api/stored, which moves raw
// bytes with ETags. Those stay plain routes in document/api/host.ts and cloudflare/objects/document.ts.

import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import { PANEL, type Action, type Audit } from "../../shared/routes.ts";
import { DocName } from "../model/names.ts";

// ------------------------------------------------------------ failures

const failed = { ok: Schema.Literal(false) };

/** The body or a parameter didn't decode; `error` says how. */
export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { ...failed, error: Schema.String },
  { httpApiStatus: 400 }
) {}
export class NoSuchOperation extends Schema.TaggedError<NoSuchOperation>()(
  "NoSuchOperation",
  { ...failed, error: Schema.String },
  { httpApiStatus: 404 }
) {}
/** The operation ran and failed (bad arguments, an edit that didn't match): `error` is what the caller reads. */
export class OperationFailed extends Schema.TaggedError<OperationFailed>()(
  "OperationFailed",
  { ...failed, error: Schema.String },
  { httpApiStatus: 400 }
) {}

// ------------------------------------------------------------ who's asking

/**
 * Who's asking: the user the app vouched for; and how they act, when not in person (`via`, shared/attribution.ts:
 * "their agent", "a shared agent (label)"). The two name the participant (participants.ts). `turn`: the id of the
 * turn that the call is part of, when its caller has turns.
 */
export class Person extends Context.Service<
  Person,
  { readonly id: string; readonly name: string; readonly avatar?: string; readonly via?: string; readonly turn?: string }
>()("erga/Person") {}

/** Who a request is from: the user the app vouched for (its session, a token it checked, or ?user= in local development). */
export class PersonFromRequest extends HttpApiMiddleware.Service<PersonFromRequest, { provides: Person }>()("erga/PersonFromRequest") {}

/** Turns a request that doesn't decode into a BadRequest (a response that doesn't encode stays a 500). */
export class ExplainBadRequests extends HttpApiMiddleware.Service<ExplainBadRequests>()("erga/ExplainBadRequests", { error: BadRequest }) {}

// ------------------------------------------------------------ shapes

const Ok = Schema.Struct({ ok: Schema.Literal(true) });
/** What Undo or Redo did; `why`: it can't now (the lock for source edits is another participant's). */
const Replayed = Schema.Struct({ ok: Schema.Boolean, why: Schema.optional(Schema.String) });



export const DocInfo = Schema.Struct({
  name: Schema.String,
  /** The document's path inside its folder. */
  path: Schema.String,
  dir: Schema.String,
  /** Who's asking: the signed-in person (in local development, ?user= may say someone else). */
  user: Schema.String,
  /** Their id: what their carets, edits and agent are attributed to. */
  userId: Schema.String,
  /** Their picture, if they have one (their GitHub avatar). */
  avatar: Schema.optional(Schema.String),
  writeDelay: Schema.Number,
  /** Whether they may edit it (false: they may only view it; their edits go nowhere). */
  canEdit: Schema.optional(Schema.Boolean),
  /** Its title and address, where the platform keeps a directory (both hosts do). */
  docName: Schema.optional(DocName),
  /** The largest file anyone can add here, in MB (an admin's setting): the editor refuses a larger one before it sends a byte. */
  maxFileMb: Schema.optional(Schema.Number),
});
export type DocInfo = typeof DocInfo.Type;

/**
 * The start of GET /api/start's answer, and the first message on a tab's socket (/api/room?events=1, a text frame),
 * again each time the document opens for it: the document's details as its person sees them, and its tree as GET
 * ls gives it (with the latest moves, for a page that moved while the tab wasn't connected).
 */
export interface Hello {
  type: "hello";
  info: DocInfo;
  tree: {
    entries: { path: string; type: string; title?: string }[];
    canEdit: boolean;
    moved: { from: string; to: string }[] /** How many pages it has (more than one: the title opens them). */;
    pages: number;
  };
  /** The room's history (document/room/room.ts): a tab that started from another's must not merge into this one. */
  epoch: string;
}

// ------------------------------------------------------------ the API

/** An endpoint's place in the audit (shared/routes.ts): what the person does there, and the agent tool that does it or why there's none. */
export class Audited extends Context.Service<Audited, { readonly action: string } & Audit>()("erga/Audited") {}

const PANEL_ROW = { domain: "none", exempt: PANEL } as const;
const SERVER = "the server's own call, refused from outside (server/documents/routes.ts)";

export const Api = HttpApi.make("erga")
  .add(
    HttpApiGroup.make("doc")
      .add(
        HttpApiEndpoint.get("info", "/api/doc", { success: DocInfo }).annotate(Audited, {
          action: "The editor wakes the document as the pointer nears Edit (its name and who you are)",
          domain: "none",
          exempt: "the page's own warm-up, not a person's action (the name: ls)",
        })
      )
      .middleware(PersonFromRequest)
  )
  .add(
    HttpApiGroup.make("work")
      /** A tab's answer to a request about the live page (shared/live-page.ts, LiveAnswer). */
      .add(
        HttpApiEndpoint.post("live", "/api/live", {
          payload: Schema.Struct({
            id: Schema.String,
            value: Schema.optional(Schema.String),
            declined: Schema.optional(Schema.Boolean),
            rank: Schema.optional(Schema.Number),
          }),
          success: Ok,
        }).annotate(Audited, { action: "The tab answers the agent's page_log, page_input and eval_in_page with live", ...PANEL_ROW })
      )
      /** How many changes of the user's agents here Undo can take back (count), and Redo can put back. */
      .add(
        HttpApiEndpoint.get("undoable", "/api/undo", {
          success: Schema.Struct({
            count: Schema.Number,
            redo: Schema.Number,
            /** The user's own agent's last turn here: its changes Undo can still take back, its files, the version before it. */
            turn: Schema.NullOr(
              Schema.Struct({ changes: Schema.Number, files: Schema.Array(Schema.String), version: Schema.NullOr(Schema.String) })
            ),
          }),
        }).annotate(Audited, {
          action: "How many of your agent's changes to the document Undo can take back, and Redo can put back",
          ...PANEL_ROW,
        })
      )
      /** Undoes the newest change of the user's agents; ok is false when there was nothing to undo, or (`why`) it can't now. */
      .add(
        HttpApiEndpoint.post("undo", "/api/undo", { success: Replayed }).annotate(Audited, {
          action: "Undo your agent's last change to the document",
          ...PANEL_ROW,
        })
      )
      /** Puts back the change Undo took back last; ok is false when there was nothing to redo. */
      .add(
        HttpApiEndpoint.post("redo", "/api/redo", { success: Replayed }).annotate(Audited, {
          action: "Redo the change Undo took back last",
          ...PANEL_ROW,
        })
      )
      /** Undoes every change of the user's own agent's last turn at once: how many it took back. */
      .add(
        HttpApiEndpoint.post("undoTurn", "/api/undo-turn", { success: Schema.Struct({ undone: Schema.Number }) }).annotate(Audited, {
          action: "Undo every change of your agent's last turn at once",
          ...PANEL_ROW,
        })
      )
      /** What the user's own agent's last turn changed: a unified diff of each file, from the version before the turn. */
      .add(
        HttpApiEndpoint.get("turnDiff", "/api/turn-diff", { success: Schema.Struct({ diff: Schema.String }) }).annotate(Audited, {
          action: "What your agent's last turn changed in the document, as a diff",
          ...PANEL_ROW,
        })
      )
      .middleware(PersonFromRequest)
  )
  // The server's, only: one of the document's operations (operations.ts) runs here, as the participant that the
  // request names (agents/tools.ts and server/operations/ call it: runInDocument). The app refuses these paths from
  // outside (server/documents/routes.ts): its one API is POST /api/tools/<name> with "document" (server/api.ts).
  .add(
    HttpApiGroup.make("operations")
      /** Runs one operation with the body as its arguments, as the request's participant. */
      .add(
        HttpApiEndpoint.post("run", "/api/operations/:name", {
          params: { name: Schema.String },
          payload: Schema.Record(Schema.String, Schema.Unknown),
          success: Schema.Struct({ ok: Schema.Literal(true), content: Schema.Any }),
          error: [NoSuchOperation, OperationFailed],
        }).annotate(Audited, {
          action:
            'The server runs one of the document\'s operations in the document, as the user or their agent (outside agents call POST /api/tools/<name> with "document")',
          domain: "none",
          exempt: `${SERVER}: the document's operations are every agent's tools already`,
        })
      )
      /** The participant's turn is done (a user's own agent says so: agents/person/sessions.ts): its presence here ends, and a version is cut. */
      .add(
        HttpApiEndpoint.post("done", "/api/turn-done", { success: Ok }).annotate(Audited, {
          action: "The server says that a user's agent's turn is done (agents/person/sessions.ts)",
          domain: "none",
          exempt: SERVER,
        })
      )
      .middleware(PersonFromRequest)
  )
  .middleware(ExplainBadRequests);

/**
 * The document's actions that aren't endpoints of the API above: the plain routes of document/api/host.ts and
 * cloudflare/objects/document.ts, and what a person does on the page as it runs, with no route of its own.
 */
export const ACTIONS: readonly Action[] = [
  {
    method: "WS",
    path: "/d/<id>/api/room",
    action: "Edit the text, and hear the document's and your agent's events (editor: its one socket)",
    domain: "document",
    tool: "edit",
  },
  {
    method: "GET",
    path: "/d/<id>/api/start",
    action: "Open the editor: the document's name, pages and text in one answer (editor)",
    domain: "document",
    tool: "read",
  },
  // A route, not an operation: its body is the file's bytes (up to the upload limits, streamed to storage: uploads.ts).
  // Editors: one file, of any kind, replacing one at that path.
  {
    method: "PUT",
    path: "/api/files/<path>",
    action: "Add or replace a file of any kind, its bytes the body (a drop on the page, an HTTP client)",
    domain: "document",
    tool: "write",
  },
  // The second step of an agent's write of a file on its own disk ({"blob", "size"}): the bytes, with no session
  // (uploads.ts, arrive). The write's wait decides, not who sends them.
  {
    method: "PUT",
    path: "/api/blobs/<sha-256>",
    action: "Send the bytes of a file that a write waits for (an agent's shell, after its write named their sha-256 and size)",
    domain: "document",
    tool: "write",
  },
  // The live page in the person's tab (shared/live-page.ts).
  { method: "UI", path: "/d/<id>#page-click", action: "Click on the page as it runs (editor)", domain: "document", tool: "page_input" },
  { method: "UI", path: "/d/<id>#page-key", action: "Press a key on the page as it runs (editor)", domain: "document", tool: "page_input" },
  {
    method: "UI",
    path: "/d/<id>#devtools",
    action: "Read the page's console, requests and state, as the browser's developer tools show them (editor)",
    domain: "document",
    tool: "page_log",
  },
  // Full screen (client/inline/viewer-full.ts): nothing an agent could do with it.
  {
    method: "UI",
    path: "/d/<id>#fullscreen",
    action: "Show the page full screen, as a presentation (the Full screen button, viewing and editing)",
    domain: "none",
    exempt: "the person's own screen: a browser goes full screen only on the person's click, and an agent has no screen to show it on",
  },
];
