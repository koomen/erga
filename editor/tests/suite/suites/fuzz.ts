// Seeded randomised concurrency: several participants editing at once,
// dropping off the network and editing offline, newcomers joining midway,
// and publishes landing in between. Everyone must end up with the same text,
// storage must end up with it too, and (in the first test) nothing anyone
// did may be lost or come back: every token inserted and not deleted by its
// owner is there exactly once, and nothing else is.
//
// A failure prints its seed; `--seed N` replays the same run.

import { converged, Participant } from "../client";
import { expect, sleep, until, type Ctx, type Test } from "../harness";
import type { Doc } from "../target";

const TOKEN = /⟦[a-z0-9.]+⟧/g;

/** Positions where a token may go: not inside another token, not splitting a surrogate pair. */
function slots(text: string): number[] {
  const inside = new Set<number>();
  for (const m of text.matchAll(TOKEN)) for (let i = m.index! + 1; i < m.index! + m[0].length; i++) inside.add(i);
  const out: number[] = [];
  for (let i = 0; i <= text.length; i++) if (!inside.has(i) && !isLowSurrogate(text.charCodeAt(i))) out.push(i);
  return out;
}
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

async function crowd(d: Doc, n: number): Promise<Participant[]> {
  const ps: Participant[] = [];
  for (let i = 0; i < n; i++) ps.push(await Participant.join(d, `P${i}`));
  return ps;
}

/** Brings everyone back online, waits for convergence and storage, and returns the text. */
async function settle(ctx: Ctx, d: Doc, ps: Participant[]): Promise<string> {
  for (const p of ps) if (!p.connected) await p.reconnect();
  const all = await converged(ps, 20_000);
  const text = all[d.path];
  await until(async () => (await d.stored(d.path))?.text == text, 10_000, "storage matches the room", async () => ({ stored: (await d.stored(d.path))?.text.length, room: text.length }));
  expect((await d.served(d.path)) == text, "the served page matches the room");
  // A newcomer sees exactly the same.
  const late = await Participant.join(d, "Late");
  ctx.defer(() => late.destroy());
  expect(late.str() == text, "a newcomer gets the same text");
  return text;
}

export const fuzz: Test[] = [
  {
    name: "random concurrent edits, offline spells and publishes: nothing lost, nothing resurrected",
    timeoutMs: 120_000,
    async run(ctx) {
      const d = await ctx.doc();
      const n = ctx.long ? 8 : 4, rounds = ctx.long ? 1500 : 300;
      const ps = await crowd(d, n);
      ctx.defer(() => ps.forEach((p) => p.destroy()));
      const live = new Set<string>();       // tokens that must be there at the end
      const owned = new Map<Participant, string[]>(ps.map((p) => [p, []]));
      let counter = 0, offlineEdits = 0, publishes = 0, refusedPublishes = 0;
      for (let r = 0; r < rounds; r++) {
        const p = ctx.rng.pick(ps);
        const roll = ctx.rng();
        if (roll < 0.5) {
          const s = slots(p.str());
          const tok = `⟦${p.me.name.toLowerCase()}.${counter++}⟧`;
          p.insert(ctx.rng.pick(s), tok);
          live.add(tok); owned.get(p)!.push(tok);
          if (!p.connected) offlineEdits++;
        } else if (roll < 0.7) {
          // Delete one of my own tokens that I can see.
          const mine = owned.get(p)!.filter((t) => p.str().includes(t));
          if (mine.length) {
            const tok = ctx.rng.pick(mine);
            p.delete(p.str().indexOf(tok), tok.length);
            live.delete(tok);
            owned.get(p)!.splice(owned.get(p)!.indexOf(tok), 1);
          }
        } else if (roll < 0.76 && p.connected) {
          p.disconnect();
        } else if (roll < 0.86 && !p.connected) {
          await p.reconnect();
        } else if (roll < 0.9) {
          // A publish: the stored file plus one token, conditional on its version.
          const s = await d.stored(d.path);
          if (s) {
            const tok = `⟦pub.${counter++}⟧`;
            const at = ctx.rng.pick(slots(s.text));
            await sleep(ctx.rng.int(500)); // time for the room to move on, so some pushes are stale
            const res = await d.push(d.path, s.text.slice(0, at) + tok + s.text.slice(at), s.etag);
            if (res.ok) { live.add(tok); publishes++; } else { expect(res.status == 412, `a push is taken or refused as stale (got ${res.status})`); refusedPublishes++; }
          }
        }
        if (ctx.rng.chance(0.3)) await sleep(ctx.rng.int(25));
      }
      const text = await settle(ctx, d, ps);
      const found: string[] = text.match(TOKEN) ?? [];
      const dup = found.filter((t, i) => found.indexOf(t) != i);
      const missing = [...live].filter((t) => !found.includes(t));
      const extra = found.filter((t) => !live.has(t));
      ctx.metric("tokens", live.size, "");
      ctx.metric("offline edits", offlineEdits, "");
      ctx.metric("publishes", publishes, "");
      ctx.metric("stale pushes refused", refusedPublishes, "");
      expect(!dup.length, `no token appears twice (seed ${ctx.seed})`, dup);
      expect(!missing.length, `no inserted token is lost (seed ${ctx.seed})`, missing);
      expect(!extra.length, `no deleted token comes back (seed ${ctx.seed})`, extra);
      // Only tokens were ever added or removed, so without them the text is the fixture, exactly:
      // nothing doubled, nothing else lost. (Not "<h1> appears once": a token can land inside "<h1>".)
      const rest = text.replace(TOKEN, "");
      const fixture = d.fixture[d.path];
      const at = [...rest].findIndex((c, i) => c != fixture[i]);
      expect(rest == fixture, `without the tokens the text is the fixture, exactly (seed ${ctx.seed})`, { lengths: [rest.length, fixture.length], firstDifference: at, got: rest.slice(Math.max(0, at - 40), at + 40), want: fixture.slice(Math.max(0, at - 40), at + 40) });
    },
  },
  {
    name: "arbitrary edits (any text, any range, unicode) from many hands converge",
    timeoutMs: 120_000,
    async run(ctx) {
      const d = await ctx.doc();
      const n = ctx.long ? 10 : 5, rounds = ctx.long ? 2000 : 400;
      const ps = await crowd(d, n);
      ctx.defer(() => ps.forEach((p) => p.destroy()));
      const pieces = ["a", " ", "word ", "\n", "<b>x</b>", "é", "日本語", "🙂", "👩‍👩‍👧", "\r\n", "&amp;", "\t", "—"];
      for (let r = 0; r < rounds; r++) {
        const p = ctx.rng.pick(ps), t = p.str();
        const roll = ctx.rng();
        const safe = (i: number) => (isLowSurrogate(t.charCodeAt(i)) ? i - 1 : i);
        if (roll < 0.55) p.insert(safe(ctx.rng.int(t.length + 1)), ctx.rng.pick(pieces));
        else if (roll < 0.9 && t.length > 50) {
          const from = safe(ctx.rng.int(t.length - 1));
          const to = safe(Math.min(t.length, from + 1 + ctx.rng.int(12)));
          if (to > from) p.delete(from, to - from);
        } else if (roll < 0.95 && p.connected) p.disconnect();
        else if (!p.connected) await p.reconnect();
        if (ctx.rng.chance(0.2)) await sleep(ctx.rng.int(15));
      }
      const text = await settle(ctx, d, ps);
      ctx.metric("final length", text.length, "chars");
    },
  },
  {
    name: "newcomers joining in the middle of a burst catch up",
    timeoutMs: 60_000,
    async run(ctx) {
      const d = await ctx.doc();
      const ps = await crowd(d, 3);
      ctx.defer(() => ps.forEach((p) => p.destroy()));
      const typing = (async () => {
        for (let i = 0; i < 200; i++) { const p = ps[i % 3]; p.insert(ctx.rng.pick(slots(p.str())), `⟦b.${i}⟧`); await sleep(3); }
      })();
      for (let k = 0; k < (ctx.long ? 10 : 4); k++) { await sleep(60); ps.push(await Participant.join(d, `New${k}`)); }
      await typing;
      const text = await settle(ctx, d, ps);
      expect((text.match(TOKEN) ?? []).length == 200, "all 200 tokens are there");
    },
  },
];
