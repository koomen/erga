// The agent's asks to Erga's page tools in the page (client/page-tools/tools.ts, which the page's first script loads):
// the live page's tools. What the page sends back goes to the agent as data: the page itself could have sent it.

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
      if (m?.type != "erga-lived" || typeof m.id != "number") return;
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
}
