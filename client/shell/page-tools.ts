// The agent's asks to Erga's page tools in the page (client/page-tools/tools.ts, which the page's first script loads):
// view_page's and eval_in_page's fresh render of a text, and the live page's tools. Everything the page sends back is
// checked: the page itself could have sent it.

import { EVAL_MAX_JSON, FRAMES, viewWait, type ViewRequest, type ViewResult } from "../../shared/agent-log";
import type { LiveRequest, LiveResult } from "../../shared/live-page";

export class PageTools {
  private nextId = 1;
  private waiting = new Map<number, (result: unknown) => void>();

  /** `origin`: the frame's (the document's pages origin); a message from anywhere else is not the page's. */
  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly origin: string
  ) {
    window.addEventListener("message", (e) => {
      if (e.source != frame.contentWindow || e.origin != origin) return;
      const m = e.data as { type?: unknown; id?: unknown; result?: unknown } | null;
      if ((m?.type != "erga-captured" && m?.type != "erga-lived") || typeof m.id != "number") return;
      this.waiting.get(m.id)?.(m.result);
      this.waiting.delete(m.id);
    });
  }

  private ask(m: Record<string, unknown>, wait: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, wait);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.frame.contentWindow?.postMessage({ ...m, id }, this.origin);
    });
  }

  /** The agent's request to the live page (shared/live-page.ts): the page answers from its logs, or acts. */
  async live(req: LiveRequest, wait: number): Promise<LiveResult> {
    const frame = { sandbox: this.frame.getAttribute("sandbox"), allow: this.frame.getAttribute("allow") };
    const r = (await this.ask({ type: "erga-live", req, frame }, wait)) as LiveResult | null;
    // (The page could have sent anything: it goes to the agent as data, cut to size by the host.)
    return r && typeof r == "object" ? r : { error: "The page didn't answer in time." };
  }

  /** The agent's look at the page: the page renders `text` afresh. `dir`: another page's folder in the document, for its files' addresses. */
  async capture(req: ViewRequest, text: string, dir?: string): Promise<ViewResult> {
    const r = (await this.ask({ type: "erga-capture", req, text, ...(dir != null ? { dir } : {}) }, viewWait(req))) as ViewResult | null;
    if (!r || typeof r != "object") return { width: 0, height: 0, errors: [], error: "The page didn't send a picture back in time." };
    return {
      ...(typeof r.png == "string" ? { png: r.png } : {}),
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e == "string").slice(0, 50) : [],
      ...(r.viewport && Number.isFinite(r.viewport.width) && Number.isFinite(r.viewport.height)
        ? { viewport: { width: Number(r.viewport.width), height: Number(r.viewport.height) } }
        : {}),
      ...(r.colorScheme == "light" || r.colorScheme == "dark" ? { colorScheme: r.colorScheme } : {}),
      ...(Array.isArray(r.fonts)
        ? {
            fonts: r.fonts
              .filter((f) => f && typeof f.family == "string")
              .slice(0, 10)
              .map((f) => ({
                family: f.family.slice(0, 100),
                ...(typeof f.wanted == "string" ? { wanted: f.wanted.slice(0, 100) } : {}),
                elements: Number(f.elements) || 0,
                tags: Array.isArray(f.tags) ? f.tags.filter((t): t is string => typeof t == "string").slice(0, 5) : [],
              })),
          }
        : {}),
      ...(Array.isArray(r.pending) && r.pending.length
        ? {
            pending: r.pending
              .filter((p): p is string => typeof p == "string")
              .slice(0, 20)
              .map((p) => p.slice(0, 200)),
          }
        : {}),
      ...(typeof r.note == "string" ? { note: r.note } : {}),
      ...(typeof r.error == "string" ? { error: r.error } : {}),
      ...(typeof r.value == "string" ? { value: r.value.slice(0, EVAL_MAX_JSON * FRAMES.count + 1000) } : {}),
      ...(Array.isArray(r.shots)
        ? {
            shots: r.shots
              .filter((x) => x && typeof x.png == "string" && Number.isFinite(x.at))
              .slice(0, FRAMES.count)
              .map((x) => ({ at: Number(x.at), png: x.png })),
          }
        : {}),
      ...(r.step && Number.isInteger(r.step.index) && typeof r.step.number == "string"
        ? {
            step: {
              index: r.step.index,
              number: r.step.number.slice(0, 20),
              count: Number(r.step.count) || 0,
              ...(typeof r.step.label == "string" ? { label: r.step.label.slice(0, 200) } : {}),
            },
          }
        : {}),
    };
  }
}
