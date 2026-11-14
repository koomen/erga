// The host's HTTP API, declared once: what each endpoint takes, what it
// answers and how it fails. document/host.ts implements it; the editor
// imports its types only, so none of this lands in the
// browser bundle.
//
// Failures keep the shape callers already know ({ ok: false, error } from the agents' tools),
// plus a _tag naming which failure it was. A body or parameter that doesn't
// decode is a 400 saying what's wrong (BadRequest).
//
// The share button's /api/share isn't here either: tokens are the app.s, which answers it before it reaches a document.
//
// Not here: the WebSocket (/api/room: the room, and with ?events=1 the person's events), the editor's start (/api/start:
// binary, shared/room-socket.ts), the files (the editor's
// own, and the document's under /doc/), and /api/stored, which moves raw
// bytes with ETags. Those stay plain routes in document/host.ts and cloudflare/objects/document.ts.

import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import { PANEL, type Action, type Audit } from "../shared/routes.ts";

// ------------------------------------------------------------ failures

const failed = { ok: Schema.Literal(false) };

/** The body or a parameter didn't decode; `error` says how. */
export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", { ...failed, error: Schema.String }, { httpApiStatus: 400 }) {}
/** No agent token, or one that's been revoked. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { ...failed, error: Schema.String }, { httpApiStatus: 401 }) {}
/** The person's agent session didn't start, so its tools can't run. */
export class SessionFailed extends Schema.TaggedError<SessionFailed>()("SessionFailed", { ...failed, error: Schema.String }, { httpApiStatus: 503 }) {}
export class NoSuchTool extends Schema.TaggedError<NoSuchTool>()("NoSuchTool", { ...failed, error: Schema.String }, { httpApiStatus: 404 }) {}
/** The tool ran and failed (bad arguments, an edit that didn't match): `error` is what the model would read. */
export class ToolFailed extends Schema.TaggedError<ToolFailed>()("ToolFailed", { ...failed, error: Schema.String }, { httpApiStatus: 400 }) {}

// ------------------------------------------------------------ who's asking

/** The person a request acts for. */
/** Who's asking; an outside agent's request also says how they act through it (`via`, shared/attribution.ts: "a shared agent (label)"). */
export class Person extends Context.Service<Person, { readonly id: string; readonly name: string; readonly via?: string }>()("erga/Person") {}

/** Who a request is from: the person the app vouched for (its session, or ?user= in local development). */
export class PersonFromRequest extends HttpApiMiddleware.Service<PersonFromRequest, { provides: Person }>()("erga/PersonFromRequest") {}

/**
 * An external agent: a request that came with an agent token,
 * which the app checked and turned into the person it stands for.
 */
export class ExternalAgent extends HttpApiMiddleware.Service<ExternalAgent, { provides: Person }>()("erga/ExternalAgent", {
  error: Unauthorized,
}) {}

/** Turns a request that doesn't decode into a BadRequest (a response that doesn't encode stays a 500). */
export class ExplainBadRequests extends HttpApiMiddleware.Service<ExplainBadRequests>()("erga/ExplainBadRequests", { error: BadRequest }) {}

// ------------------------------------------------------------ shapes

const Ok = Schema.Struct({ ok: Schema.Literal(true) });


/** What the document is called: its title, and its address, /<owner>/<slug>. */
export const DocName = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  title: Schema.String,
  slug: Schema.String,
  address: Schema.String,
  /** Set by someone: the title no longer follows the page's first heading, or the slug the title. */
  titleSet: Schema.Boolean,
  slugSet: Schema.Boolean,
});
export type DocName = typeof DocName.Type;

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
  tree: { entries: { path: string; type: string; title?: string }[]; canEdit: boolean; moved: { from: string; to: string }[]; /** A document (one page) or a project (pages). */ kind?: "document" | "project" };
  /** The room's history (document/room.ts): a tab that started from another's must not merge into this one. */
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
    HttpApiGroup.make("agent")
      /** A tab's answer to the agent's live page request (shared/live-page.ts, LiveAnswer). */
      .add(
        HttpApiEndpoint.post("live", "/api/agent/live", {
          payload: Schema.Struct({
            id: Schema.String,
            value: Schema.optional(Schema.String),
            declined: Schema.optional(Schema.Boolean),
            rank: Schema.optional(Schema.Number),
          }),
          success: Ok,
        }).annotate(Audited, { action: "The tab answers the agent's page_log, page_input and eval_in_page with live", ...PANEL_ROW })
      )
      /** How many of the person's agent's changes here Undo can take back (count), and Redo can put back. */
      .add(
        HttpApiEndpoint.get("undoable", "/api/agent/undo", {
          success: Schema.Struct({
            count: Schema.Number,
            redo: Schema.Number,
            /** The person's own agent's last turn here: its changes Undo can still take back, its files, the version before it. */
            turn: Schema.NullOr(
              Schema.Struct({ changes: Schema.Number, files: Schema.Array(Schema.String), version: Schema.NullOr(Schema.String) })
            ),
          }),
        }).annotate(Audited, {
          action: "How many of your agent's changes to the document Undo can take back, and Redo can put back",
          ...PANEL_ROW,
        })
      )
      /** Undoes the agent's last change; ok is false when there was nothing to undo. */
      .add(
        HttpApiEndpoint.post("undo", "/api/agent/undo", { success: Schema.Struct({ ok: Schema.Boolean }) }).annotate(Audited, {
          action: "Undo your agent's last change to the document",
          ...PANEL_ROW,
        })
      )
      /** Puts back the change Undo took back last; ok is false when there was nothing to redo. */
      .add(
        HttpApiEndpoint.post("redo", "/api/agent/redo", { success: Schema.Struct({ ok: Schema.Boolean }) }).annotate(Audited, {
          action: "Redo the change Undo took back last",
          ...PANEL_ROW,
        })
      )
      /** Undoes every change of the agent's last turn at once: how many it took back. */
      .add(
        HttpApiEndpoint.post("undoTurn", "/api/agent/undo-turn", { success: Schema.Struct({ undone: Schema.Number }) }).annotate(Audited, {
          action: "Undo every change of your agent's last turn at once",
          ...PANEL_ROW,
        })
      )
      /** What the agent's last turn changed: a unified diff of each file, from the version before the turn. */
      .add(
        HttpApiEndpoint.get("turnDiff", "/api/agent/turn-diff", { success: Schema.Struct({ diff: Schema.String }) }).annotate(Audited, {
          action: "What your agent's last turn changed in the document, as a diff",
          ...PANEL_ROW,
        })
      )
      .middleware(PersonFromRequest)
  )
  // The server's, only: an agent's document tool (POST /api/tools/<name> with "document", server/api.ts) runs here, as
  // the person's agent (agents/tools.ts, runInDocument). The app refuses this path from outside (server/documents/routes.ts).
  .add(
    HttpApiGroup.make("tools")
      /** Runs one tool with the body as its arguments, in the person's agent session. */
      .add(
        HttpApiEndpoint.post("run", "/api/tools/:name", {
          params: { name: Schema.String },
          payload: Schema.Record(Schema.String, Schema.Unknown),
          success: Schema.Struct({ ok: Schema.Literal(true), content: Schema.Any }),
          error: [SessionFailed, NoSuchTool, ToolFailed],
        }).annotate(Audited, {
          action:
            "The server runs a document tool in the document's host, as the person's agent (outside agents call POST /api/tools/<name> with \"document\")",
          domain: "none",
          exempt: `${SERVER}: the document tools are every agent's already`,
        })
      )
      /** The person's own agent's turn is done (agents/person/sessions.ts): its presence here ends, and a version is cut. */
      .add(
        HttpApiEndpoint.post("done", "/api/agent/done", { success: Ok, error: [SessionFailed] }).annotate(Audited, {
          action: "The server says a person's agent's turn is done (agents/person/sessions.ts)",
          domain: "none",
          exempt: SERVER,
        })
      )
      .middleware(ExternalAgent)
  )
  .middleware(ExplainBadRequests);

/**
 * The document's actions that aren't endpoints of the API above: the plain routes of document/host.ts and
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
