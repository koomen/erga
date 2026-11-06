// A test sign-in with the values that wait on /admin/auth (apps.ts: pending). The sign-in's state cookie carries the
// client ID it tests (sign-in.ts), so its end knows which values it tested:
//
//   waiting(id) --an admin signed in with id--------------> none (the values are in use: promote)
//   waiting(id) --anyone else, or the provider refused id--> waiting(id) · failed (why: note)
//   waiting(id) --a test of other values ended-------------> waiting(id) (the values changed: no result)
//   none        --a test ended------------------------------> none (nothing waits: no result)
//
// Every end of a test has a result: a new identity or a refused one too. Decides only: no IO.

import type { TestResult } from "./apps.ts";

/** The values that wait for a test sign-in, if any. */
export type PendingTest = { state: "none" } | { state: "waiting"; clientId: string; test?: TestResult };

/** How a test sign-in ended. */
export type TestEnd =
  | { kind: "in"; login: string; admin: boolean }
  | { kind: "new"; handle: string }
  | { kind: "refused"; who: string }
  | { kind: "provider"; error: string };

export type TestEffect = { do: "promote"; login: string } | { do: "note"; result: TestResult } | { do: "stale" };

const ONLY_ADMINS = "only an admin's sign-in puts new values in use.";

/** The pending values' next state when the test of `clientId` ended so, at `at`, and what to do. */
export function testEnded(s: PendingTest, e: { clientId: string; end: TestEnd; at: number }): { next: PendingTest; effect: TestEffect } {
  if (s.state == "none" || s.clientId != e.clientId) return { next: s, effect: { do: "stale" } };
  const { end } = e;
  if (end.kind == "in" && end.admin) return { next: { state: "none" }, effect: { do: "promote", login: end.login } };
  const by = end.kind == "in" ? end.login : end.kind == "new" ? end.handle : end.kind == "refused" ? end.who : undefined;
  const error =
    end.kind == "in"
      ? `${end.login} signed in, but ${ONLY_ADMINS}`
      : end.kind == "new"
        ? `${end.handle} has no account here: ${ONLY_ADMINS}`
        : end.kind == "refused"
          ? `${end.who} may not sign in here: ${ONLY_ADMINS}`
          : end.error;
  const result: TestResult = { at: e.at, ok: false, ...(by ? { by } : {}), error };
  return { next: { ...s, test: result }, effect: { do: "note", result } };
}
