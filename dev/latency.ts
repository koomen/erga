// A network's delay on the room's sockets, for the dev server only (ERGA_DEV_LATENCY_MS): every byte between a tab
// and the room waits that long, each way, as it would between a browser and a deployed Worker. A range ("60-180")
// gives each chunk its own delay in it; bytes still arrive in the order they were sent, as on TCP.
//
// It works on the TCP socket under the WebSocket, before the Cloudflare plugin takes it: the Worker's code never
// sees it, so it can't be on in a deployment.

import type { Server } from "node:http";
import type { Duplex } from "node:stream";

/** "120" or "60-180" (ms) as [min, max]; null if unset or not a delay. */
export function latencyOf(setting: string | undefined): [number, number] | null {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(setting ?? "");
  if (!m) return null;
  const min = Number(m[1]),
    max = Number(m[2] ?? m[1]);
  return max > 0 && min <= max ? [min, max] : null;
}

/** Runs each call `range` ms later, in the order of the calls. */
function line([min, max]: [number, number]) {
  let last = 0;
  return (f: () => void) => {
    last = Math.max(last, Date.now() + min + Math.random() * (max - min));
    setTimeout(f, last - Date.now());
  };
}

/** Delays the room's sockets (/api/room) on `server` by `range`, both ways. */
export function delayRooms(server: Server, range: [number, number]): void {
  server.prependListener("upgrade", (req, socket: Duplex) => {
    if (!new URL(req.url ?? "", "http://x").pathname.endsWith("/api/room")) return;
    const out = line(range),
      into = line(range);
    const write = socket.write.bind(socket) as (...a: unknown[]) => boolean;
    socket.write = ((...a: unknown[]) => (
      out(() => {
        if (!socket.destroyed) write(...a);
      }),
      true
    )) as typeof socket.write;
    const emit = socket.emit.bind(socket) as (e: string | symbol, ...a: unknown[]) => boolean;
    socket.emit = ((e: string | symbol, ...a: unknown[]) => {
      if (e != "data" && e != "end") return emit(e, ...a);
      into(() => emit(e, ...a));
      return true;
    }) as typeof socket.emit;
  });
}
