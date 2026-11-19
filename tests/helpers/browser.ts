// The tests' Chromium (dev/browser.ts: started the first time it is asked for) as a browser binding, for a test that
// renders a page as the server does (cloudflare/render.ts). A Worker gets a socket from a fetch; here it is this
// runtime's own.

import { localBrowser, stopLocalBrowser } from "../../dev/browser";
import type { BrowserBinding } from "../../cloudflare/cdp";

export const stopBrowser = stopLocalBrowser;

/** The binding: one session, the Chromium; each connection a socket to its DevTools address. */
export const chromium: BrowserBinding = {
  fetch: async (input, init) => {
    const url = new URL(input);
    if (url.pathname == "/v1/devtools/browser" && init?.method == "POST") return Response.json({ sessionId: "local" });
    if (url.pathname == "/v1/sessions") return Response.json({ sessions: [] });
    const ws = new WebSocket(await localBrowser());
    await new Promise((open, fail) => {
      ws.onopen = open;
      ws.onerror = fail;
    });
    return Object.assign(new Response(null), { webSocket: Object.assign(ws, { accept() {} }) });
  },
};
