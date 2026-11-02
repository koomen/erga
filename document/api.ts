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

export const Api = HttpApi.make("erga")
  .add(HttpApiGroup.make("doc")
    .add(HttpApiEndpoint.get("info", "/api/doc", { success: DocInfo }))
    .middleware(PersonFromRequest))
  .add(HttpApiGroup.make("agent")
    /** A tab's answer to the agent's view_page request. */
    .add(HttpApiEndpoint.post("view", "/api/agent/view", {
      payload: Schema.Struct({
        id: Schema.String,
        png: Schema.optional(Schema.String),
        width: Schema.Number,
        height: Schema.Number,
        errors: Schema.Array(Schema.String),
        viewport: Schema.optional(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
        colorScheme: Schema.optional(Schema.Literals(["light", "dark"])),
        fonts: Schema.optional(Schema.Array(Schema.Struct({ family: Schema.String, wanted: Schema.optional(Schema.String), elements: Schema.Number, tags: Schema.Array(Schema.String) }))),
        pending: Schema.optional(Schema.Array(Schema.String)),
        note: Schema.optional(Schema.String),
        error: Schema.optional(Schema.String),
        value: Schema.optional(Schema.String),
        page: Schema.optional(Schema.String),
        preview: Schema.optional(Schema.Struct({ path: Schema.String, edits: Schema.Number })),
        step: Schema.optional(
          Schema.Struct({ index: Schema.Number, number: Schema.String, count: Schema.Number, label: Schema.optional(Schema.String) })
        ),
        shots: Schema.optional(Schema.Array(Schema.Struct({ at: Schema.Number, png: Schema.String }))),
        declined: Schema.optional(Schema.Boolean),
        rank: Schema.optional(Schema.Number),
      }),
      success: Ok,
    }))
    /** How many of the person's agent's changes here Undo can take back. */
    .add(HttpApiEndpoint.get("undoable", "/api/agent/undo", { success: Schema.Struct({ count: Schema.Number }) }))
    /** Undoes the agent's last change; ok is false when there was nothing to undo. */
    .add(HttpApiEndpoint.post("undo", "/api/agent/undo", { success: Schema.Struct({ ok: Schema.Boolean }) }))
    .middleware(PersonFromRequest))
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
    }))
    /** The person's own agent's turn is done (agents/person/sessions.ts): its presence here ends, and a version is cut. */
    .add(HttpApiEndpoint.post("done", "/api/agent/done", { success: Ok, error: [SessionFailed] }))
    .middleware(ExternalAgent))
  .middleware(ExplainBadRequests);
