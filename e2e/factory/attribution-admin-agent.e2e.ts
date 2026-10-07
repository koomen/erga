// Who did it (#69; tests/attribution.ts): the admin agent.
import { expect, test, until } from "../fixtures";
import { factory, servers } from "./factory";
import { unique, who } from "./who";

test.beforeAll(async () => { await servers.factory(); });

test("the admin agent's role change and task are tester's, via their admin agent: on the task, its log, and the change log", async () => {
  const s = await servers.factory(), w = who(s), f = factory(s);
  await f.on();
  const token = await w.mint(`Attribution ${unique()}`);
  const user = `role-${unique()}`, title = `The admin agent's task ${unique()}`;
  await w.tool(token, "add_user", { login: user });
  await w.adminAgent([
    { tool: "set_user_role", args: { login: user, role: "admin" } },
    { tool: "create_task", args: { title, description: "A note on the front page." } },
    { text: "Done." },
  ]);
  const t = await until(async () => ((await f.api("/tasks")).body as any[]).find((t) => t.title == title), 10_000, "the admin agent adds the task");
  expect([t.by, t.person]).toEqual(["tester, via their admin agent", "tester"]);
  expect(t.log[0].message.startsWith("Added by tester, via their admin agent")).toBe(true);
  const log = await w.changes(token);
  const of = (pred: (c: any) => boolean) => log.find((v) => v.changes.some(pred));
  expect(of((c) => c.user?.login == user && c.user.event == "role")?.via).toBe("their admin agent");
  expect(of((c) => c.task?.id == t.id && c.task.event == "added")?.via).toBe("their admin agent");
});
