// A page's model (server/directory/page-llm.ts): each call is logged as it starts, with the tokens it reserves, gets the
// tokens it used when it ends (page-llm-call.ts), and counts against the visitor's hour, the server's and the day's
// spend limit; a call older than the hour counts no more.

import { expect, test } from "bun:test";
import {
  callStep,
  costOf,
  countedTokens,
  dayStart,
  PageLlm,
  PAGE_LLM_LIMITS,
  PAGE_LLM_PRICES,
  reserve,
  underLimit,
  type CallState,
} from "../server/directory/index.ts";
import { PAGE_LLM_MODELS } from "../shared/models.ts";
import { memory } from "./helpers/memory-sql.ts";

const NONE = { input: 0, output: 0 };
/** A call that starts with no reservation, under a limit it never reaches. */
const begin = async (llm: PageLlm, c: { login: string; docId: string; model: string; now: number }) =>
  (await llm.start({ ...c, reserved: NONE, budget: 1e9 }))!;
const finish = (llm: PageLlm, id: string, used: { input: number; output: number }) =>
  llm.write(id, callStep({ state: "started", reserved: NONE }, { type: "answered", used }));

test("calls count against the visitor's hour and the server's, from the moment they start", async () => {
  const llm = new PageLlm(memory());
  const t = 10 * PAGE_LLM_LIMITS.hour;
  const a = await begin(llm, { login: "Ada", docId: "d1", model: "haiku", now: t - PAGE_LLM_LIMITS.hour - 1 });
  await finish(llm, a, { input: 500, output: 500 });
  const b = await begin(llm, { login: "ada", docId: "d2", model: "haiku", now: t - 10 });
  expect(await llm.used(t, "ADA")).toEqual({ requests: 1, tokens: 0 });
  await finish(llm, b, { input: 100, output: PAGE_LLM_LIMITS.visitor.tokens });
  await begin(llm, { login: "bo", docId: "d1", model: "haiku", now: t - 5 });
  expect(await llm.used(t, "ada")).toEqual({ requests: 1, tokens: 100 + PAGE_LLM_LIMITS.visitor.tokens });
  expect(await llm.used(t)).toEqual({ requests: 2, tokens: 100 + PAGE_LLM_LIMITS.visitor.tokens });
  expect(underLimit(await llm.used(t, "ada"), PAGE_LLM_LIMITS.visitor)).toBe(false);
  expect(underLimit(await llm.used(t, "bo"), PAGE_LLM_LIMITS.visitor)).toBe(true);
  expect(underLimit({ requests: PAGE_LLM_LIMITS.visitor.requests, tokens: 0 }, PAGE_LLM_LIMITS.visitor)).toBe(false);
});

test("signed-out visitors (login ip:...) count together, apart from the signed-in ones", async () => {
  const llm = new PageLlm(memory());
  const t = 10 * PAGE_LLM_LIMITS.hour;
  const a = await begin(llm, { login: "ip:00aa", docId: "home", model: "haiku", now: t - 10 });
  await finish(llm, a, { input: 100, output: 200 });
  await begin(llm, { login: "ip:00bb", docId: "home", model: "haiku", now: t - 5 });
  await begin(llm, { login: "ada", docId: "home", model: "haiku", now: t - 5 });
  await begin(llm, { login: "ip:00cc", docId: "home", model: "haiku", now: t - PAGE_LLM_LIMITS.hour - 1 });
  expect(await llm.usedByGuests(t)).toEqual({ requests: 2, tokens: 300 });
  expect(await llm.used(t, "ip:00aa")).toEqual({ requests: 1, tokens: 300 });
  expect(await llm.used(t)).toEqual({ requests: 3, tokens: 300 });
});

test("the cost estimate: each page model has its price; a model with no known price counts at the highest", () => {
  for (const m of PAGE_LLM_MODELS) expect(PAGE_LLM_PRICES[m]).toBeDefined();
  expect(costOf("haiku", 1_000_000, 1_000_000)).toBeCloseTo(0.6);
  expect(costOf("opus", 10_000, 2_000)).toBeCloseTo(0.08);
  expect(costOf("no-such-model", 1_000_000, 0)).toBe(10);
  expect(costOf("no-such-model", 0, 1_000_000)).toBe(50);
});

test("today's use: calls, tokens and cost since midnight UTC, in total and by document, the costliest first", async () => {
  const llm = new PageLlm(memory());
  const midnight = Date.UTC(2026, 10, 6);
  const call = async (docId: string, model: string, at: number, input: number, output: number) =>
    finish(llm, await begin(llm, { login: "ada", docId, model, now: at }), { input, output });
  await call("d1", "haiku", midnight - 1, 1_000_000, 0);
  await call("d1", "haiku", midnight, 100_000, 20_000);
  await call("d2", "opus", midnight + 60_000, 1_000, 1_000);
  await call("d1", "sonnet", midnight + 120_000, 0, 1_000);
  const now = midnight + 3_600_000;
  const today = await llm.today(now);
  expect(today).toMatchObject({ since: midnight, calls: 3, input: 101_000, output: 22_000 });
  expect(today.cost).toBeCloseTo(0.02 + 0.024 + 0.01);
  expect(today.docs.map((d) => [d.docId, d.calls])).toEqual([
    ["d1", 2],
    ["d2", 1],
  ]);
  expect(today.docs[0].cost).toBeCloseTo(0.02 + 0.01);
  // At midnight UTC the day starts again.
  expect(await llm.today(midnight + 86_400_000)).toMatchObject({ calls: 0, cost: 0, docs: [] });
  expect(dayStart(midnight + 86_400_000 - 1)).toBe(midnight);
});

test("a call's states: it reserves at its start; an answer counts its tokens; a failure keeps the reservation", () => {
  const reserved = reserve(4_001, 1024);
  expect(reserved).toEqual({ input: 1_001, output: 1024 });
  const started: CallState = { state: "started", reserved };
  expect(countedTokens(started)).toEqual(reserved);
  const done = callStep(started, { type: "answered", used: { input: 900, output: 12 } });
  expect(done).toEqual({ state: "finished", used: { input: 900, output: 12 } });
  const failed = callStep(started, { type: "failed" });
  expect(countedTokens(failed)).toEqual(reserved);
  // A call that ended stays as it ended.
  expect(callStep(done, { type: "failed" })).toBe(done);
  expect(callStep(failed, { type: "answered", used: NONE })).toBe(failed);
});

test("a call that fails still counts: its reservation stays in the day's cost and the hour's tokens", async () => {
  const llm = new PageLlm(memory());
  const now = Date.UTC(2026, 10, 6, 12);
  const reserved = { input: 0, output: 1_000_000 };
  const id = (await llm.start({ login: "ada", docId: "d1", model: "haiku", now, reserved, budget: 5 }))!;
  await llm.write(id, callStep({ state: "started", reserved }, { type: "failed" }));
  expect((await llm.today(now)).cost).toBeCloseTo(0.5);
  expect(await llm.used(now + 1, "ada")).toEqual({ requests: 1, tokens: 1_000_000 });
});

test("the daily spend limit: calls at the same moment can't all pass it; each counts the others' reservations", async () => {
  const llm = new PageLlm(memory());
  const now = Date.UTC(2026, 10, 6, 12);
  // Each reserves $0.40 of Haiku 5.5's output, under a $1 limit: the first three start (0, 0.40, 0.80 < 1), no more.
  const reserved = { input: 0, output: 800_000 };
  const ids = await Promise.all(
    Array.from({ length: 10 }, (_, i) => llm.start({ login: `v${i}`, docId: "d1", model: "haiku", now, reserved, budget: 1 }))
  );
  expect(ids.filter(Boolean).length).toBe(3);
  // A call that answered with fewer tokens gives back the rest of its reservation.
  await llm.write(ids.find(Boolean)!, callStep({ state: "started", reserved }, { type: "answered", used: NONE }));
  expect(await llm.start({ login: "w", docId: "d1", model: "haiku", now, reserved, budget: 1 })).not.toBeNull();
});
