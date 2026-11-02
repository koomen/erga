// A page's model (server/directory/page-llm.ts): each call is logged as it starts, gets its tokens when it ends, and
// counts against the visitor's hour and the server's; a call older than the hour counts no more.

import { expect, test } from "bun:test";
import { PageLlm, PAGE_LLM_LIMITS, underLimit } from "../server/directory/index.ts";
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
