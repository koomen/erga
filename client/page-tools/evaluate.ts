// Runs the agent's JavaScript expression in a page's window and gives its
// result as JSON (eval_in_page): in view_page's throwaway render (capture.ts),
// or with live, in the live page (live-page-tab.ts).

import { EVAL_MAX_JSON } from "../../shared/agent-log";

// eval_in_page: the agent's expression runs in the same throwaway render
// view_page draws (in the server's browser), so it sees computed styles, fonts and sizes as the page
// has them. Nothing goes back to the document: the render is a copy of its
// text, removed once the result is out, and nothing reads its DOM back.
// The expression gets what the page's own scripts have, no more: this
// origin holds only the document. parent, top, opener and frameElement
// read as null in it, so it doesn't reach into the editor by mistake.
// Only the result's JSON comes back, cut to EVAL_MAX_JSON characters.
// The time limit can't stop an expression that never yields (while (true)):
// it stalls the page, and the server's render (cloudflare/render.ts) or, for the live page, the host gives up.
export async function evaluateIn(win: Window, expr: string, timeoutMs: number, o: { live?: boolean } = {}): Promise<{ value?: string; note?: string; error?: string }> {
  const W = win as Window & typeof globalThis;
  // (A throwaway render loses them for good; the live page keeps its own, and the expression sees them as null only.)
  if (!o.live) for (const k of ["parent", "opener", "frameElement"]) try { Object.defineProperty(W, k, { value: null, configurable: true }); } catch { /* not replaceable here */ }
  const params = ["parent", "top", "opener", "frameElement"];
  let fn: (...a: null[]) => Promise<unknown>;
  try { fn = new W.Function(...params, `return (async () => (${expr}\n))()`) as typeof fn; } catch {
    // Not one expression: statements, with their own return.
    try { fn = new W.Function(...params, `return (async () => {${expr}\n})()`) as typeof fn; } catch (e) { return { error: `The expression doesn't parse: ${(e as Error).message}` }; }
  }
  let timer = 0;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => fn(null, null, null, null)),
      new Promise((_, reject) => { timer = window.setTimeout(() => reject(new EvalTimeout()), timeoutMs); }),
    ]);
    const json = toJSON(value, W);
    if (json.length <= EVAL_MAX_JSON) return { value: json };
    return { value: json.slice(0, EVAL_MAX_JSON), note: `The result is ${json.length} characters of JSON; this is the first ${EVAL_MAX_JSON}. Return less (pick the properties you need).` };
  } catch (e) {
    if (e instanceof EvalTimeout) return { error: `The expression didn't finish within ${timeoutMs} ms.` };
    const err = e as { name?: unknown; message?: unknown } | null;
    return { error: `The expression threw: ${err && typeof err == "object" && "message" in err ? `${String(err.name ?? "Error")}: ${String(err.message)}` : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

class EvalTimeout extends Error {}

/**
 * A value from the page as JSON, whatever it is: elements become a short
 * description (<p#id.class>), lists and sets arrays, computed styles their
 * properties, cycles "[circular]". Stops early once it is far over the cap.
 */
export function toJSON(value: unknown, W: Window & typeof globalThis): string {
  if (value === undefined) return "undefined";
  const seen = new WeakSet<object>();
  let budget = EVAL_MAX_JSON * 4;
  const plain = (x: unknown, depth: number): unknown => {
    if (budget-- <= 0) return "…";
    if (x === null || typeof x == "boolean" || typeof x == "string") return x;
    if (typeof x == "number") return Number.isFinite(x) ? x : String(x);
    if (typeof x == "bigint") return `${x}n`;
    if (typeof x == "undefined") return null;
    if (typeof x == "function") return `[function ${x.name || "anonymous"}]`;
    if (typeof x == "symbol") return x.toString();
    const o = x as object;
    if (seen.has(o)) return "[circular]";
    if (depth > 12) return "[too deep]";
    seen.add(o);
    try {
      if (o instanceof W.Element) return `<${o.localName}${o.id ? `#${o.id}` : ""}${[...o.classList].map((c) => `.${c}`).join("")}>`;
      if (o instanceof W.Node) return o.nodeType == 3 ? `#text ${JSON.stringify((o.textContent ?? "").slice(0, 80))}` : `[${o.nodeName}]`;
      if (o instanceof W.CSSStyleDeclaration) {
        const out: Record<string, string> = {};
        for (let i = 0; i < o.length; i++) out[o[i]] = o.getPropertyValue(o[i]);
        return out;
      }
      if (o instanceof W.FontFace) return { family: o.family, style: o.style, weight: o.weight, status: o.status };
      if (o instanceof W.Error) return { name: o.name, message: o.message };
      if (o instanceof W.Map) return plain(Object.fromEntries([...o.entries()].slice(0, 1000).map(([k, v]) => [String(k), v])), depth + 1);
      if (typeof (o as { toJSON?: unknown }).toJSON == "function") return plain((o as { toJSON(): unknown }).toJSON(), depth + 1);
      if (Array.isArray(o) || (Symbol.iterator in o && typeof o != "string")) {
        const out: unknown[] = [];
        for (const v of o as Iterable<unknown>) { if (out.length >= 1000 || budget <= 0) { out.push("…"); break; } out.push(plain(v, depth + 1)); }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) { if (budget <= 0) { out["…"] = "…"; break; } out[k] = plain((o as Record<string, unknown>)[k], depth + 1); }
      return out;
    } finally {
      seen.delete(o);
    }
  };
  return JSON.stringify(plain(value, 0)) ?? "undefined";
}
