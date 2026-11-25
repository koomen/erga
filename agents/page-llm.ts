// The Document LLM API: a document's script calls a model as its viewer, where its author turned the API on
// (share_document llm_api). The page's script has window.ergaLLM (client/inline/reader.ts), which asks the viewer
// around it (client/viewer/viewer.ts), which calls this with the visitor's session. A published site's page, on its
// domain itself, calls it directly (server/sites/).
//
// The routes are ROUTES, below: /api/llm, and the same on a custom domain, for the document published there only.
//
// The pages origin never gets the session or a key: only this site's own pages may call this (their Origin), with the
// visitor's cookie, for the one document they show. Each call is logged, and counted against the visitor's limits and
// the whole server's (server/directory/page-llm.ts, PAGE_LLM_LIMITS); max_tokens is capped here, at the admin's
// document_llm_max_tokens. All the calls of a day (UTC) together stop at the admin's spend limit (document_llm_daily_usd: "limit"; 0: "off"). The admin's other
// settings hold here too, whatever the document's setting says: document_llm_api off gives "off"; a model in
// document_llm_models_off gives "off", with words for the document's author; and document_llm_guests off gives every signed-out
// visitor "sign_in" (on, a published site's visitors may call it also while public sharing is off: its pages are
// always public; a document shared with anyone opens for nobody signed out then).
//
// Where the author lets all viewers call it (llm_api_who "all"), a signed-out visitor may too, on a page anyone may open
// (the document the Erga domain serves, or a document shared with anyone), from the page only: the request must come
// from this site (Origin, and Sec-Fetch-Site when the browser sends it) and carry the page's token
// (server/sites/llm-token.ts: `token`, an hour old at most; a published site's pages and the viewer carry one). Such a
// visitor is counted by their IP address (a hash of it), with the smaller limit `guest`, and all of them together
// with `guests`, so they never use up what the signed-in visitors have.
//
// On a custom domain (Platform's deploy.domains), its pages call /_erga/api/llm there, with the same rules, for the
// document that domain serves only. The visitor there is that domain's cookie (server/identity/domain-pass.ts), never
// the Erga domain's session.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { LanguageModel, Prompt } from "effect/ai";
import { call, ctx, json, type Route } from "../server/http.ts";
import { PAGE_SCRIPT, routeFor, type RouteRow } from "../shared/routes.ts";
import { hex, sha256 } from "../shared/bytes.ts";
import { callerAddress } from "../shared/http.ts";
import {
  callStep,
  ADMIN_OFF,
  modelOff,
  PAGE_LLM_LIMITS,
  reserve,
  roleMay,
  underLimit,
  type CallState,
  type DocRow,
  type PageLlmWho,
} from "../server/directory/index.ts";
import { whoOf, type Platform, type Session } from "../server/platform.ts";
import { domainVisitor, signInChoices } from "../server/identity/index.ts";
import type { SignInChoice } from "../shared/sign-in.ts";
import { domainOf, ERGA, liveDoc, tokenOk } from "../server/sites/index.ts";
import { DEFAULT_PAGE_LLM_MODEL, isModelChoice, MODELS, type ModelChoice } from "../shared/models.ts";
import { modelError, pageModel } from "./models.ts";

export const isPageLlmPath = (path: string) => path == "/api/llm";

/** The API's path on a custom domain. */
export const DOMAIN_LLM_PATH = "/_erga/api/llm";

const Message = Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: Schema.String });
const Ask = Schema.Struct({
  document: Schema.String,
  token: Schema.optionalKey(Schema.String),
  system: Schema.optionalKey(Schema.String),
  messages: Schema.Array(Message),
  max_tokens: Schema.optionalKey(Schema.Finite),
});
type Ask = typeof Ask.Type;

type Code = "sign_in" | "off" | "limit" | "error";
const STATUS: Record<Code, number> = { sign_in: 401, off: 403, limit: 429, error: 400 };
const fail = (code: Code, error: string, status = STATUS[code]) => json({ error, code }, status);

/** The visitor, in person: agents' tokens have no model here. */
const visitorOf = (s: Session | null) => (s && !s.agent ? s : null);

/**
 * What the page may call for `docId` now, as `session` (null: signed out): the model and who may call it, or why not
 * (`unseen`: they may not open it). `live`: the document the request's domain serves, which anyone may open there.
 */
async function decide(
  p: Platform,
  docId: string,
  session: Session | null,
  live: string | null
): Promise<{ doc: DocRow; model: ModelChoice; who: PageLlmWho } | { off: string; unseen?: true }> {
  const dir = p.directory;
  const doc = await dir.get(docId);
  const setting = doc ? await dir.pageLlm.setting(doc.id) : null;
  if (!doc || !setting?.on) return { off: NOT_ON };
  const seen = live == doc.id || (session ? roleMay(await dir.access(whoOf(session), doc), "open") : await dir.isPublic(doc.id));
  if (!seen) return { off: NOT_ON, unseen: true };
  const [enabled, budget, modelsOff] = await Promise.all([
    dir.config.get("document_llm_api"),
    dir.config.get("document_llm_daily_usd"),
    dir.config.get("document_llm_models_off"),
  ]);
  if (!enabled || budget <= 0) return { off: ADMIN_OFF };
  const model = setting.model && isModelChoice(setting.model) ? setting.model : DEFAULT_PAGE_LLM_MODEL;
  const cfg = await p.agentSettings();
  // Off for documents, or for the agents (a model the server doesn't run): the same words.
  if (modelsOff.includes(model) || (!("missing" in cfg) && cfg.off.includes(model))) return { off: modelOff(model) };
  if ("missing" in cfg || !pageModel(cfg, model, 1)) return { off: `The server has no API key that runs ${MODELS[model].label} now.` };
  return { doc, model, who: setting.who };
}

const NOT_ON = "The author of this document didn't turn the Document LLM API on.";

/** Who a signed-out visitor is counted as: "ip:" and a hash of their IP address (the log never keeps the address). */
async function guestOf(request: Request): Promise<string> {
  const ip = callerAddress(request.headers) ?? "unknown";
  return "ip:" + hex((await sha256(ip)).slice(0, 8));
}

/** The tokens a call may answer: what the page asks, within 1 and `most`, the admin's cap (document_llm_max_tokens). */
export const capped = (asked: number | undefined, most: number) => Math.max(1, Math.min(most, Math.floor(asked ?? most)));

/** The characters an ask sends: its system prompt and messages. */
const charsOf = (a: Ask) => (a.system ?? "").length + a.messages.reduce((n, m) => n + m.content.length, 0);

/** What's wrong with an ask's size, or null. */
function tooBig(a: Ask): string | null {
  if (!a.messages.length || a.messages[a.messages.length - 1].role != "user") return "messages must end with the user's.";
  if (a.messages.length > PAGE_LLM_LIMITS.messages) return `At most ${PAGE_LLM_LIMITS.messages} messages.`;
  return charsOf(a) > PAGE_LLM_LIMITS.inputChars
    ? `At most ${PAGE_LLM_LIMITS.inputChars} characters in the system prompt and messages.`
    : null;
}

/** The route, with the visitor from `whoAsks`. On a custom domain, only the document it serves may call its model. */
const pageLlm = (whoAsks: (p: Platform, request: Request) => Promise<Session | null>): Route =>
  Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  // Only this site's own pages, with the visitor's sign-in: never another origin (the pages origin is one), and never
  // an agent's token (the gate keeps the token, and names its agent: `visitorOf` takes an agent for nobody).
  // (A same-origin GET sends no Origin; another site's can't read the answer, which has no CORS.)
  const from = request.headers.get("origin");
  if (from != url.origin && !(request.method == "GET" && from == null)) return fail("error", "Forbidden", 403);
  const visitor = visitorOf(yield* call(() => whoAsks(platform, request)));
  const live = yield* call(() => liveDoc(platform, url));
  const found = routeFor(ROUTES, request.method, url.pathname);
  if (!found) return fail("error", "GET or POST", 405);
  // On a custom domain, the model of the document it serves alone.
  const allowed = (id: string) => domainOf(platform, url) == ERGA || live == id;
  return yield* found.route.run({ request, url, platform, visitor, allowed, live });
  });

/** The visitor who asks (null: signed out), checked to come from this site's own page. */
interface Asked {
  readonly request: Request;
  readonly url: URL;
  readonly platform: Platform;
  readonly visitor: ReturnType<typeof visitorOf>;
  /** Whether this domain's pages may call this document's model. */
  readonly allowed: (id: string) => boolean;
  /** The document this domain serves (its id), or null. */
  readonly live: string | null;
}

/**
 * ?document=<id>: { on, model, signedIn }: whether the page may call the model now (on: the owner turned it on, the
 * server's keys run the model, and the visitor may open it), its name, and whether the visitor is signed in (signed
 * out: and providers, as below).
 */
const status = ({ url, platform, visitor, allowed, live }: Asked): Route =>
  Effect.gen(function* () {
    const id = url.searchParams.get("document") ?? "";
    const now = allowed(id)
      ? yield* call(() => decide(platform, id, visitor, live))
      : { off: "This site's pages call only its own model." };
    const providers = visitor ? {} : { providers: yield* call(() => signInChoices(platform)) };
    return json({ on: "model" in now, model: "model" in now ? MODELS[now.model].label : null, signedIn: !!visitor, ...providers });
  });

/**
 * { document, token?, system?, messages: [{ role: "user" | "assistant", content }], max_tokens? }: { text }; or
 * { error, code }: "sign_in" (401), "off" (403), "limit" (429), "error". "sign_in" has providers: [{ id, label }], the
 * sign-in providers that are on, for the sign-in dialog (client/common/sign-in-dialog.ts).
 */
const askModel = ({ request, platform, visitor, allowed, live }: Asked): Route =>
  Effect.gen(function* () {
  const ask = yield* call(() => request.text()).pipe(
    Effect.flatMap((t) => Schema.decodeUnknownEffect(Schema.fromJsonString(Ask))(t)),
    Effect.orElseSucceed(() => null)
  );
  if (!ask) return fail("error", "The body must be { document, system?, messages: [{ role, content }], max_tokens? }.");
  if (!allowed(ask.document)) return fail("off", "This site's pages call only its own model.");
  const now = yield* call(() => decide(platform, ask.document, visitor, live));
  // Signed out: a guest (their IP address), only where the owner lets all viewers call it and anyone may open the page,
  // from the page itself (its token).
  const guest = !visitor;
  const guestsOn = guest && (yield* call(() => platform.directory.config.get("document_llm_guests")));
  if (guest && (!guestsOn || ("off" in now ? now.unseen : now.who != "all")))
    return json(
      { error: "Sign in to use this document's LLM API.", code: "sign_in", providers: yield* call(() => signInChoices(platform)) },
      401
    );
  if ("off" in now) return fail("off", now.off);
  if (guest) {
    const site = request.headers.get("sec-fetch-site");
    if (site != null && site != "same-origin") return fail("error", "Forbidden", 403);
    if (!(yield* call(() => tokenOk(platform.secret, ask.token, ask.document, Date.now()))))
      return fail("error", "Reload this page to use the Document LLM API.", 403);
  }
  const wrong = tooBig(ask);
  if (wrong) return fail("error", wrong);
  const pageLlm = platform.directory.pageLlm,
    at = Date.now();
  const login = visitor ? visitor.login : yield* call(() => guestOf(request));
  const [mine, guests, all, budget] = yield* call(() =>
    Promise.all([
      pageLlm.used(at, login),
      guest ? pageLlm.usedByGuests(at) : null,
      pageLlm.used(at),
      platform.directory.config.get("document_llm_daily_usd"),
    ])
  );
  if (!underLimit(mine, visitor ? PAGE_LLM_LIMITS.visitor : PAGE_LLM_LIMITS.guest))
    return fail("limit", "You reached this hour's limit for the Document LLM API. Try again later.", 429);
  if (guests && !underLimit(guests, PAGE_LLM_LIMITS.guests))
    return fail(
      "limit",
      "The Document LLM API reached this hour's limit for viewers who aren't signed in. Try again later, or sign in.",
      429
    );
  if (!underLimit(all, PAGE_LLM_LIMITS.server))
    return fail("limit", "The Document LLM API reached this server's limit for this hour. Try again later.", 429);
  const cfg = yield* call(() => platform.agentSettings());
  const maxTokens = capped(ask.max_tokens, yield* call(() => platform.directory.config.get("document_llm_max_tokens")));
  const layer = "missing" in cfg ? null : pageModel(cfg, now.model, maxTokens);
  if (!layer) return fail("off", `The server has no API key that runs ${MODELS[now.model].label} now.`);
  // The call reserves the most it can cost, under the day's spend limit (server/directory/page-llm-call.ts).
  const reserved = reserve(charsOf(ask), maxTokens);
  const id = yield* call(() => pageLlm.start({ login, docId: now.doc.id, model: now.model, now: at, reserved, budget }));
  if (!id) return fail("limit", "The Document LLM API reached this server's spend limit for today. Try again after midnight UTC.", 429);
  const prompt = Prompt.make([
    ...(ask.system ? [{ role: "system" as const, content: ask.system }] : []),
    ...ask.messages.map((m) => ({ role: m.role, content: [{ type: "text" as const, text: m.content }] })),
  ]);
  // The answer's text and the tokens it used, from the model's stream (as the agents read it: agents/run.ts).
  const answer = yield* LanguageModel.streamText({ prompt }).pipe(
    Stream.runFold(
      () => ({ text: "", input: 0, output: 0 }),
      (got, part) =>
        part.type == "text-delta"
          ? { ...got, text: got.text + part.delta }
          : part.type == "finish"
            ? { ...got, input: part.usage.inputTokens.total ?? 0, output: part.usage.outputTokens.total ?? 0 }
            : got
    ),
    Effect.provide(layer),
    Effect.result
  );
  const state: CallState = callStep(
    { state: "started", reserved },
    answer._tag == "Failure"
      ? { type: "failed" }
      : { type: "answered", used: { input: answer.success.input, output: answer.success.output } }
  );
  yield* call(() => pageLlm.write(id, state));
  if (answer._tag == "Failure") {
    console.log(`document LLM API: ${login} on ${now.doc.id} (${now.model}) failed: ${modelError(answer.failure)}`);
    return fail("error", `The model failed: ${modelError(answer.failure)}`, 502);
  }
  const { text, input, output } = answer.success;
  console.log(`document LLM API: ${login} on ${now.doc.id} (${now.model}): ${input} in, ${output} out`);
  return json({ text });
  });

const STATUS_ACTION = "Whether a document's script may call the Document LLM API as its viewer (window.ergaLLM.status)";
const ASK_ACTION = "A document's script calls the Document LLM API as its viewer (window.ergaLLM.ask)";
const ROW = { domain: "none", exempt: PAGE_SCRIPT } as const;

export const ROUTES: readonly RouteRow<(a: Asked) => Route>[] = [
  { method: "GET", path: "/api/llm", run: status, action: STATUS_ACTION, ...ROW },
  { method: "POST", path: "/api/llm", run: askModel, action: ASK_ACTION, ...ROW },
  { method: "GET", path: DOMAIN_LLM_PATH, run: status, action: `${STATUS_ACTION}, on a custom domain`, ...ROW },
  { method: "POST", path: DOMAIN_LLM_PATH, run: askModel, action: `${ASK_ACTION}, on a custom domain`, ...ROW },
];

/** /api/llm, on the app's domain: the visitor is the session. */
export const pageLlmApi = pageLlm((p, request) => p.sessionOf(request));

/** /_erga/api/llm, on a custom domain: the visitor is that domain's cookie (server/identity/domain-pass.ts). */
export const domainLlmApi = pageLlm(domainVisitor);
