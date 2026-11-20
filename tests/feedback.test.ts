// Feedback (server/directory/feedback.ts, server/operations/feedback.ts): kept in the database, unresolved, for the
// admins and their agents only; an admin says that one is resolved, or not after all. Nothing leaves the server.

import { expect, test } from "bun:test";
import { Directory, NotAllowed } from "../server/directory/index.ts";
import { opsOf, toolsFor } from "../agents/tools.ts";
import { systemPrompt } from "../agents/person/prompt.ts";
import { OPERATIONS, runOperation } from "../server/operations/index.ts";
import { accountMarkup, accountOf } from "../server/pages/index.ts";
import { memory } from "./helpers/memory-sql";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const ada = { login: "ada", admin: true };
const bob = { login: "Bob" };

const op = (name: string) => OPERATIONS.find((o) => o.name == name)!;
const send = op("send_feedback"),
  list = op("feedback"),
  set = op("set_feedback");

function setup() {
  const sql = memory();
  return { sql, dir: new Directory(sql, { admins: ["ada"] }) };
}

test("send_feedback keeps the text, the page and how it was sent, unresolved, and answers thanks; only admins read it, never with a name", async () => {
  const { dir } = setup();
  await expect(runOperation(send, { text: "  " }, { dir, who: bob })).rejects.toThrow("Write the feedback first.");
  await expect(runOperation(send, { text: "x".repeat(5001) }, { dir, who: bob })).rejects.toThrow(/at most 5000/);
  const answer = (await runOperation(
    send,
    { text: "Love it" },
    { dir, who: { ...bob, via: "their agent" }, here: "https://erga.test/bob/plan?x=1" }
  )) as { sent: boolean; id: string; message: string };
  expect(answer).toMatchObject({
    sent: true,
    id: expect.stringMatching(/^fb-[a-z0-9]{8}$/),
    message: expect.stringContaining("Thanks, sent."),
  });
  expect(await dir.feedback.list(ada)).toMatchObject([
    { id: answer.id, text: "Love it", login: "bob", page: "/bob/plan", via: "their agent", status: "unresolved" },
  ]);
  // An admin's agent reads the text, the page, the time and the status: not who sent it.
  const read = (await runOperation(list, {}, { dir, who: ada })) as { feedback: object[] };
  expect(read.feedback).toEqual([{ id: answer.id, text: "Love it", page: "/bob/plan", at: expect.any(String), status: "unresolved" }]);
  expect(JSON.stringify(read)).not.toMatch(/bob"|their agent/i);
  await expect(runOperation(list, {}, { dir, who: bob })).rejects.toThrow(/admins only/);
  await expect(dir.feedback.list(bob)).rejects.toThrow(NotAllowed);
});

test("a feedback is unresolved until an admin resolves it, and unresolved again when they say so; each list has its own, newest first", async () => {
  const { dir } = setup();
  const [a, b, c] = [
    await dir.feedback.add(bob, { text: "A", at: 1000 }),
    await dir.feedback.add(bob, { text: "B", at: 2000 }),
    await dir.feedback.add(bob, { text: "C", at: 3000 }),
  ];
  const texts = async (status?: string) =>
    ((await runOperation(list, status ? { status } : {}, { dir, who: ada })) as { feedback: { text: string }[] }).feedback.map(
      (f) => f.text
    );
  expect(await texts()).toEqual(["C", "B", "A"]);
  expect(await texts("resolved")).toEqual([]);
  // The agent of an admin asks first, in words; then the feedback is in the other list.
  expect(set.asks!({ id: b, status: "resolved" })).toBe(`Mark the feedback ${b} as resolved`);
  expect(await runOperation(set, { id: b, status: "resolved" }, { dir, who: ada })).toMatchObject({ id: b, text: "B", status: "resolved" });
  await runOperation(set, { id: a, status: "resolved" }, { dir, who: ada });
  expect(await texts()).toEqual(["C"]);
  expect(await texts("resolved")).toEqual(["B", "A"]);
  expect(await runOperation(set, { id: b, status: "unresolved" }, { dir, who: ada })).toMatchObject({ status: "unresolved" });
  expect(await texts()).toEqual(["C", "B"]);
  expect(await texts("resolved")).toEqual(["A"]);
  // Only an admin, only a status there is, only a feedback there is.
  await expect(runOperation(set, { id: c, status: "resolved" }, { dir, who: bob })).rejects.toThrow(/admins only/);
  await expect(dir.feedback.setStatus(bob, c, "resolved")).rejects.toThrow(NotAllowed);
  await expect(runOperation(set, { id: c, status: "done" }, { dir, who: ada })).rejects.toThrow("status: unresolved or resolved.");
  await expect(runOperation(list, { status: "all" }, { dir, who: ada })).rejects.toThrow("status: unresolved or resolved.");
  await expect(runOperation(set, { id: "fb-nothere0", status: "resolved" }, { dir, who: ada })).rejects.toMatchObject({
    message: "No feedback fb-nothere0: the operation feedback lists them.",
    status: 404,
  });
  expect(await texts()).toEqual(["C", "B"]);
});

test("a feedback kept before it had a status is unresolved", async () => {
  const { sql, dir } = setup();
  // (As the server before wrote it: the columns of then, and no status.)
  sql.db
    .query("INSERT INTO feedback (id, text, login, target, at, issue, tried) VALUES ('fb-old00000', 'Old', 'bob', '', 500, 7, 600)")
    .run();
  expect(await dir.feedback.list(ada)).toMatchObject([{ id: "fb-old00000", text: "Old", status: "unresolved" }]);
});

test("the setting feedback, off: no menu link, no tool and no word of it in the prompt, a message is refused; the admin still reads the kept ones", async () => {
  const { dir } = setup();
  const caller = { dir, who: bob };
  const ops = async () => (await toolsFor(caller)).flatMap(opsOf);
  const menu = async () => accountMarkup(accountOf({ login: "bob", name: "Bob" }, false, await dir.config.get("feedback")), "/documents");
  // On, the default.
  expect(await dir.config.entry("feedback")).toMatchObject({ value: true, source: "default" });
  expect(await ops()).toContain("send_feedback");
  expect(await menu()).toContain('<a href="#feedback">Send feedback</a>');
  expect(systemPrompt("bob", false, true)).toContain("send_feedback");
  await runOperation(send, { text: "Kept" }, caller);
  // Off.
  await dir.config.set(ada, "feedback", false);
  expect(await ops()).not.toContain("send_feedback");
  expect((await toolsFor(caller)).map((t) => t.description).join(" ")).not.toMatch(/feedback/i);
  expect(await menu()).not.toMatch(/feedback/i);
  expect(systemPrompt("bob", false, false)).not.toMatch(/feedback/i);
  await expect(runOperation(send, { text: "Refused" }, caller)).rejects.toMatchObject({
    message: "Feedback is off on this server.",
    status: 403,
  });
  // The admin's agent still reads the kept ones, and resolves them.
  const admin = { dir, who: ada };
  expect((await toolsFor(admin)).flatMap(opsOf)).toEqual(expect.arrayContaining(["feedback", "set_feedback"]));
  const kept = (await runOperation(list, {}, admin)) as { feedback: { id: string; text: string }[] };
  expect(kept.feedback.map((f) => f.text)).toEqual(["Kept"]);
  expect(await runOperation(set, { id: kept.feedback[0].id, status: "resolved" }, admin)).toMatchObject({ status: "resolved" });
  // On again.
  await dir.config.set(ada, "feedback", true);
  expect(await ops()).toContain("send_feedback");
  await runOperation(send, { text: "Again" }, caller);
  expect((await dir.feedback.list(ada)).map((f) => f.text)).toEqual(["Again"]);
});
