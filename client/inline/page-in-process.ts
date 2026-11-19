// What a page in the server's browser has differently (cloudflare/render.ts), since Erga answers that browser's
// requests in process and it asks the network nothing of Erga's. The render runs this in each page before the page's
// own scripts. Never in a person's page.
//
// A WebSocket to one of Erga's own addresses is the render's (cloudflare/render-sockets.ts): a WebSocket can't be
// paused as a request can. What the page does with it goes to the render (`__ergaSocket`, a binding of the
// browser's), and the render calls `__ergaSocketIn` with what comes back. A socket to any other address is the
// browser's own. It is only what Erga's pages use of a WebSocket: the events and their handlers, readyState,
// binaryType, send and close. It has no subprotocol, and a Blob it sends goes after what was sent while it was read.
//
// And the page has no service worker (Erga's keeps a copy for a reload with no connection, which this browser never
// needs): a worker's own requests would be nobody's, the viewer's page among them.

import { isOwn, type OwnAddresses } from "../../shared/view-page";

type In = (id: number, type: "open" | "message" | "close", a?: string | number, b?: string | boolean) => void;

export default function installInProcess(own: OwnAddresses): void {
  const w = window as Window & { __ergaSocket?: (message: string) => void; __ergaSocketIn?: In };
  const tell = w.__ergaSocket;
  if (!tell || w.__ergaSocketIn) return;
  Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => undefined });
  const Native = WebSocket;
  const say = (message: object) => tell(JSON.stringify(message));
  /** The address as a socket's (ws: or wss:), if it is one of Erga's own. */
  const ours = (address: unknown): string | null => {
    try {
      const u = new URL(String(address), document.baseURI);
      u.protocol = u.protocol.replace(/^http/, "ws");
      return isOwn(own, new URL(u.href.replace(/^ws/, "http"))) ? u.href : null;
    } catch {
      return null;
    }
  };
  const base64 = (bytes: Uint8Array) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const sockets = new Map<number, Bridged>();
  let last = 0;

  class Bridged extends EventTarget {
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    binaryType: BinaryType = "blob";
    readonly bufferedAmount = 0;
    readonly extensions = "";
    readonly protocol = "";
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    readonly id = ++last;
    constructor(readonly url: string) {
      super();
      sockets.set(this.id, this);
      say({ op: "open", id: this.id, url });
    }
    send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
      if (this.readyState == 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      if (this.readyState != 1) return;
      const bytes = (b: Uint8Array) => say({ op: "send", id: this.id, bytes: base64(b) });
      if (typeof data == "string") say({ op: "send", id: this.id, text: data });
      else if (data instanceof Blob) void data.arrayBuffer().then((b) => bytes(new Uint8Array(b)));
      else bytes(ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
    }
    close(code = 1000, reason = ""): void {
      if (this.readyState > 1) return;
      this.readyState = 2;
      say({ op: "close", id: this.id, code, reason });
    }
    fire(e: Event): void {
      (this[`on${e.type}` as "onopen"] as ((e: Event) => void) | null)?.call(this, e);
      this.dispatchEvent(e);
    }
  }

  w.__ergaSocketIn = (id, type, a, b) => {
    const s = sockets.get(id);
    if (!s) return;
    if (type == "open") {
      // (Closed by the page while it connected: the render closes it now.)
      if (s.readyState != 0) return say({ op: "close", id, code: 1000, reason: "" });
      s.readyState = 1;
      s.fire(new Event("open"));
    } else if (type == "message") {
      // (While it closes, too: until the close comes back, as a browser's own.)
      if (s.readyState != 1 && s.readyState != 2) return;
      const bytes = () => Uint8Array.from(atob(String(a)), (c) => c.charCodeAt(0));
      s.fire(new MessageEvent("message", { data: !b ? a : s.binaryType == "arraybuffer" ? bytes().buffer : new Blob([bytes()]) }));
    } else {
      sockets.delete(id);
      const opened = s.readyState != 0;
      s.readyState = 3;
      if (!opened) s.fire(new Event("error"));
      s.fire(new CloseEvent("close", { code: Number(a), reason: String(b ?? ""), wasClean: opened }));
    }
  };
  window.WebSocket = new Proxy(Native, {
    construct(_native, [address, protocols]: [string | URL, string | string[] | undefined]) {
      const mine = ours(address);
      return mine ? new Bridged(mine) : new Native(address, protocols);
    },
  });
  // (The class's own name for itself, too.)
  Native.prototype.constructor = window.WebSocket;
}
