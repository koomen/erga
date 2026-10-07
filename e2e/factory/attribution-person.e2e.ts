// Who did it (#69; tests/attribution.ts): in person.
import { expect, test } from "../fixtures";
import { servers } from "./factory";
import { freshHours, SETTING, unique, who } from "./who";

test.beforeAll(async () => { await servers.factory(); });

test("a setting set in person (on /admin) is recorded as tester alone, with no via", async () => {
  const w = who(await servers.factory());
  const token = await w.mint(`Attribution ${unique()}`);
  const hours = freshHours();
  await w.setInPerson(SETTING, hours);
  const v = (await w.changes(token)).find((v) => v.changes.some((c) => c.key == SETTING && c.to == hours));
  expect(v?.by).toBe("tester");
  expect(v?.via).toBeFalsy();
});
