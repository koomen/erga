// window.ergaLLM, a document's page's model, called as its signed-in visitor (agents/page-llm.ts has the route and the
// limits). The page in the viewer's frame asks the viewer by postMessage (client/inline/reader.ts), which calls the
// route with the visitor's session (client/inline/viewer-llm.ts); the homepage, on the app's own site, calls it itself
// (client/inline/home-llm.ts). Both answer through `llmFetch`, which shows the sign-in dialog there
// (client/common/sign-in-dialog.ts) when someone signed out asks: the page needs no code of its own for it.
//
//   ergaLLM.status()                               { on, model, signedIn }
//   ergaLLM.ask({ system, messages, max_tokens })  { text }; else an Error with .code: "sign_in" | "off" | "limit" | "error"
//   ergaLLM.signIn()                               Erga's sign-in dialog, and back to the same page

export type LlmOp = { op: "status" } | { op: "ask"; system?: unknown; messages?: unknown; max_tokens?: unknown } | { op: "sign-in" };
export type LlmCode = "sign_in" | "off" | "limit" | "error";
export type LlmAnswer = { ok: true; result: unknown } | { ok: false; error: string; code: LlmCode };
export interface LlmStatus {
  on: boolean;
  model: string | null;
  signedIn: boolean;
}
export interface ErgaLLM {
  status(): Promise<LlmStatus>;
  ask(o: { system?: string; messages: { role: "user" | "assistant"; content: string }[]; max_tokens?: number }): Promise<{ text: string }>;
  signIn(): void;
}

declare global {
  interface Window {
    ergaLLM?: ErgaLLM;
  }
}

import type { SignInChoice } from "../../shared/sign-in";
import { showSignIn } from "./sign-in-dialog";

const CODES: LlmCode[] = ["sign_in", "off", "limit", "error"];

/** The page's ergaLLM, over `send` (which answers each op). */
export function makeErgaLLM(send: (op: LlmOp) => Promise<LlmAnswer>): ErgaLLM {
  const run = async (op: LlmOp) => {
    const a = await send(op);
    if (a.ok) return a.result;
    throw Object.assign(new Error(a.error), { code: CODES.includes(a.code) ? a.code : "error" });
  };
  const api: ErgaLLM = {
    status: () => run({ op: "status" }) as Promise<LlmStatus>,
    ask: (o) => run({ op: "ask", system: o?.system, messages: o?.messages, max_tokens: o?.max_tokens }) as Promise<{ text: string }>,
    signIn: () => void send({ op: "sign-in" }),
  };
  return Object.freeze(api);
}

const failed = (error: string, code: LlmCode = "error"): LlmAnswer => ({ ok: false, error, code });

/**
 * One op for document `doc`, on the app's own site, with the visitor's cookie: the route's answer. Signed out, a call
 * (or "sign-in") shows the sign-in dialog, whose choices come back to `back` (the page's address).
 */
export async function llmFetch(doc: string, o: LlmOp, back: string): Promise<LlmAnswer> {
  if (o.op == "sign-in") {
    const s = await route(doc, { op: "status" });
    const providers = s.ok && (s.result as { providers?: SignInChoice[] }).providers;
    if (providers) showSignIn(providers, back);
    return { ok: true, result: null };
  }
  const a = await route(doc, o);
  if (!a.ok) {
    if (a.code == "sign_in") showSignIn(a.providers ?? [], back);
    return failed(a.error, a.code);
  }
  if (o.op != "status") return a;
  const { on, model, signedIn } = a.result as LlmStatus;
  return { ok: true, result: { on, model, signedIn } };
}

/** The route's answer to one op; "sign_in" with the providers that are on. */
async function route(doc: string, o: Exclude<LlmOp, { op: "sign-in" }>): Promise<LlmAnswer & { providers?: SignInChoice[] }> {
  // (Local development's ?user=, the person this tab is.)
  const user = new URLSearchParams(location.search).get("user");
  const as = user ? "user=" + encodeURIComponent(user) : "";
  const r =
    o.op == "status"
      ? await fetch("/api/llm?document=" + encodeURIComponent(doc) + (as ? "&" + as : ""), { credentials: "same-origin" }).catch(() => null)
      : await fetch("/api/llm" + (as ? "?" + as : ""), {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document: doc, system: o.system, messages: o.messages, max_tokens: o.max_tokens }),
        }).catch(() => null);
  if (!r) return failed("Couldn't reach Erga: try again.");
  const body = await r.json().catch(() => null);
  if (!body) return failed(`Erga answered ${r.status}.`);
  return r.ok ? { ok: true, result: body } : { ...failed(String(body.error ?? r.status), body.code), providers: body.providers };
}
