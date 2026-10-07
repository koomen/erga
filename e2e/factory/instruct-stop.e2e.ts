// Instructions to a task whose command runs on (tests/factory-instruct.ts, 2): the command is stopped a while after
// they came (a test hook: 3 s), and the stand-in gets them with why.
import { expect, test } from "../fixtures";
import { factory, servers, TASK_MS } from "./factory";

await servers.factory();

test("a command that runs on is stopped a while after instructions came, and Claude Code gets them with why", { timeout: TASK_MS + 15_000 }, async () => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const b = await f.make("Stop a long command", "Put a note on the front page. [factory-test: long command 600] [factory-test: instructions wait 3]");
  await f.until(b, "working", TASK_MS, (t) => t.log.some((l) => l.message.includes("The stand-in runs a long command")));
  expect((await f.api(`/tasks/${b}/revise`, { json: { instructions: "Say it in French." } })).status).toBe(200);
  await f.until(b, "complete");
  const msgs = await f.msgs(b);
  expect(msgs.some((m) => /Claude Code's command ran for \d+s while instructions waited: stopped, so they reach Claude Code \(Bash: sleep 600\)/.test(m)), msgs.slice(-14).join("\n")).toBe(true);
  expect(msgs.some((m) => m.includes("The stand-in got the instructions: Say it in French. (its command was stopped for them)"))).toBe(true);
});
