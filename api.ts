// The host's HTTP API, declared once: what each endpoint takes, what it
// answers and how it fails. open.ts implements it; the editor
// (src/page/main.ts) imports its types only, so none of this lands in the
// browser bundle.
//
// Failures keep the shape callers already know ({ ok: false, reason } from
// the agent's endpoints, { ok: false, error } from the external agent's),
// plus a _tag naming which failure it was. A body or parameter that doesn't
// decode is a 400 saying what's wrong (BadRequest).
//
// Not here: the WebSockets (/api/room, /api/events), the files (the editor's
// own, and the document's under /doc/), and /api/stored, which moves raw
// bytes with ETags. Those stay plain routes in open.ts.

import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "effect/http-api";
import type { Log } from "./src/page/agent-log";

// ------------------------------------------------------------ failures

const failed = { ok: Schema.Literal(false) };

/** The body or a parameter didn't decode; `error` says how. */
export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", { ...failed, error: Schema.String }, { httpApiStatus: 400 }) {}
/** No share token, or one that's been rotated away. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { ...failed, error: Schema.String }, { httpApiStatus: 401 }) {}
/** The embedded agent is off (no key), or its session didn't start. */
export class AgentOff extends Schema.TaggedError<AgentOff>()("AgentOff", { ...failed, reason: Schema.String }, { httpApiStatus: 503 }) {}
export class NoSuchModel extends Schema.TaggedError<NoSuchModel>()("NoSuchModel", { ...failed, reason: Schema.String }, { httpApiStatus: 400 }) {}
/** The scripted test model can't be switched. */
export class ModelFixed extends Schema.TaggedError<ModelFixed>()("ModelFixed", { ...failed, reason: Schema.String }, { httpApiStatus: 409 }) {}
/** The person's agent session didn't start, so its tools can't run. */
export class SessionFailed extends Schema.TaggedError<SessionFailed>()("SessionFailed", { ...failed, error: Schema.String }, { httpApiStatus: 503 }) {}
export class NoSuchTool extends Schema.TaggedError<NoSuchTool>()("NoSuchTool", { ...failed, error: Schema.String }, { httpApiStatus: 404 }) {}
/** The tool ran and failed (bad arguments, an edit that didn't match): `error` is what the model would read. */
export class ToolFailed extends Schema.TaggedError<ToolFailed>()("ToolFailed", { ...failed, error: Schema.String }, { httpApiStatus: 400 }) {}

// ------------------------------------------------------------ who's asking

/** The person a request acts for. */
export class Person extends Context.Service<Person, { readonly id: string; readonly name: string }>()("erga/Person") {}

/** Who a request is from: locally ?user= (the host's user by default); hosted, the session the Worker checked. */
export class PersonFromQuery extends HttpApiMiddleware.Service<PersonFromQuery, { provides: Person }>()("erga/PersonFromQuery") {}

/** An external agent's bearer token, which stands for the person who shared it. */
export class ShareToken extends HttpApiMiddleware.Service<ShareToken, { provides: Person }>()("erga/ShareToken", {
  error: Unauthorized,
  security: { bearer: HttpApiSecurity.bearer },
}) {}

/** Turns a request that doesn't decode into a BadRequest (a response that doesn't encode stays a 500). */
export class ExplainBadRequests extends HttpApiMiddleware.Service<ExplainBadRequests>()("erga/ExplainBadRequests", { error: BadRequest }) {}

// ------------------------------------------------------------ shapes

const Ok = Schema.Struct({ ok: Schema.Literal(true) });

export const DocInfo = Schema.Struct({
  name: Schema.String,
  /** The document's path inside its folder. */
  path: Schema.String,
  kind: Schema.Literals(["html", "md"]),
  dir: Schema.String,
  /** Who's asking: the signed-in person hosted, the host's user locally (unless ?user= says). */
  user: Schema.String,
  writeDelay: Schema.Number,
});
export type DocInfo = typeof DocInfo.Type;

/** The model a person's agent runs on, and what it can switch to (nothing when scripted). */
export const ModelState = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  choice: Schema.NullOr(Schema.String),
  models: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});
export type ModelState = typeof ModelState.Type;

/**
 * The agent's transcript (src/page/agent-log.ts), passed through as the
 * session keeps it (Any, not Unknown: its items leave optional fields
 * undefined, which JSON drops).
 */
const LogField = Schema.Any as unknown as Schema.Codec<Log>;

export const AgentState = Schema.Union([
  Schema.Struct({ enabled: Schema.Literal(true), ...ModelState.fields, log: LogField }),
  Schema.Struct({ enabled: Schema.Literal(false), reason: Schema.String, log: Schema.optional(LogField) }),
]);
export type AgentState = typeof AgentState.Type;

/** One of the agent's tools, as an external agent sees it (parameters are JSON Schema). */
const ToolSpec = Schema.Struct({ name: Schema.String, description: Schema.String, parameters: Schema.Unknown });

// ------------------------------------------------------------ the API

export const Api = HttpApi.make("erga")
  .add(HttpApiGroup.make("doc")
    .add(HttpApiEndpoint.get("info", "/api/doc", { success: DocInfo }))
    .middleware(PersonFromQuery))
  .add(HttpApiGroup.make("agent")
    .add(HttpApiEndpoint.get("state", "/api/agent", { success: AgentState }))
    /** A message for the person's agent; `after` is the sender's state vector, so its last keystrokes land first. */
    .add(HttpApiEndpoint.post("prompt", "/api/agent", {
      payload: Schema.Struct({ text: Schema.String, context: Schema.optional(Schema.NullOr(Schema.String)), after: Schema.optional(Schema.String) }),
      success: Ok,
      error: AgentOff,
    }))
    /** Switches the person's agent to another model, from its next turn; their other tabs follow. */
    .add(HttpApiEndpoint.post("model", "/api/agent/model", {
      payload: Schema.Struct({ model: Schema.String }),
      success: Schema.Struct({ ok: Schema.Literal(true), ...ModelState.fields }),
      error: [AgentOff, NoSuchModel, ModelFixed],
    }))
    /** A tab's answer to the agent's view_page request. */
    .add(HttpApiEndpoint.post("view", "/api/agent/view", {
      payload: Schema.Struct({
        id: Schema.String,
        png: Schema.optional(Schema.String),
        width: Schema.Number,
        height: Schema.Number,
        errors: Schema.Array(Schema.String),
        note: Schema.optional(Schema.String),
        error: Schema.optional(Schema.String),
      }),
      success: Ok,
    }))
    .add(HttpApiEndpoint.post("abort", "/api/agent/abort", { success: Ok }))
    .add(HttpApiEndpoint.post("reset", "/api/agent/reset", { success: Ok }))
    /** Undoes the agent's last change; ok is false when there was nothing to undo. */
    .add(HttpApiEndpoint.post("undo", "/api/agent/undo", { success: Schema.Struct({ ok: Schema.Boolean }) }))
    /** The share button: a token for this person's external agent (rotate: true revokes the old one). */
    .add(HttpApiEndpoint.post("share", "/api/share", {
      payload: Schema.Struct({ rotate: Schema.optional(Schema.Boolean) }),
      success: Schema.Struct({ token: Schema.String }),
    }))
    .middleware(PersonFromQuery))
  .add(HttpApiGroup.make("ext")
    /** The external agent's guide: how to call the tools, and the document rules. */
    .add(HttpApiEndpoint.get("guide", "/api/ext", {
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/markdown; charset=utf-8" })),
      error: SessionFailed,
    }))
    .add(HttpApiEndpoint.get("tools", "/api/ext/tools", {
      success: Schema.Struct({ ok: Schema.Literal(true), tools: Schema.Array(ToolSpec) }),
      error: SessionFailed,
    }))
    /** Runs one tool with the body as its arguments, in the person's agent session. */
    .add(HttpApiEndpoint.post("run", "/api/ext/tools/:name", {
      params: { name: Schema.String },
      payload: Schema.Record(Schema.String, Schema.Unknown),
      success: Schema.Struct({ ok: Schema.Literal(true), content: Schema.Any }),
      error: [SessionFailed, NoSuchTool, ToolFailed],
    }))
    .middleware(ShareToken))
  .middleware(ExplainBadRequests);
