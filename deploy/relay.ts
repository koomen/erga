// This server's events (/api/events) passed on to Erga's other servers, so
// each server's Source page shows the other's changes as they happen:
// erga.dev's page shows staging's deploys, which run on staging's server,
// and a push or merge on either server (both share one repository). Each
// server POSTs its own events to the servers it notifies (deploy/targets.json,
// `notifies`) at /api/deploys/events, with the shared secret; the other server
// sends them to its own listeners, and never passes them on again.
//
// Events wait a moment and go together: many "deploys" in a row become one,
// and a deploy's log lines go in one event. A peer that doesn't answer misses
// them: its pages ask for the status again while a deploy runs and no event comes.
//
//   const relay = new EventRelay({ peers: ["staging"], send: (peer, events) => post(peer, events) });
//   relay.push({ type: "deploys" });

import type { TargetName } from "./targets";

export type RelayEvent = { type: string } & Record<string, unknown>;

export interface RelayDeps {
  peers: TargetName[];
  /** Sends events to a peer. */
  send(peer: TargetName, events: RelayEvent[]): Promise<unknown>;
  /** How long events wait for others to go with them. */
  delayMs?: number;
}

/** Many "deploys" or "source" events become the last one; a deploy's log lines in a row become one event. */
export function coalesce(events: RelayEvent[]): RelayEvent[] {
  const out: RelayEvent[] = [];
  for (const e of events) {
    if (e.type == "deploys" || e.type == "source") {
      const i = out.findIndex((o) => o.type == e.type);
      if (i >= 0) out.splice(i, 1);
      out.push(e);
      continue;
    }
    const last = out[out.length - 1];
    if (e.type == "deploy-log" && last?.type == "deploy-log" && last.target == e.target && last.deployId == e.deployId) {
      out[out.length - 1] = { ...last, lines: [...(last.lines as unknown[] ?? []), ...(e.lines as unknown[] ?? [])] };
      continue;
    }
    out.push(e);
  }
  return out;
}

export class EventRelay {
  private queue: RelayEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: RelayDeps) {}

  push(event: RelayEvent): void {
    if (!this.deps.peers.length) return;
    this.queue.push(event);
    this.timer ??= setTimeout(() => { this.timer = null; void this.flush(); }, this.deps.delayMs ?? 250);
  }

  /** Sends what waits now. */
  async flush(): Promise<void> {
    const events = coalesce(this.queue.splice(0));
    if (!events.length) return;
    await Promise.all(this.deps.peers.map((peer) => this.deps.send(peer, events).catch(() => null)));
  }
}
