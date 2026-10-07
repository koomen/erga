// main refuses a red commit on every path, and says why and where (tests/gate.ts); an earlier green commit may go out.
import { expect, servers, test, until } from "../fixtures";
import { admin, gateOf, git, merge, pusher } from "./staging";

await servers.gate();

const RUN_MS = 10_000;

test("a red commit: the API, the dashboard's merge, naming the commit and a git push to main are all refused, saying why", { timeout: 2 * RUN_MS + 15_000 }, async () => {
  const s = await servers.gate(), a = await admin(s), c = await pusher(s, a.token);
  const green = c.push("A change that passes, before a red one");
  const red = c.push("A change that breaks a test [gate-fail]");
  await until(async () => (await gateOf(s, a.token, red)).run?.state == "failed", RUN_MS, "the head's run fails");
  let m = await merge(s, a, "token");
  expect(m.status).toBe(409);
  expect(m.body.error).toContain("failed: e2e/fake-fail.e2e.ts");
  expect(m.body.error).toContain(`/admin/factory#tests-${red.slice(0, 12)}`);
  m = await merge(s, a, "cookie");
  expect(m.status).toBe(409);
  expect(m.body.error).toContain("failed");
  expect((await merge(s, a, "token", { commit: red })).status).toBe(409);
  const pushed = git(c.dir, "push", "origin", "HEAD:main");
  expect(pushed.ok).toBe(false);
  expect(pushed.err).toContain("failed: e2e/fake-fail.e2e.ts");
  expect(c.main()).not.toBe(red);
  // An earlier green commit may go out while staging's head is red.
  await until(async () => (await gateOf(s, a.token, green)).run?.state == "passed" || (await gateOf(s, a.token, green)).run?.state == "cancelled", RUN_MS, "the green commit's run ends");
  if ((await gateOf(s, a.token, green)).run?.state == "cancelled") {
    // The red push came while it ran, and cancelled it: run it again.
    await fetch(`${s.root}/api/gate/${green}/run`, { method: "POST", headers: { Authorization: `Bearer ${a.token}` } });
    await until(async () => (await gateOf(s, a.token, green)).run?.state == "passed", RUN_MS, "the green commit's tests pass");
  }
  m = await merge(s, a, "token", { commit: green });
  expect([m.status, m.body.commit]).toEqual([200, green]);
});

test("the override: never with a token; it needs a reason; an admin in a browser moves main past the gate, and the change log keeps it", { timeout: RUN_MS + 15_000 }, async () => {
  const s = await servers.gate(), a = await admin(s), c = await pusher(s, a.token);
  const red = c.push("Broken, overridden [gate-fail]");
  await until(async () => (await gateOf(s, a.token, red)).run?.state == "failed", RUN_MS, "the head's run fails");
  let m = await merge(s, a, "token", { override: "An emergency, honestly" });
  expect(m.status).toBe(403);
  expect(m.body.error).toContain("browser");
  expect((await merge(s, a, "cookie", { override: "short" })).status).toBe(400);
  const reason = `Hotfix: the outage, tests broken by infra ${red.slice(0, 7)}`;
  m = await merge(s, a, "cookie", { override: reason });
  expect([m.status, m.body.override, m.body.commit]).toEqual([200, true, red]);
  const changes = await (await fetch(`${s.root}/admin/changes`, { headers: { Cookie: a.cookie } })).text();
  expect(changes).toContain("tests overridden");
  expect(changes).toContain(reason);
});
