// The log line for a slow D1 query (cloudflare/timing.ts): only slow ones, with D1's own time and its retries, and
// never the parameters.

import { expect, test } from "bun:test";
import { SLOW_QUERY_MS, slowQueryLine } from "../cloudflare/timing.ts";

test("a slow query is one line with its time, D1's time, its attempts and its SQL", () => {
  expect(slowQueryLine(SLOW_QUERY_MS - 1, "SELECT 1")).toBeNull();
  expect(slowQueryLine(4321, "SELECT *\n    FROM users  WHERE login = ?", { duration: 0.234, total_attempts: 3 })).toBe(
    "slow d1 query: 4321ms, sql 0.2ms, 3 attempts: SELECT * FROM users WHERE login = ?"
  );
  expect(slowQueryLine(SLOW_QUERY_MS, "SELECT 1", { total_attempts: 1 })).toBe("slow d1 query: 500ms: SELECT 1");
  expect(slowQueryLine(900, `SELECT '${"x".repeat(300)}'`)!.length).toBe("slow d1 query: 900ms: ".length + 200);
});
