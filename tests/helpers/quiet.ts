// For test files whose code logs on purpose: a deploy that fails its health check and rolls back, a
// sign-in with no database. Those lines are expected, and a reader of the test log takes them for
// failures, so such a file calls quietConsole() first: from then to its end, console.log, info, warn
// and error print nothing. A failure still shows, from the test's own expect(). To see the lines
// anyway: ERGA_TEST_LOGS=1 bun test tests/<file>.

import { afterAll, beforeAll, spyOn } from "bun:test";

const METHODS = ["log", "info", "warn", "error"] as const;

export function quietConsole() {
  if (process.env.ERGA_TEST_LOGS == "1") return;
  let spies: { mockRestore(): void }[] = [];
  beforeAll(() => { spies = METHODS.map((m) => spyOn(console, m).mockImplementation(() => {})); });
  afterAll(() => { for (const s of spies) s.mockRestore(); });
}
