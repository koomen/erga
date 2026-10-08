// Hostile and clumsy clients: garbage on the socket, truncated and corrupt
// Yjs messages, storms of connections, huge edits, bad paths and bad JSON.
// After each, the room must still be up, unchanged by the garbage, and
// syncing for everyone else.

import * as encoding from "lib0/encoding";
import { converged, Participant } from "../client";
import { expect, sleep, until, type Ctx, type Test } from "../harness";
import type { Doc } from "../target";

/** Opens a raw socket to the room, sends `messages`, and closes it. */
async function raw(d: Doc, messages: (Uint8Array | string)[], opts: { holdMs?: number } = {}): Promise<{ closeCode: number | null }> {
  const ws = new WebSocket(`${d.roomUrl}/${d.roomName}`, Object.keys(d.headers).length ? ({ headers: d.headers } as unknown as string[]) : undefined);
  ws.binaryType = "arraybuffer";
  let closeCode: number | null = null;
  const closed = new Promise<void>((r) => ws.addEventListener("close", (e) => { closeCode = e.code; r(); }));
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("socket error"))); });
  for (const m of messages) ws.send(m as string | ArrayBuffer);
  await Promise.race([closed, sleep(opts.holdMs ?? 300)]);
  if (ws.readyState == WebSocket.OPEN) ws.close();
  return { closeCode };
}

/** The room is up, holds `expected`, and still carries a fresh edit between two newcomers. */
async function stillHealthy(ctx: Ctx, d: Doc, expected?: string) {
  const r = await d.fetch("/api/doc");
  expect(r.ok, `the server still answers (${r.status})`);
  const [x, y] = [await Participant.join(d, "Xavier"), await Participant.join(d, "Yan")];
  ctx.defer(() => { x.destroy(); y.destroy(); });
  if (expected != null) expect(x.str() == expected, "the room's text is unchanged by the garbage", { got: x.str().slice(0, 200) });
  x.insertAfter("<h1>", "ALIVE ");
  await until(() => y.str().includes("ALIVE "), 3000, "edits still flow");
}

const msg = (...parts: ((e: encoding.Encoder) => void)[]) => { const e = encoding.createEncoder(); for (const p of parts) p(e); return encoding.toUint8Array(e); };

export const robustness: Test[] = [
  {
    name: "random bytes on the socket",
    async run(ctx) {
      const d = await ctx.doc();
      const before = (await Participant.join(d, "Ada"));
      ctx.defer(() => before.destroy());
      const text = before.str();
      for (let i = 0; i < 20; i++) {
        const junk = new Uint8Array(1 + ctx.rng.int(200)).map(() => ctx.rng.int(256));
        await raw(d, [junk], { holdMs: 50 });
      }
      await stillHealthy(ctx, d, text);
    },
  },
  {
    name: "truncated, corrupt and unknown Yjs messages",
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      const text = a.str();
      const bad: Uint8Array[] = [
        msg((e) => encoding.writeVarUint(e, 0)),                                                     // sync, nothing else
        msg((e) => encoding.writeVarUint(e, 0), (e) => encoding.writeVarUint(e, 2)),                 // update, no payload
        msg((e) => encoding.writeVarUint(e, 0), (e) => encoding.writeVarUint(e, 2), (e) => encoding.writeVarUint8Array(e, new Uint8Array([1, 1, 200, 3, 0, 9, 9, 9]))), // corrupt update
        msg((e) => encoding.writeVarUint(e, 0), (e) => encoding.writeVarUint(e, 1), (e) => encoding.writeVarUint8Array(e, new Uint8Array([255, 255, 255, 255, 15]))), // corrupt step 2
        msg((e) => encoding.writeVarUint(e, 1), (e) => encoding.writeVarUint8Array(e, new Uint8Array([5, 1, 2]))), // corrupt awareness
        msg((e) => encoding.writeVarUint(e, 99)),                                                    // unknown type
        msg((e) => encoding.writeVarUint(e, 0), (e) => encoding.writeVarUint(e, 7)),                 // unknown sync step
      ];
      for (const m of bad) await raw(d, [m], { holdMs: 80 });
      await raw(d, ["a text frame, not binary"], { holdMs: 80 });
      await stillHealthy(ctx, d, text);
    },
  },
  {
    name: "a storm of connections opening and dropping",
    timeoutMs: 90_000,
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      ctx.defer(() => a.destroy());
      const n = ctx.long ? 300 : 80;
      const step1 = msg((e) => encoding.writeVarUint(e, 0), (e) => encoding.writeVarUint(e, 0), (e) => encoding.writeVarUint8Array(e, new Uint8Array([0])));
      await Promise.all(Array.from({ length: n }, (_, i) => raw(d, i % 2 ? [step1] : [], { holdMs: ctx.rng.int(100) }).catch(() => null)));
      // And participants that join and vanish without a goodbye.
      for (let i = 0; i < 10; i++) { const p = await Participant.join(d, `Ghost${i}`); p.sever(); }
      await until(() => a.others().length == 0, 35_000, "the ghosts are gone from awareness", () => a.others().map((o) => o.user.name));
      await stillHealthy(ctx, d);
    },
  },
  {
    name: "a megabyte pasted at once reaches everyone and storage",
    timeoutMs: 60_000,
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo")];
      ctx.defer(() => { a.destroy(); b.destroy(); });
      const big = "<p>" + "lorem ipsum dolor sit amet ".repeat(40_000) + "</p>";
      const t0 = performance.now();
      a.insertAfter("</h1>", big);
      await until(() => b.str().length == a.str().length, 15_000, "Bo has it");
      ctx.metric("propagation", performance.now() - t0);
      await until(async () => (await d.stored(d.path))?.text.length == a.str().length, 15_000, "stored");
      await converged([a, b], 5000);
    },
  },
  {
    name: "paths that try to leave the document are refused",
    async run(ctx) {
      const d = await ctx.doc();
      for (const p of ["../../../../etc/passwd", "..%2f..%2f..%2fetc%2fpasswd", "%2e%2e/%2e%2e/etc/passwd", "/etc/passwd", "....//....//etc/passwd", ".git/config"]) {
        const r1 = await d.fetch(`/api/stored/${p}`);
        expect(r1.status >= 400 && r1.status < 500, `GET stored ${p} is refused (${r1.status})`);
        const body = await r1.text();
        expect(!/root:|\[core\]/.test(body), `nothing leaks for ${p}`);
        const r2 = await d.fetch(`/doc/${p}`);
        expect(!/root:|\[core\]/.test(await r2.text()), `/doc/${p} leaks nothing (${r2.status})`);
        const r3 = await d.fetch(`/api/stored/${p}`, { method: "PUT", body: "pwned" });
        expect(r3.status >= 400 && r3.status < 500, `PUT stored ${p} is refused (${r3.status})`);
      }
      await stillHealthy(ctx, d);
    },
  },
  {
    name: "bad requests to the agent's endpoints get errors, not crashes",
    async run(ctx) {
      const d = await ctx.doc();
      for (const [path, body] of [["/api/agent?user=Ada", "not json"], ["/api/agent?user=Ada", "{}"], ["/api/agent?user=Ada", JSON.stringify({ text: 5 })], ["/api/agent/view?user=Ada", "{\"id\": 1}"]] as const) {
        const r = await d.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
        expect(r.status >= 400 && r.status < 500, `POST ${path} ${body} is refused (${r.status})`);
      }
      const huge = await d.fetch("/api/agent?user=" + "x".repeat(5000));
      expect(huge.status < 500, `an absurd user name doesn't crash it (${huge.status})`);
      await stillHealthy(ctx, d);
    },
  },
];
