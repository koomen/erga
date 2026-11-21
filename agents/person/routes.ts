// The routes of a person's agent panel (/api/agent...): ROUTES, below. Each asks the person's own agent object
// (PersonAgents, sessions.ts) and answers its page. A page of a document names it on each request (?doc=<its id>):
// the request is about that document's thread. Without it, the thread for the rest of Erga.
//
// The panel is the person's, in a browser: an agent with a token is refused (`personOf`; the gate keeps the token and
// names its agent, server/identity). An outside agent calls the same tools itself (MCP, POST /api/tools/<name>,
// server/api.ts).

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { call, ctx, fromWeb, json, type Route } from "../../server/http.ts";
import type { Platform } from "../../server/platform.ts";
import { PANEL, routeFor, SECRET, STREAM, type RouteRow } from "../../shared/routes.ts";
import { docOf } from "./sessions.ts";

/** Someone signed in, in person (in a browser: for their own agent panel, which is no agent's). */
const personOf = (platform: Platform, request: Request) =>
  call(async (): Promise<{ login: string; name: string } | null> => {
    const session = await platform.sessionOf(request);
    if (!session || session.agent) return null;
    return { login: session.login.toLowerCase(), name: session.name };
  });

export const isAgentPath = (path: string) => path == "/api/agent" || path.startsWith("/api/agent/");

/** The bodies the panel sends: a message, a model. */
const Prompt = Schema.Struct({
  text: Schema.optionalKey(Schema.Unknown),
  context: Schema.optionalKey(Schema.Unknown),
  files: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(Schema.Unknown),
});
const ModelBody = Schema.Struct({ model: Schema.optionalKey(Schema.String) });
const AnswerBody = Schema.Struct({ id: Schema.optionalKey(Schema.String) });
const WhoBody = Schema.Struct({ agent: Schema.optionalKey(Schema.NullOr(Schema.String)) });
const KeyBody = Schema.Struct({ name: Schema.optionalKey(Schema.String), value: Schema.optionalKey(Schema.String) });

/** The body as JSON, as `schema` has it; else `fallback` (a body that isn't JSON counts as none, as before). */
const body = <S extends Schema.Top>(request: Request, schema: S, fallback: S["Type"]) =>
  call(() => request.text()).pipe(
    Effect.flatMap((t) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema as unknown as Schema.Codec<S["Type"]>))(t)),
    Effect.orElseSucceed(() => fallback)
  );

/**
 * GET /api/agent/link: an attached session's link (agents/link.ts), a WebSocket that the session's helper opens with
 * its agent token. The gate checked the token; here the grant must be good (the session's: admit.ts), and wider than
 * one document. The socket goes to the object of the grant's person, which hears it from then on.
 */
const link: Route = Effect.gen(function* () {
  const { request, platform } = yield* ctx;
  const session = yield* call(() => platform.sessionOf(request));
  if (!session?.agent) return json({ error: "The link is an attached agent's: open it with an agent token." }, 401);
  if (session.agent.scope == "document") return json({ error: "A token for one document can't attach a session." }, 403);
  if (request.headers.get("upgrade")?.toLowerCase() != "websocket") return json({ error: "The link is a WebSocket." }, 426);
  const headers = new Headers(request.headers);
  headers.set("x-erga-login", session.login.toLowerCase());
  headers.set("x-erga-grant", session.agent.id);
  return fromWeb(yield* call(() => platform.personAgent(session.login.toLowerCase()).fetch(new Request(request.url, { headers }))));
});

/** /api/agent...: the person's own agent panel, on this site's pages. Only this site's own origin may talk to it, or listen. */
export const agentApi: Route = Effect.gen(function* () {
  const { request, url } = yield* ctx;
  const from = request.headers.get("origin");
  if (from && from != url.origin) return json({ error: "Forbidden" }, 403);
  if (url.pathname == "/api/agent/link") return yield* link;
  return yield* agentRoutes(url.origin);
});

/** The panel's routes, for a page at `origin` (this site's). */
const agentRoutes = (origin: string): Route =>
  Effect.gen(function* () {
    const { request, url, platform } = yield* ctx;
    const me = yield* personOf(platform, request);
    if (!me)
      return json({ error: "Sign in as yourself to talk to your agent." }, (yield* call(() => platform.sessionOf(request))) ? 403 : 401);
    if (request.method != "GET" && request.headers.get("origin") != origin) return json({ error: "Forbidden" }, 403);
    const found = routeFor(ROUTES, request.method, url.pathname.replace(/\/$/, ""));
    if (!found) return json({ error: "Not found" }, 404);
    return yield* found.route.run({ request, url, platform, me, h: platform.personAgent(me.login) });
  });

/** The person who asks, checked, and their agent's object. */
interface Asked {
  readonly request: Request;
  readonly url: URL;
  readonly platform: Platform;
  readonly me: { login: string; name: string };
  readonly h: ReturnType<Platform["personAgent"]>;
}

/**
 * Stops the turn, starts a new conversation, switches the model ({ model }: one the person can use, from the next
 * turn), or gives the person's answer ({ id }) to the tool call `id` that waits for it (a delete, a share with anyone,
 * a token's revoke, an admin change: an operation's `asks`): run it, or not.
 */
const control = (what: "abort" | "reset" | "model" | "approve" | "deny") => (a: Asked) =>
  Effect.gen(function* () {
    const b = what == "model" ? yield* body(a.request, ModelBody, {}) : {};
    const answered = what == "approve" || what == "deny" ? yield* body(a.request, AnswerBody, {}) : {};
    const r = yield* call(() => a.h.agentControl(a.me.login, docOf(a.url), what, b.model ?? answered.id));
    return json(r, r.ok ? 200 : 409);
  });

const PANEL_ROW = { domain: "none", exempt: PANEL } as const;

/** The agent panel's routes. */
export const ROUTES: readonly RouteRow<(a: Asked) => Route>[] = [
  {
    method: "GET",
    path: "/api/agent",
    // { enabled, reason?, model, models, choice, log }
    run: (a) =>
      call(() => a.h.agentState(a.me.login, docOf(a.url), a.url.origin, a.me.name, a.url.searchParams.has("fresh"))).pipe(
        Effect.map((state) => json(state))
      ),
    action: "Your agent's panel",
    ...PANEL_ROW,
  },
  {
    method: "POST",
    path: "/api/agent",
    // { text, context, files?, id? }: a message (it steers a turn that is running). context is the page note (the
    // page open, what is selected there), id
    // the tab's own id for the message: its copy in the transcript carries it, and a second message with the same id
    // (Try again, after the first got there) is not sent again.
    run: (a) =>
      Effect.gen(function* () {
        const b = yield* body(a.request, Prompt, {});
        const r = yield* call(() =>
          a.h.agentPrompt(
            a.me.login,
            a.url.origin,
            String(b.text ?? ""),
            typeof b.context == "string" ? b.context : null,
            b.files,
            docOf(a.url),
            a.me.name,
            typeof b.id == "string" && /^[\w-]{1,64}$/.test(b.id) ? b.id : undefined
          )
        );
        return json(r, r.ok ? 200 : 409);
      }),
    action: "A message to your agent",
    ...PANEL_ROW,
  },
  { method: "POST", path: "/api/agent/abort", run: control("abort"), action: "Stop your agent", ...PANEL_ROW },
  { method: "POST", path: "/api/agent/reset", run: control("reset"), action: "Start a new conversation with your agent", ...PANEL_ROW },
  { method: "POST", path: "/api/agent/model", run: control("model"), action: "Switch your agent's model", ...PANEL_ROW },
  { method: "POST", path: "/api/agent/approve", run: control("approve"), action: "Approve a call your agent asks for", ...PANEL_ROW },
  { method: "POST", path: "/api/agent/deny", run: control("deny"), action: "Deny a call your agent asks for", ...PANEL_ROW },
  {
    method: "POST",
    path: "/api/agent/agent",
    // { agent }: who the panel shows: a hosted agent's name (the setting agents), or null for Erga's own agent.
    run: (a) =>
      Effect.gen(function* () {
        const b = yield* body(a.request, WhoBody, {});
        const r = yield* call(() => a.h.setAgent(a.me.login, b.agent ?? null));
        return json(r, r.ok ? 200 : 409);
      }),
    action: "Pick the agent that your panel shows",
    ...PANEL_ROW,
  },
  {
    method: "GET",
    path: "/api/agent/events",
    // A WebSocket (Upgrade: websocket, as the panel asks) or server-sent events, to that person's pages on this thread only: { type: "agent", ev }
    run: (a) => {
      const headers = new Headers(a.request.headers);
      headers.set("x-erga-login", a.me.login);
      return Effect.map(
        call(() => a.h.fetch(new Request(a.request.url, { headers }))),
        fromWeb
      );
    },
    action: "Your agent's live updates",
    domain: "none",
    exempt: STREAM,
  },
  {
    method: "WS",
    path: "/api/agent/link",
    // Answered before the panel's check (agentApi): its caller is an agent, with a token.
    run: () => link,
    action: "An attached session's link to its person's panel",
    domain: "none",
    exempt: "an attached agent's own connection: the person starts it where the agent runs",
  },
  {
    method: "GET",
    path: "/api/agent/conversation",
    // { log: { items, busy, undoable } }
    run: (a) => call(() => a.h.conversation(a.me.login, docOf(a.url))).pipe(Effect.map((log) => json({ log }))),
    action: "Your agent's conversation, kept",
    ...PANEL_ROW,
  },
  {
    method: "DELETE",
    path: "/api/agent/conversation",
    run: (a) => call(() => a.h.clearConversation(a.me.login, docOf(a.url))).pipe(Effect.map((log) => json({ ok: true, log }))),
    action: "A new conversation with your agent",
    ...PANEL_ROW,
  },
  {
    method: "POST",
    path: "/api/agent/keys",
    // { name, value }: the person's own API key for a provider (Settings, Agent), in place of the one there was; a
    // secret, so set only here (whoami, revoke list and remove them). The answer has its last four characters, never the key.
    run: (a) =>
      Effect.gen(function* () {
        const b = yield* body(a.request, KeyBody, {});
        // A key that its provider refuses isn't kept: the answer has the provider's own reason.
        return yield* Effect.tryPromise({
          try: () => a.platform.directory.personKeys.set({ login: a.me.login }, b.name ?? "", b.value ?? ""),
          catch: (e) => (e instanceof Error ? e.message : String(e)),
        }).pipe(
          Effect.map((key) => json({ ok: true, key })),
          Effect.catch((error) => Effect.succeed(json({ ok: false, error }, 400)))
        );
      }),
    action: "Add or replace your own API key (Settings, Agent)",
    domain: "none",
    exempt: SECRET,
  },
];
