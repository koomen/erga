// A document's comments in its Durable Object's SQLite (document/comments.ts), as agents reach them: the person's own
// agent with the edit tool's op comment and the read tool's op comments, and an outside agent over /api/tools with a
// token. The server says who wrote each one, and how; a viewer sees none. @erga in a person's own comment asks their
// agent, which takes the thread and replies in it, with its person's role.

import { expect, servers, test, until } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";
import { person } from "../versions/versions";
import { site } from "../pages/tree";

await servers.short();

test("agents add, read and answer comments; each says who and how; a viewer sees none", async () => {
  const server = await servers.short();
  const s = await site(server);
  const anchor = { start: btoa("\u0001start"), end: btoa("\u0001end"), quote: "The first page" };
  const calls = await s.agentTurn("Comment on the first line", [
    { tool: "edit", args: { op: "comment", action: "add", page: "index.html", anchor, text: "Say which pages." } },
    { tool: "read", args: { op: "comments" } },
    { text: "Done." },
  ]);
  expect(calls.map((c) => c.status)).toEqual(["done", "done"]);

  // An outside agent with the owner's token reads it back from the object's tables, and replies.
  const read = await s.anyTool("comments", { document: s.id });
  expect(read.ok).toBe(true);
  const [thread] = JSON.parse(read.text).threads;
  expect(thread).toMatchObject({ page: "index.html", anchor, state: "open", created_by: "tester" });
  expect(thread.comments).toMatchObject([{ by: "tester", via: "their agent", text: "Say which pages." }]);
  const replied = JSON.parse(
    (await s.anyTool("comment", { document: s.id, action: "reply", thread: thread.id, text: "Home and About." })).text
  );
  expect(replied.thread.comments[1]).toMatchObject({ by: "tester", via: "a shared agent (Pages test)" });

  // Resolved: gone from the open ones, still there with all.
  await s.anyTool("comment", { document: s.id, action: "resolve", thread: thread.id });
  expect(JSON.parse((await s.anyTool("comments", { document: s.id })).text).threads).toEqual([]);
  expect(JSON.parse((await s.anyTool("comments", { document: s.id, all: true })).text).threads[0].state).toBe("resolved");

  // A viewer, in person: no comments.
  const cy = await person(server, "cy");
  expect((await s.owner.share(s.id, "cy", "viewer")).ok).toBe(true);
  const refused = await runTool(server.root, "comments", { document: s.id }, { cookie: cy.cookie });
  expect([refused.status, refused.error]).toEqual([403, "You can't see or add comments on that document."]);
});

test("@erga in a person's comment: their agent takes the thread and replies in it; a commenter's agent can't edit the text", async () => {
  const server = await servers.short();
  const s = await site(server);
  const cy = await person(server, "cy");
  expect((await s.owner.share(s.id, "cy", "commenter")).ok).toBe(true);
  /** A tool as a person calls it from the page: in person, with their session. */
  const inPerson = async (who: { cookie: string }, name: string, args: Record<string, unknown>) => {
    const r = await runTool(server.root, name, { document: s.id, ...args }, { cookie: who.cookie });
    if (!r.ok) throw new Error(`${name}: ${r.error}`);
    return r.result;
  };
  const comments = (thread: string, n: number) =>
    until(
      async () => {
        const t = (await inPerson(s.owner, "comments", {})).threads.find((x: { id: string }) => x.id == thread);
        return t?.comments.length >= n ? t.comments : null;
      },
      10_000,
      `${n} comments in the thread`
    );

  // The owner asks their agent in a reply. The scripted model's steps ride in the comment, as a person's words would.
  const { thread } = await inPerson(s.owner, "comment", { action: "add", page: "index.html", text: "Is the title right?" });
  const reply = [{ tool: "edit", args: { op: "comment", action: "reply", thread: thread.id, text: "Yes: it names the site." } }];
  const asked = await inPerson(s.owner, "comment", {
    action: "reply",
    thread: thread.id,
    text: `@erga check it @script ${JSON.stringify([...reply, { text: "Replied." }])}`,
  });
  expect(asked.agent).toMatch(/took the thread/);
  expect((await comments(thread.id, 3))[2]).toMatchObject({ by: "tester", via: "their agent", text: "Yes: it names the site." });
  // It ran in the owner's own conversation, as their message.
  expect(
    (await s.agentLog()).items.some(
      (i) => i.kind == "user" && /^In a comment on "Pages test": @erga check it/.test(String((i as { text?: string }).text))
    )
  ).toBe(true);

  // A commenter's agent: its edit of the text is refused, and its reply lands.
  const steps = [
    { tool: "edit", args: { op: "write", files: { "index.html": "<h1>Gone</h1>" } } },
    { tool: "edit", args: { op: "comment", action: "reply", thread: thread.id, text: "I can't edit it, only comment." } },
    { text: "Done." },
  ];
  await inPerson(cy, "comment", { action: "reply", thread: thread.id, text: `@erga fix the title @script ${JSON.stringify(steps)}` });
  expect((await comments(thread.id, 5))[4]).toMatchObject({ by: "cy", via: "their agent", text: "I can't edit it, only comment." });
  const cyLog = (await (await cy.get("/api/agent/conversation")).json()) as { log: { items: { kind: string; status?: string }[] } };
  expect(cyLog.log.items.filter((i) => i.kind == "tool").map((i) => i.status)).toEqual(["error", "done"]);
  expect((await s.anyTool("read", { document: s.id, path: "index.html" })).text).not.toContain("Gone");
});

test("an agent comments on the words it quotes: the document's object gives them positions, or says why not", async () => {
  const server = await servers.short();
  const s = await site(server);
  const add = (quote: string) => ({ tool: "edit", args: { op: "comment", action: "add", page: "index.html", quote, text: "Name them?" } });
  const calls = await s.agentTurn("Comment on the first line", [
    add("Home"),
    add("Porto"),
    add("a document with several"),
    { text: "Done." },
  ]);
  expect(calls.map((c) => c.status)).toEqual(["error", "error", "done"]);

  const [thread] = JSON.parse((await s.anyTool("comments", { document: s.id })).text).threads;
  expect([thread.quote, thread.anchor.quote, typeof thread.anchor.start, typeof thread.anchor.end]).toEqual([
    "a document with several",
    "a document with several",
    "string",
    "string",
  ]);
  // The refusals say what to give instead.
  const refused = await s.anyTool("comment", { document: s.id, action: "add", page: "index.html", quote: "Home", text: "x" });
  expect(refused.text).toMatch(/"Home" is on the page more than one time: give a longer quote/);
  const missing = await s.anyTool("comment", { document: s.id, action: "add", page: "index.html", quote: "Porto", text: "x" });
  expect(missing.text).toMatch(/"Porto" isn't on the page/);
});
