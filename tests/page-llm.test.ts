// A page's model (server/directory/page-llm.ts): each call is logged as it starts, gets its tokens when it ends, and
// counts against the visitor's hour and the server's; a call older than the hour counts no more.

import { expect, test } from "bun:test";
import { costOf, dayStart, overBudget, PageLlm, PAGE_LLM_LIMITS, PAGE_LLM_PRICES, underLimit } from "../server/directory/index.ts";
import { PAGE_LLM_MODELS } from "../shared/models.ts";
import { memory } from "./helpers/memory-sql.ts";

test("calls count against the visitor's hour and the server's, from the moment they start", async () => {
  const llm = new PageLlm(memory());
  const t = 10 * PAGE_LLM_LIMITS.hour;
  const a = await llm.start({ login: "Ada", docId: "d1", model: "haiku", now: t - PAGE_LLM_LIMITS.hour - 1 });
  await llm.finish(a, { input: 500, output: 500 });
  const b = await llm.start({ login: "ada", docId: "d2", model: "haiku", now: t - 10 });
  expect(await llm.used(t, "ADA")).toEqual({ requests: 1, tokens: 0 });
  await llm.finish(b, { input: 100, output: PAGE_LLM_LIMITS.visitor.tokens });
  await llm.start({ login: "bo", docId: "d1", model: "haiku", now: t - 5 });
  expect(await llm.used(t, "ada")).toEqual({ requests: 1, tokens: 100 + PAGE_LLM_LIMITS.visitor.tokens });
  expect(await llm.used(t)).toEqual({ requests: 2, tokens: 100 + PAGE_LLM_LIMITS.visitor.tokens });
  expect(underLimit(await llm.used(t, "ada"), PAGE_LLM_LIMITS.visitor)).toBe(false);
  expect(underLimit(await llm.used(t, "bo"), PAGE_LLM_LIMITS.visitor)).toBe(true);
  expect(underLimit({ requests: PAGE_LLM_LIMITS.visitor.requests, tokens: 0 }, PAGE_LLM_LIMITS.visitor)).toBe(false);
});

test("signed-out visitors (login ip:...) count together, apart from the signed-in ones", async () => {
  const llm = new PageLlm(memory());
  const t = 10 * PAGE_LLM_LIMITS.hour;
  const a = await llm.start({ login: "ip:00aa", docId: "home", model: "haiku", now: t - 10 });
  await llm.finish(a, { input: 100, output: 200 });
  await llm.start({ login: "ip:00bb", docId: "home", model: "haiku", now: t - 5 });
  await llm.start({ login: "ada", docId: "home", model: "haiku", now: t - 5 });
  await llm.start({ login: "ip:00cc", docId: "home", model: "haiku", now: t - PAGE_LLM_LIMITS.hour - 1 });
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
    llm.finish(await llm.start({ login: "ada", docId, model, now: at }), { input, output });
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

test("the daily spend limit: calls stop once the day's cost reaches it; 0 turns pages' models off", () => {
  expect(overBudget(4.99, 5)).toBe(null);
  expect(overBudget(5, 5)).toBe("limit");
  expect(overBudget(0, 0)).toBe("off");
});
