// A document's comments in its Durable Object's SQLite (document/comments.ts), as agents reach them: the person's own
// agent with the edit tool's op comment and the read tool's op comments, and an outside agent over /api/tools with a
// token. The server says who wrote each one, and how; a viewer sees none.

import { expect, servers, test } from "../../helpers/fixtures";
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
