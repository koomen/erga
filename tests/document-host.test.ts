// A document's object from an older deploy restarts when a newer Worker calls
// it (cloudflare/document-host.ts): the call goes again, to the new code.

import { describe, expect, test } from "bun:test";
import { DEPLOYED_HEADER, DeployGate, deployedOf, documentHost, STALE, staleResponse, type DocumentStub } from "../cloudflare/document-host";

/**
 * A document's object as Cloudflare runs it across a deploy: it runs deploy
 * `old` until it stops (its gate's `stop`), then `next`. `view` stands for a
 * method only the new code has.
 */
function objects(old: number, next: number) {
  let deploy = old, stops = 0, flushed = 0;
  const log: string[] = [];
  let gate = new DeployGate(deploy, async () => { flushed++; stops++; deploy = next; });
  /** The object running now: after a stop, a new one, with a gate of its own. */
  let running = deploy;
  const stub = (): DocumentStub => {
    if (running != deploy) { running = deploy; gate = new DeployGate(deploy, async () => { stops++; }); }
    return {
      async call(deployed, method, args) {
        if (await gate.stale(deployed)) return STALE;
        log.push(`${running}:${method}`);
        if (method == "view" && running == old) throw new Error(`The RPC receiver does not implement the method "view".`);
        return { method, args, deploy: running };
      },
      async fetch(request) {
        if (await gate.stale(Number(request.headers.get(DEPLOYED_HEADER)) || 0)) return staleResponse();
        log.push(`${running}:fetch ${await request.text()}`);
        return new Response(`from ${running}`);
      },
    };
  };
  return { stub, log, stops: () => stops, flushed: () => flushed };
}

describe("a document's object across a deploy", () => {
  test("an object from the older deploy writes its edits, restarts, and the call reaches the new code", async () => {
    const o = objects(100, 200);
    const answer = await documentHost(o.stub, 200).view(null, { page: "" }) as unknown as { deploy: number };
    expect(answer.deploy).toBe(200);
    expect(o.flushed()).toBe(1);
    // The old object ran nothing: not even the call that made it stop.
    expect(o.log).toEqual(["200:view"]);
  });

  test("a fetch (a tab's socket, an HTTP request) goes again too, with its body", async () => {
    const o = objects(100, 200);
    const r = await documentHost(o.stub, 200).fetch(new Request("https://doc/api/x", { method: "POST", body: "hello" }));
    expect(await r.text()).toBe("from 200");
    expect(o.log).toEqual(["200:fetch hello"]);
  });

  test("an object from the same deploy, or a newer one, runs the call at once", async () => {
    for (const caller of [100, 50]) {
      const o = objects(100, 200);
      await documentHost(o.stub, caller).paths();
      expect(o.stops()).toBe(0);
      expect(o.log).toEqual(["100:paths"]);
    }
  });

  test("many calls at once stop the object once", async () => {
    const o = objects(100, 200);
    const host = documentHost(o.stub, 200);
    await Promise.all([host.paths(), host.index(), host.exists()]);
    expect(o.stops()).toBe(1);
    expect(o.log.every((l) => l.startsWith("200:"))).toBe(true);
  });

  test("an object that still runs the old code after the tries: the call fails, and says why", async () => {
    // Cloudflare hasn't moved it yet: each start is the old code again.
    const stub = (): DocumentStub => ({ call: async () => STALE, fetch: async () => staleResponse() });
    await expect(documentHost(stub, 200).paths()).rejects.toThrow("still runs the code before this deploy");
    expect((await documentHost(stub, 200).fetch(new Request("https://doc/"))).status).toBe(503);
  });

  test("without ERGA_DEPLOYED (local development) nothing is ever stale", async () => {
    expect(deployedOf({})).toBe(0);
    expect(await new DeployGate(0, async () => { throw new Error("no stop"); }).stale(deployedOf({}))).toBe(false);
  });
});
