// How fast it feels: an edit's trip from one person to another, to a crowd,
// a newcomer's join, and sustained typing from several people at once.
// Thresholds default to something reasonable for the target (tighter
// locally) and can be set with SCRATCHWORK_SUITE_P95_MS.

import { converged, Participant } from "../client";
import { expect, percentile, sleep, until, type Ctx, type Test } from "../harness";

const budget = (ctx: Ctx) => Number(process.env.SCRATCHWORK_SUITE_P95_MS) || (ctx.target.name == "local" ? 60 : 400);

/** Waits for a token to appear in a participant's text and returns when it did. */
function arrival(p: Participant, token: string): Promise<number> {
  return new Promise((resolve) => {
    const t = p.text()!;
    const check = () => { if (t.toString().includes(token)) { t.unobserve(check); resolve(performance.now()); } };
    t.observe(check);
    check();
  });
}

export const latency: Test[] = [
  {
    name: "an edit reaches another person quickly (p50, p95)",
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await Participant.join(d, "Ada"), await Participant.join(d, "Bo")];
      ctx.defer(() => { a.destroy(); b.destroy(); });
      const samples: number[] = [];
      for (let i = 0; i < (ctx.long ? 300 : 60); i++) {
        const tok = `⟦l${i}⟧`;
        const got = arrival(b, tok);
        const t0 = performance.now();
        a.insertAfter("<h1>", tok);
        samples.push((await Promise.race([got, sleep(5000).then(() => Infinity)])) - t0);
        await sleep(10);
      }
      const p95 = percentile(samples, 95);
      ctx.metric("p50", percentile(samples, 50));
      ctx.metric("p95", p95);
      ctx.metric("max", Math.max(...samples));
      expect(p95 <= budget(ctx), `p95 ${Math.round(p95)}ms is within ${budget(ctx)}ms`);
    },
  },
  {
    name: "an edit reaches a crowd of twenty",
    timeoutMs: 90_000,
    async run(ctx) {
      const d = await ctx.doc();
      const a = await Participant.join(d, "Ada");
      const crowd: Participant[] = [];
      for (let i = 0; i < 20; i++) crowd.push(await Participant.join(d, `C${i}`));
      ctx.defer(() => { a.destroy(); crowd.forEach((p) => p.destroy()); });
      const lasts: number[] = [];
      for (let i = 0; i < 15; i++) {
        const tok = `⟦f${i}⟧`;
        const all = Promise.all(crowd.map((p) => arrival(p, tok)));
        const t0 = performance.now();
        a.insertAfter("<h1>", tok);
        lasts.push(Math.max(...(await all)) - t0);
        await sleep(30);
      }
      const p95 = percentile(lasts, 95);
      ctx.metric("last of 20, p50", percentile(lasts, 50));
      ctx.metric("last of 20, p95", p95);
      expect(p95 <= budget(ctx) * 2, `the slowest of twenty gets it within ${budget(ctx) * 2}ms at p95 (got ${Math.round(p95)})`);
    },
  },
  {
    name: "joining a document is quick",
    async run(ctx) {
      const d = await ctx.doc();
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        const p = await Participant.join(d, `J${i}`);
        times.push(performance.now() - t0);
        p.destroy();
      }
      const p95 = percentile(times, 95);
      ctx.metric("join p50", percentile(times, 50));
      ctx.metric("join p95", p95);
      expect(p95 <= budget(ctx) * 5, `join within ${budget(ctx) * 5}ms at p95 (got ${Math.round(p95)})`);
    },
  },
  {
    name: "five people typing for ten seconds: no lag builds up",
    timeoutMs: 90_000,
    async run(ctx) {
      const d = await ctx.doc();
      const ps: Participant[] = [];
      for (let i = 0; i < 5; i++) ps.push(await Participant.join(d, `T${i}`));
      const watcher = await Participant.join(d, "Watcher");
      ctx.defer(() => { ps.forEach((p) => p.destroy()); watcher.destroy(); });
      const lags: number[] = [];
      const sent = new Map<string, number>();
      watcher.text()!.observe((ev) => {
        for (const op of ev.delta) if (typeof op.insert == "string") for (const m of op.insert.matchAll(/⟦t[0-9.]+⟧/g)) { const t = sent.get(m[0]); if (t) lags.push(performance.now() - t); }
      });
      const seconds = ctx.long ? 60 : 10;
      const end = performance.now() + seconds * 1000;
      await Promise.all(ps.map(async (p, k) => {
        // Each person types in their own paragraph, about ten keystrokes a second.
        const anchor = ["Launch notes", "Where the leads go", "Typing never waits", "Faster builds", "</pre>"][k];
        let n = 0;
        while (performance.now() < end) {
          const tok = `⟦t${k}.${n++}⟧`;
          sent.set(tok, performance.now());
          p.insertAfter(anchor, tok);
          await sleep(100);
        }
      }));
      await converged([...ps, watcher], 10_000);
      const first = lags.slice(0, Math.floor(lags.length / 3)), last = lags.slice(-Math.floor(lags.length / 3));
      ctx.metric("keystrokes", lags.length, "");
      ctx.metric("lag p95", percentile(lags, 95));
      ctx.metric("lag p95, first third", percentile(first, 95));
      ctx.metric("lag p95, last third", percentile(last, 95));
      expect(percentile(lags, 95) <= budget(ctx) * 2, `typing lag within ${budget(ctx) * 2}ms at p95`);
      expect(percentile(last, 95) <= Math.max(percentile(first, 95) * 3, budget(ctx)), "lag doesn't grow over time");
      await until(async () => (await d.stored(d.path))?.text == watcher.str(), 10_000, "storage keeps up");
    },
  },
];
