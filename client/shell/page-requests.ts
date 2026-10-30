// The agent's requests to see and use the page, which this tab answers: view_page, and the live page's tools
// (page_console, page_network, page_events, page_inspect, page_click, page_key).

import type { ViewRequest } from "../../shared/agent-log";
import { ConsoleLog, liveWatch, queryConsole, shownInTab, type ConsoleLevel, type LiveRequest, type LiveResult } from "../../shared/live-page";
import { ms } from "../page-editor/timescale";
import { $, type Shell } from "./shell";

// The editor's own console (this window's), from its first line: page_console gives it with the page's ("editor").
const shellConsole = new ConsoleLog(300);
liveWatch({ events: false, net: false, types: [] });
(window as Window & { __ergaLiveTake?: (sink: (kind: string, data: unknown) => void) => void }).__ergaLiveTake?.((kind, data) => {
  const c = data as { level: ConsoleLevel; text: string; at: number };
  if (kind == "console" && typeof c?.text == "string") shellConsole.add(c.level, c.text, "editor", c.at);
});

export function mountPageRequests(shell: Shell) {


  // The agent asks to see the page: the page editor's frame draws it,
  // with the latest edits, and the picture goes back to the agent.
  // No server-side browser: whoever has the editor open is the agent's eyes.
  const captureView = (req: ViewRequest) => shell.page.capture(req);
  async function answerView(id: string, req: ViewRequest) {
    // Render only once this tab has every edit the agent had made when it asked.
    if (req.after) await shell.collab.waitFor(req.after);
    const result = await captureView(req);
    // With several of the person's tabs open, the host takes the focused one's answer (else a visible one's): the page they look at.
    const rank = document.hasFocus() ? 2 : document.visibilityState == "visible" ? 1 : 0;
    await fetch(shell.api("/api/agent/view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...result, page: shell.pagePath, rank, declined: result.error != null }) }).catch(() => {});
  }


  // The agent's page_console, page_network, page_events, page_inspect, page_click and page_key: the page as it runs
  // in this tab (live-page.ts, in the frame). Every tab of the person's answers; the host takes the focused one's,
  // else a visible one's. page_inspect, page_click and page_key show a line here each time, so the person sees what
  // the agent does in their page.
  const liveBar = $("agent-live");
  const liveText = $("agent-live-text");
  let liveTimer = 0;
  /** The bar over the page: the agent's last action there, for a moment. */
  function renderLiveBar(line?: string) {
    clearTimeout(liveTimer);
    liveText.textContent = line ?? "";
    liveBar.hidden = !line;
    if (line) liveTimer = window.setTimeout(() => renderLiveBar(), ms(4000));
  }
  const lineFor = (req: LiveRequest) => req.kind == "click" ? `The agent clicked ${req.selector ?? `the point (${req.x}, ${req.y})`}`
    : req.kind == "key" ? `The agent pressed ${req.key}${req.selector ? ` on ${req.selector}` : ""}`
    : req.kind == "inspect" ? (req.expression ? `The agent inspected the page: ${req.expression.replace(/\s+/g, " ").slice(0, 80)}` : "The agent read the page's media and permissions")
    : "";
  async function answerLive(id: string, req: LiveRequest) {
    const tab = { page: shell.pagePath, visible: document.visibilityState == "visible", focused: document.hasFocus() };
    if (shownInTab(req)) renderLiveBar(lineFor(req));
    const result: LiveResult = await shell.page.live(req, (req.kind == "inspect" ? 20_000 : 8_000));
    if (req.kind == "console" && result.console) {
      // The page's entries and this window's, together.
      const r = queryConsole([...result.console.entries, ...queryConsole(shellConsole.entries(), { ...req, limit: 200 }).entries], req);
      result.console = { entries: r.entries, matched: Math.max(r.matched, result.console.matched), total: result.console.total + shellConsole.total, dropped: result.console.dropped + shellConsole.dropped };
    }
    if (req.kind == "inspect" && Array.isArray(result.inspect?.facts)) {
      const ua = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation;
      result.inspect!.facts = [{ frame: "the editor (the tab itself)", url: location.origin, userActivation: ua ? { isActive: ua.isActive, hasBeenActive: ua.hasBeenActive } : "not supported here", editorFrame: { sandbox: shell.frame.getAttribute("sandbox"), allow: shell.frame.getAttribute("allow") } }, ...result.inspect!.facts as unknown[]];
    }
    const declined = result.error != null;
    const rank = tab.focused ? 2 : tab.visible ? 1 : 0;
    await fetch(shell.api("/api/agent/view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, width: 0, height: 0, errors: [], value: JSON.stringify({ ...result, tab }), declined, rank }) }).catch(() => {});
  }
  return { captureView, answerView, answerLive };
}

export type PageRequests = ReturnType<typeof mountPageRequests>;
