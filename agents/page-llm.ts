// A document's page calls a model as its signed-in visitor, where its owner turned it on (share_document page_llm): the page's
// script has window.ergaLLM (client/inline/reader.ts), which asks the viewer around it (client/inline/viewer-llm.ts),
// which calls this with the visitor's session. The homepage, on this site itself, calls it directly (server/home/).
//
//   GET  /api/llm                 ?document=<id>: { on, model, signedIn }: whether the page may call the model now (on: the owner
//                                 turned it on, the server's keys run the model, and the visitor may open it), its
//                                 name, and whether the visitor is signed in
//   POST /api/llm                 { document, system?, messages: [{ role: "user" | "assistant", content }], max_tokens? }:
//                                 { text }; or { error, code }: "sign_in" (401), "off" (403), "limit" (429), "error"
//
// The pages origin never gets the session or a key: only this site's own pages may call this (their Origin), with the
// visitor's cookie, for the one document they show. Each call is logged, and counted against the visitor's limits and
// the whole server's (server/directory/page-llm.ts, PAGE_LLM_LIMITS); max_tokens is capped here.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { LanguageModel, Prompt } from "effect/ai";
import { call, ctx, json, type Route } from "../server/http.ts";
import { PAGE_LLM_LIMITS, roleMay, underLimit, type DocRow } from "../server/directory/index.ts";
import { whoOf, type Platform, type Session } from "../server/platform.ts";
import { DEFAULT_PAGE_LLM_MODEL, isPageLlmModel, MODELS, type ModelChoice } from "../shared/models.ts";
import { modelError, pageModel } from "./models.ts";

export const isPageLlmPath = (path: string) => path == "/api/llm";

const Message = Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: Schema.String });
const Ask = Schema.Struct({
  document: Schema.String,
  system: Schema.optionalKey(Schema.String),
  messages: Schema.Array(Message),
  max_tokens: Schema.optionalKey(Schema.Finite),
});
type Ask = typeof Ask.Type;

type Code = "sign_in" | "off" | "limit" | "error";
const STATUS: Record<Code, number> = { sign_in: 401, off: 403, limit: 429, error: 400 };
const fail = (code: Code, error: string, status = STATUS[code]) => json({ error, code }, status);

/** The visitor, in person: test people and agents' tokens have no model here. */
const visitorOf = (s: Session | null) => (s && !s.test && !s.agent ? s : null);

/** What the page may call for `docId` now, as `session` (null: signed out): the model, or why not. */
async function decide(p: Platform, docId: string, session: Session | null): Promise<{ doc: DocRow; model: ModelChoice } | { off: string }> {
  const dir = p.directory;
  const doc = await dir.get(docId);
  const setting = doc ? await dir.pageLlm.setting(doc.id) : null;
  if (!doc || !setting?.on) return { off: "The owner of this page didn't let it call a model." };
  const seen = session
    ? roleMay(await dir.access(whoOf(session), doc), "open")
    : (await dir.homeId()) == doc.id || (await dir.isPublic(doc.id));
  if (!seen) return { off: "The owner of this page didn't let it call a model." };
  const model = setting.model && isPageLlmModel(setting.model) ? setting.model : DEFAULT_PAGE_LLM_MODEL;
  const cfg = await p.agentSettings();
  if ("missing" in cfg || !pageModel(cfg, model, 1)) return { off: `The server has no API key that runs ${MODELS[model].label} now.` };
  return { doc, model };
}

/** The tokens a call may answer: what the page asks, within 1 and the cap. */
const capped = (asked: number | undefined) =>
  Math.max(1, Math.min(PAGE_LLM_LIMITS.maxTokens, Math.floor(asked ?? PAGE_LLM_LIMITS.maxTokens)));

/** What's wrong with an ask's size, or null. */
function tooBig(a: Ask): string | null {
  if (!a.messages.length || a.messages[a.messages.length - 1].role != "user") return "messages must end with the user's.";
  if (a.messages.length > PAGE_LLM_LIMITS.messages) return `At most ${PAGE_LLM_LIMITS.messages} messages.`;
  const chars = (a.system ?? "").length + a.messages.reduce((n, m) => n + m.content.length, 0);
  return chars > PAGE_LLM_LIMITS.inputChars ? `At most ${PAGE_LLM_LIMITS.inputChars} characters in the system prompt and messages.` : null;
}

export const pageLlmApi: Route = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  // Only this site's own pages, with the visitor's cookie: never a token, never another origin (the pages origin is one).
  if (/^Bearer\s/i.test(request.headers.get("authorization") ?? ""))
    return fail("error", "A page calls this as its visitor, in a browser.", 403);
  // (A same-origin GET sends no Origin; another site's can't read the answer, which has no CORS.)
  const from = request.headers.get("origin");
  if (from != url.origin && !(request.method == "GET" && from == null)) return fail("error", "Forbidden", 403);
  const visitor = visitorOf(yield* call(() => platform.sessionOf(request)));
  if (request.method == "GET") {
    const id = url.searchParams.get("document") ?? "";
    const now = yield* call(() => decide(platform, id, visitor));
    return json({ on: "model" in now, model: "model" in now ? MODELS[now.model].label : null, signedIn: !!visitor });
  }
  if (request.method != "POST") return fail("error", "GET or POST", 405);
  const ask = yield* call(() => request.text()).pipe(
    Effect.flatMap((t) => Schema.decodeUnknownEffect(Schema.fromJsonString(Ask))(t)),
    Effect.orElseSucceed(() => null)
  );
  if (!ask) return fail("error", "The body must be { document, system?, messages: [{ role, content }], max_tokens? }.");
  if (!visitor) return fail("sign_in", "Sign in to use this page's model.");
  const now = yield* call(() => decide(platform, ask.document, visitor));
  if ("off" in now) return fail("off", now.off);
  const wrong = tooBig(ask);
  if (wrong) return fail("error", wrong);
  const pageLlm = platform.directory.pageLlm,
    at = Date.now();
  const [mine, all] = yield* call(() => Promise.all([pageLlm.used(at, visitor.login), pageLlm.used(at)]));
  if (!underLimit(mine, PAGE_LLM_LIMITS.visitor))
    return fail("limit", "You reached this hour's limit for pages' models. Try again later.", 429);
  if (!underLimit(all, PAGE_LLM_LIMITS.server))
    return fail("limit", "Pages' models reached this server's limit for this hour. Try again later.", 429);
  const cfg = yield* call(() => platform.agentSettings());
  const layer = "missing" in cfg ? null : pageModel(cfg, now.model, capped(ask.max_tokens));
  if (!layer) return fail("off", `The server has no API key that runs ${MODELS[now.model].label} now.`);
  const id = yield* call(() => pageLlm.start({ login: visitor.login, docId: now.doc.id, model: now.model, now: at }));
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
  if (answer._tag == "Failure") {
    console.log(`page model: ${visitor.login} on ${now.doc.id} (${now.model}) failed: ${modelError(answer.failure)}`);
    return fail("error", `The model failed: ${modelError(answer.failure)}`, 502);
  }
  const { text, input, output } = answer.success;
  yield* call(() => pageLlm.finish(id, { input, output }));
  console.log(`page model: ${visitor.login} on ${now.doc.id} (${now.model}): ${input} in, ${output} out`);
  return json({ text });
});
