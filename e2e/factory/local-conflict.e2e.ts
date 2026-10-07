// A local task whose merge conflicts (tests/factory-local.ts, 7): needs agent, the merge VM stopped, the agent's
// inbox says how; task pull --staging, resolve, task done, and the merge goes on to merged.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";
import { localAgent } from "./local";

await servers.factory();

// Two merge jobs, one after the other, the second across a resolve.
test("two local tasks write the same file; the second's merge conflicts: needs agent (the card says so), the VM stopped, its inbox says how; task pull --staging stops at the conflict; the agent resolves and says done; the merge goes on, and staging has both lines", { timeout: 2 * TASK_MS }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const agent = await localAgent(s);
  const dirB = agent.checkout("one"), dirC = agent.checkout("two");
  const b = agent.register(dirB, "Shared line one", "Write the shared file.");
  const c = agent.register(dirC, "Shared line two", "Write the shared file too.");
  const file = `local-shared-${b}.txt`;
  agent.commit(dirB, file, "line from B\n", "B's line");
  expect(agent.task(dirB, "done", "B writes the shared file.").code).toBe(0);
  agent.commit(dirC, file, "line from C\n", "C's line");
  expect(agent.task(dirC, "done", "C writes the shared file.").code).toBe(0);
  expect((await f.api(`/tasks/${b}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(b, "merged");
  expect((await f.api(`/tasks/${c}/merge`, { method: "POST" })).status).toBe(202);
  await f.until(c, "needs agent");
  const tc = await f.task(c) as any;
  expect(tc.error).toMatch(new RegExp(`conflicts with staging in ${file.replace(".", "\\.")}`));
  expect([tc.vm || null, !!tc.local, tc.waiting]).toEqual([null, true, 1]);
  const bd = await board(tab.page, s.root);
  await until(() => bd.eval(`!!document.querySelector('[data-open="${c}"] .flag')`), 5000, "the card says needs agent");
  const told = agent.task(dirC, "inbox");
  expect(told.out).toContain("task pull --staging");
  expect(told.out).toContain(file);
  const pulled = agent.task(dirC, "pull", "--staging");
  expect(pulled.code).not.toBe(0);
  expect(pulled.out).toContain(`conflicts in: ${file}`);
  writeFileSync(join(dirC, file), "line from B\nline from C\n");
  agent.git(dirC, "add", file);
  expect(agent.git(dirC, "commit", "-q", "--no-edit").status).toBe(0);
  const resolved = agent.task(dirC, "done", "Kept both lines.");
  expect(resolved.code, resolved.out).toBe(0);
  await f.until(c, "merged");
  expect(f.git("log", "-1", "--format=%s", "staging").trim()).toBe(`Merge ${tc.branch}: Shared line two`);
  expect(f.git("show", `staging:${file}`).trim()).toBe("line from B\nline from C");
});
