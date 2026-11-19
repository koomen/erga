// A page's WebSockets to Erga's own addresses, in the server's browser. A WebSocket can't be paused as a request can
// (cloudflare/render.ts), so the page gets a socket of ours (client/inline/page-in-process.ts, put into each page before
// its own scripts): what the page does with it comes here through a binding of the browser's, the app answers the
// socket's request in process as it answers any other, and what the socket says goes back into the page. So no socket
// of Erga's goes to the network either. A worker gets none of this: its socket to Erga goes to the network, as nobody.
//
// Trap: who opens a socket is what the browser says: the execution context that called the binding (its frame, its
// origin). Never what the call says: a page's own script may call the binding too, with anything.

import { inlineCall } from "../server/pages/index";
import { base64, fromBase64 } from "../shared/bytes";
import type { OwnAddresses } from "../shared/view-page";
import type { Page } from "./cdp";

const BINDING = "__ergaSocket";
/** The most sockets that one render has open. */
const MAX = 16;

/** Who asks for a socket: the frame and the origin of the page that called, and whether it is in the window's own process (`top`). */
export interface SocketAsk {
  url: URL;
  frame: string;
  origin: string;
  top: boolean;
}

/** The app's end of a socket that it accepted (a Worker's Response.webSocket). */
type Accepted = WebSocket & { accept(): void };

/** `connect`: the app's answer to a socket's request (status 101, with its socket), or null for one that isn't Erga's. */
export function pageSockets(own: OwnAddresses, connect: (ask: SocketAsk) => Promise<Response> | null) {
  const open = new Set<Accepted>();
  /** The sockets open or on their way (MAX), and whether the render is over. */
  let count = 0;
  let over = false;
  const shut = (ws: Accepted, code?: number, reason?: string) => {
    try {
      ws.close(code, reason);
    } catch {
      ws.close();
    }
  };
  return {
    /** Bridges the sockets of a target's pages (the window, a frame of another site), before any of its code runs. */
    async watch(target: Page, top: boolean): Promise<void> {
      /** Each page's own context here: its frame and its origin. */
      const contexts = new Map<number, { frame: string; origin: string }>();
      /** The open sockets, by context and the page's id for it. */
      const mine = new Map<string, Accepted>();
      const gone = (context?: number) => {
        for (const [key, ws] of mine) if (context == null || key.startsWith(`${context}:`)) shut(ws, 1001);
        if (context == null) contexts.clear();
        else contexts.delete(context);
      };
      const called = async (context: number, payload: string): Promise<void> => {
        const from = contexts.get(context);
        const m = JSON.parse(payload) as {
          op?: string;
          id?: unknown;
          url?: unknown;
          text?: unknown;
          bytes?: unknown;
          code?: number;
          reason?: string;
        };
        if (!from || !Number.isSafeInteger(m.id)) return;
        const key = `${context}:${m.id}`;
        const back = (...args: unknown[]) =>
          void target
            .send("Runtime.evaluate", {
              expression: `__ergaSocketIn(${[m.id, ...args].map((a) => JSON.stringify(a)).join(",")})`,
              contextId: context,
            })
            .catch(() => {});
        if (m.op == "send") return mine.get(key)?.send(typeof m.text == "string" ? m.text : fromBase64(String(m.bytes)));
        if (m.op == "close") return void (mine.has(key) && shut(mine.get(key)!, m.code, m.reason));
        if (m.op != "open" || mine.has(key)) return;
        if (over || count >= MAX) return back("close", 1006, "");
        count++;
        const answer = await Promise.resolve(connect({ url: new URL(String(m.url).replace(/^ws/, "http")), ...from, top })).catch(
          () => null
        );
        const ws = (answer as (Response & { webSocket?: Accepted | null }) | null)?.webSocket;
        if (answer?.status != 101 || !ws) {
          count--;
          await answer?.body?.cancel().catch(() => {});
          return back("close", 1006, "");
        }
        ws.accept();
        ws.binaryType = "arraybuffer";
        // (The render ended while the app answered: the socket closes at once.)
        if (over) return (count--, shut(ws, 1001));
        mine.set(key, ws);
        open.add(ws);
        ws.addEventListener("message", (e) =>
          typeof e.data == "string" ? back("message", e.data, false) : back("message", base64(e.data as ArrayBuffer), true)
        );
        ws.addEventListener("close", (e) => {
          mine.delete(key);
          if (open.delete(ws)) count--;
          back("close", e.code, e.reason);
        });
        back("open");
      };
      target.on((method, e) => {
        if (method == "Runtime.executionContextCreated") {
          const c = e.context;
          if (c.auxData?.isDefault) contexts.set(c.id, { frame: c.auxData.frameId, origin: c.origin });
        } else if (method == "Runtime.executionContextDestroyed") gone(e.executionContextId);
        else if (method == "Runtime.executionContextsCleared") gone();
        else if (method == "Runtime.bindingCalled" && e.name == BINDING) called(e.executionContextId, e.payload).catch(() => {});
      });
      // (A worker has no pages: it stops here, with no binding. A frame's scripts run only where Page is enabled.)
      await target.send("Page.enable");
      await Promise.all([
        target.send("Runtime.enable"),
        target.send("Runtime.addBinding", { name: BINDING }),
        target.send("Page.addScriptToEvaluateOnNewDocument", { source: inlineCall("page-in-process", own) }),
      ]);
    },
    /** The render is over: every socket closes. */
    close(): void {
      over = true;
      for (const ws of open) shut(ws, 1001);
    },
  };
}
