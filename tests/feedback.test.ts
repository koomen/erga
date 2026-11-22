// Feedback (server/directory/feedback.ts, server/operations/feedback.ts): only from someone signed in, kept in the
// database with who sent it, unresolved, for the admins and their agents only; an admin says that one is resolved, or
// not after all. Nothing leaves the server.

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { Directory, NotAllowed } from "../server/directory/index.ts";
import { opsOf, toolsFor } from "../agents/tools.ts";
import { systemPrompt } from "../agents/person/prompt.ts";
import { OPERATIONS, runOperation } from "../server/operations/index.ts";
import { WITH_CONTEXT } from "../server/operations/feedback.ts";
import { accountMarkup, accountOf } from "../server/pages/index.ts";
import { person, server, signedOut } from "./helpers/app";
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

test("send_feedback keeps the text, the page, who sent it and how, unresolved, and answers thanks; only admins read it, with the sender's name and login", async () => {
  const { dir } = setup();
  await dir.users.add(ada, "bob", { name: "Bob Builder" });
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
    message: "Thanks, sent. This server's admins read it, and see that it is from you.",
  });
  expect(await dir.feedback.list(ada)).toMatchObject([
    { id: answer.id, text: "Love it", login: "bob", name: "Bob Builder", page: "/bob/plan", via: "their agent", status: "unresolved" },
  ]);
  // An admin's agent reads who sent it: the name, the login and how.
  const read = (await runOperation(list, {}, { dir, who: ada })) as { feedback: object[] };
  expect(read.feedback).toEqual([
    {
      id: answer.id,
      text: "Love it",
      from: { login: "bob", name: "Bob Builder", via: "their agent" },
      page: "/bob/plan",
      at: expect.any(String),
      status: "unresolved",
    },
  ]);
  await expect(runOperation(list, {}, { dir, who: bob })).rejects.toThrow(/admins only/);
  await expect(dir.feedback.list(bob)).rejects.toThrow(NotAllowed);
});

test("only someone signed in sends feedback: the API and the operation refuse anyone else; the admins' page names the sender", async () => {
  const s = server();
  const call = (headers: Record<string, string>) =>
    s.fetch("/api/tools/send_feedback", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: s.root, ...headers },
      body: JSON.stringify({ text: "The tree is too narrow" }),
    });
  const out = await call(signedOut());
  expect([out.status, await out.json()]).toEqual([401, { ok: false, error: "Sign in first." }]);
  expect(await s.platform.directory.feedback.list({ login: "tester", admin: true })).toEqual([]);
  // The operation, for a caller that is nobody or anyone.
  for (const login of ["", "*"])
    await expect(runOperation(send, { text: "Hello" }, { dir: s.platform.directory, who: { login } })).rejects.toMatchObject({
      message: "Sign in to send feedback.",
      status: 401,
    });
  // Someone signed in: sent, and the admins' page has their name beside the text.
  const cy = await person(s);
  expect((await call({ Cookie: cy.cookie })).status).toBe(200);
  const page = await (await s.fetch("/admin/feedback")).text();
  const row = /<li class="feedback-row"[^]*?<\/li>/.exec(page)![0];
  expect(row).toContain(`<span class="name">${cy.login}</span>`);
  expect(row).toContain("The tree is too narrow");
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
  expect(await runOperation(set, { id: b, status: "resolved" }, { dir, who: ada })).toMatchObject({
    id: b,
    text: "B",
    // (A sender with no account's name: their login.)
    from: { login: "bob", name: "bob" },
    status: "resolved",
  });
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

test("the setting feedback_context, on: a person's own agent's feedback keeps what their editor said of the page, cut to size; the admins read it, the sender hears so; off, or with no page, none", async () => {
  const s = server();
  const dir = s.platform.directory;
  const admin = { login: "tester", admin: true };
  const context = {
    page: "/bob/plan",
    file: "index.html",
    line: 12,
    column: 5,
    html: "<ul>\n<li>Milk</li>\n</ul>",
    htmlFrom: 11,
    keys: "'type:- Milk' Enter Tab",
    view: "1100×800 CSS pixels, light mode",
    problems: ["A <script> failed"],
  };
  const agent = { dir, who: { ...bob, via: "their agent" }, here: "doc1", page: context };
  const sent = (answer: unknown) => answer as { id: string; message: string };
  // Off, the default: the feedback has no context, and no word of one.
  expect(await dir.config.entry("feedback_context")).toMatchObject({ value: false, source: "default" });
  const plain = sent(await runOperation(send, { text: "No indent" }, agent));
  expect(plain.message).toBe("Thanks, sent. This server's admins read it, and see that it is from you.");
  expect(await dir.feedback.list(admin)).toMatchObject([{ id: plain.id, page: null, context: null }]);
  // On: the context is kept, and the feedback's page is the context's.
  await dir.config.set(admin, "feedback_context", true);
  const full = sent(await runOperation(send, { text: "Tab does not indent" }, agent));
  expect(full.message).toBe(`Thanks, sent. This server's admins read it, and see that it is from you. ${WITH_CONTEXT}`);
  const read = (await runOperation(list, {}, { dir, who: admin })) as { feedback: { id: string; page: string | null; context?: object }[] };
  expect(read.feedback.map((f) => [f.id, f.page, f.context])).toEqual([
    [full.id, "/bob/plan", context],
    [plain.id, null, undefined],
  ]);
  // The admins' page shows it under the text, as text.
  const row = /<li class="feedback-row"[^]*?<\/li>/.exec(await (await s.fetch("/admin/feedback")).text())![0];
  expect(row).toContain("<code>index.html</code>, line 12, column 5");
  expect(row).toContain(`<code class="keys">&#39;type:- Milk&#39; Enter Tab</code>`);
  expect(row).toContain("<p>A &lt;script&gt; failed</p>");
  expect(row).toContain("From line 11:<pre>&lt;ul&gt;\n&lt;li&gt;Milk&lt;/li&gt;\n&lt;/ul&gt;</pre>");
  // A page sends what it likes: each part is cut, and what is no context is none. From the dialog (no page): none.
  const long = { ...context, html: "h".repeat(9000), keys: `${"k".repeat(3000)} Tab`, problems: Array(20).fill("p".repeat(900)) };
  await runOperation(send, { text: "Long" }, { ...agent, page: long });
  const [kept] = await dir.feedback.list(admin);
  expect([kept.context!.html.length, kept.context!.keys.length, kept.context!.keys.endsWith(" Tab")]).toEqual([4010, 1500, true]);
  expect(kept.context!.problems.map((p) => p.length)).toEqual(Array(8).fill(500));
  for (const page of [undefined, "text", { ...context, line: "12" }, { page: "/x" }]) {
    const none = sent(await runOperation(send, { text: "None" }, { ...agent, page }));
    expect(none.message).not.toContain(WITH_CONTEXT);
    expect((await dir.feedback.list(admin))[0]).toMatchObject({ id: none.id, context: null });
  }
});

test("a feedback kept before the admins saw names is unresolved, and stays without a name", async () => {
  const { sql, dir } = setup();
  // (As the server before wrote it, under the words "without your name": then the migration that keeps that.)
  sql.db
    .query(
      "INSERT INTO feedback (id, text, login, via, target, at, issue, tried) VALUES ('fb-old00000', 'Old', 'bob', 'their agent', '', 500, 7, 600)"
    )
    .run();
  sql.db.exec(readFileSync(new URL("../server/migrations/0520_feedback_names.sql", import.meta.url), "utf8"));
  expect(await dir.feedback.list(ada)).toMatchObject([
    { id: "fb-old00000", text: "Old", login: "", name: null, via: null, status: "unresolved" },
  ]);
  const read = (await runOperation(list, {}, { dir, who: ada })) as { feedback: { from: unknown }[] };
  expect(read.feedback[0].from).toBeNull();
  expect(JSON.stringify(read)).not.toMatch(/bob|their agent/);
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
