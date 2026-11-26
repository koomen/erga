// The blob store on R2 (cloudflare/blobs.ts): a call that R2 fails with a fault of its own goes again after a pause;
// a real refusal fails at once. The bucket is a fake one: it fails the first calls, then works.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { blobsOf, passes, patient } from "../cloudflare/blobs";

/** What R2 answered on 2026-11-26, three times in 0.9 s. */
const fault = (op: string) => new Error(`${op}: We encountered an internal error. Please try again. (10001)`);

/** A bucket in memory that fails the first `faults` calls of each kind with `error`, and counts the calls. */
function fakeBucket(faults: number, error: (op: string) => Error = fault) {
  const data = new Map<string, Uint8Array>(),
    calls = { head: 0, get: 0, put: 0 };
  const failing = (op: keyof typeof calls) => {
    if (calls[op]++ < faults) throw error(op);
  };
  const bucket = {
    head: async (key: string) => {
      failing("head");
      return data.has(key) ? { size: data.get(key)!.length } : null;
    },
    get: async (key: string) => {
      failing("get");
      const b = data.get(key);
      return b ? { size: b.length, body: new Response(b).body, arrayBuffer: async () => b.slice().buffer } : null;
    },
    put: async (key: string, body: Uint8Array) => {
      failing("put");
      data.set(key, body);
    },
  };
  return { env: { FILES: bucket as unknown as R2Bucket }, calls, data };
}

/** Runs a call on a test clock, 250 ms at a time: the clock's time at each try, and how the call ended. */
async function tries(call: () => Promise<unknown>): Promise<{ at: number[]; end: unknown }> {
  const at: number[] = [];
  let now = 0;
  const counted = () => {
    at.push(now);
    return call();
  };
  const turn = Effect.promise(() => new Promise((done) => setImmediate(done)));
  const end = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(patient(counted)));
      for (let exit = fiber.pollUnsafe(); !exit; exit = fiber.pollUnsafe()) {
        yield* turn;
        if (fiber.pollUnsafe()) break;
        // (The clock's time first: the next try runs inside the adjust.)
        now += 250;
        yield* TestClock.adjust("250 millis");
      }
      return yield* fiber.pollUnsafe()!;
    }).pipe(Effect.provide(TestClock.layer()))
  );
  return { at, end: end._tag == "Success" ? end.success : end.failure };
}

test("a head, a get and a put that R2 fails one time with its internal error work on the second try", async () => {
  const { env, calls, data } = fakeBucket(1);
  const blobs = blobsOf(env)!;
  const bytes = new TextEncoder().encode("a picture");
  // (The person's steps: two files, one just after the other.)
  await Promise.all([blobs.put("a".repeat(64), bytes, bytes.length), blobs.put("b".repeat(64), bytes, bytes.length)]);
  expect([...data.keys()].sort()).toEqual([`blobs/${"a".repeat(64)}`, `blobs/${"b".repeat(64)}`]);
  expect(await Promise.all([blobs.head("a".repeat(64)), blobs.head("c".repeat(64)), blobs.bytes("b".repeat(64))])).toEqual([
    { size: bytes.length },
    null,
    bytes,
  ]);
  expect((await blobs.get("a".repeat(64)))?.size).toBe(bytes.length);
  // One failed call of each kind, and no call more than that.
  expect(calls).toEqual({ put: 3, head: 3, get: 3 });
});

test("the tries are 250, 500 and 1000 ms apart; a fault that stays ends as R2's own error after four", async () => {
  let n = 0;
  const twice = await tries(async () => {
    if (n++ < 2) throw fault("head");
    return { size: 7 };
  });
  expect(twice).toEqual({ at: [0, 250, 750], end: { size: 7 } });
  const stays = await tries(async () => {
    throw fault("head");
  });
  expect(stays.at).toEqual([0, 250, 750, 1750]);
  expect((stays.end as Error).message).toBe("head: We encountered an internal error. Please try again. (10001)");
});

test("a real refusal is not tried again: only R2's internal error and its service unavailable pass", async () => {
  const refusal = new Error("put: The SHA-256 checksum you specified did not match what we received. (10037)");
  const refused = await tries(async () => {
    throw refusal;
  });
  expect(refused).toEqual({ at: [0], end: refusal });
  const { env, calls } = fakeBucket(1, () => refusal);
  await expect(blobsOf(env)!.head("a".repeat(64))).rejects.toBe(refusal);
  expect(calls.head).toBe(1);
  expect(
    [
      fault("head"),
      new Error("get: Service unavailable. Please try again. (10043)"),
      refusal,
      new Error("put: Rate limit exceeded. (10058)"),
      new Error("head: Access denied (10003)"),
      new TypeError("Provided readable stream must have a known length"),
      "10001",
    ].map(passes)
  ).toEqual([true, true, false, false, false, false, false]);
});
