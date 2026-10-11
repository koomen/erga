// deploy/relay.ts: a server's events, passed on to Erga's other servers.
import { expect, test } from "bun:test";
import { coalesce, EventRelay, type RelayEvent } from "../deploy/relay";

test("events in a row become fewer: one deploys, one source, a deploy's lines together", () => {
  const out = coalesce([
    { type: "deploys" }, { type: "deploy-log", target: "staging", deployId: "a", lines: [1] }, { type: "deploys" },
    { type: "deploy-log", target: "staging", deployId: "a", lines: [2] }, { type: "deploy-log", target: "staging", deployId: "a", lines: [3] },
    { type: "source", commit: "1" }, { type: "source", commit: "2" }, { type: "deploy-log", target: "staging", deployId: "b", lines: [4] },
  ]);
  expect(out).toEqual([
    { type: "deploy-log", target: "staging", deployId: "a", lines: [1] }, { type: "deploys" },
    { type: "deploy-log", target: "staging", deployId: "a", lines: [2, 3] }, { type: "source", commit: "2" },
    { type: "deploy-log", target: "staging", deployId: "b", lines: [4] },
  ]);
});

test("the relay sends what waits to each peer in one request; a peer that is down throws nowhere", async () => {
  const sent: [string, RelayEvent[]][] = [];
  const relay = new EventRelay({ peers: ["production", "staging"], delayMs: 10, send: async (peer, events) => { sent.push([peer, events]); } });
  relay.push({ type: "deploys" });
  relay.push({ type: "deploy-log", target: "staging", deployId: "a", lines: ["x"] });
  relay.push({ type: "deploys" });
  await new Promise((r) => setTimeout(r, 40));
  const want = [{ type: "deploy-log", target: "staging", deployId: "a", lines: ["x"] }, { type: "deploys" }];
  expect(sent).toEqual([["production", want], ["staging", want]]);
  const none = new EventRelay({ peers: [], send: async () => { throw new Error("never"); } });
  none.push({ type: "deploys" });
  await none.flush();
  const down = new EventRelay({ peers: ["production"], send: async () => { throw new Error("down"); } });
  down.push({ type: "deploys" });
  await down.flush();
});
