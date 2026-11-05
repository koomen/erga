// Feedback (server/feedback.ts, server/directory/feedback.ts, send_feedback): kept in the database first, then opened
// as a GitHub issue with no name, on the pretend GitHub (dev/github-mock.ts). A failure keeps the feedback for the next
// try; staging never opens the issues of production's rows; only admins list it.

import { expect, test } from "bun:test";
import { ISSUE_FAILS, ISSUES_TOKEN, mockGithub } from "../dev/github-mock.ts";
import { Directory, NotAllowed } from "../server/directory/index.ts";
import { fileFeedback, githubIssues, issueOf } from "../server/feedback.ts";
import { OPERATIONS, runOperation } from "../server/operations/index.ts";
import type { Platform } from "../server/platform.ts";
import { memory } from "./helpers/memory-sql";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const ada = { login: "ada", admin: true };
const bob = { login: "Bob" };

const REPO = "owner/feedback-repo";

async function setup(token = ISSUES_TOKEN, repo: string | null = REPO) {
  const sql = memory();
  const dir = new Directory(sql, { admins: ["ada"] });
  if (repo) await dir.config.set(ada, "feedback_repository", repo);
  const gh = mockGithub({
    app: { slug: "erga", clientId: "Iv1.x", clientSecret: "s" },
    origin: "https://gh.test",
    callback: "https://erga.test/cb",
  });
  const fetch = ((input: string | URL | Request, init?: RequestInit) =>
    gh.fetch(new Request(input, init)).then((r) => r ?? new Response("", { status: 404 }))) as typeof globalThis.fetch;
  const issues = githubIssues({ api: "https://gh.test/__github/api", web: "https://gh.test/__github", token }, fetch);
  return { sql, dir, gh, issues, opened: () => gh.state.issues[REPO] ?? [] };
}

test("an issue: the start of the text as its title, the text and the feedback's id as its body, the label feedback (and staging on staging)", () => {
  const long = "The share dialog closes when I press Tab in the login field, and then I lose what I typed";
  const issue = issueOf({ id: "fb-abc", text: `  ${long}\nSecond line.\n` }, "production");
  expect(issue.title.length).toBeLessThanOrEqual(60);
  expect(issue.title).toStartWith("The share dialog closes when I press Tab");
  expect(issue.title).toEndWith("…");
  expect(issue.body).toBe(`${long}\nSecond line.\n\n---\nFeedback fb-abc`);
  expect(issue.labels).toEqual(["feedback"]);
  expect(issueOf({ id: "fb-abc", text: "Short" }, "staging")).toMatchObject({ title: "Short", labels: ["feedback", "staging"] });
});

test("sent feedback is kept first, then opened as an issue with no name, and the row keeps the issue's number", async () => {
  const { dir, issues, opened } = await setup();
  const id = await dir.feedback.add(bob, { text: "Make the bars smaller", page: "/bob/plan", target: "production" });
  expect(id).toMatch(/^fb-[a-z0-9]{8}$/);
  expect((await dir.feedback.list(ada))[0]).toMatchObject({ id, login: "bob", page: "/bob/plan", issue: null });
  await fileFeedback(dir, issues, "production");
  expect(opened()).toEqual([
    { number: 1, title: "Make the bars smaller", body: `Make the bars smaller\n\n---\nFeedback ${id}`, labels: [{ name: "feedback" }] },
  ]);
  // No name, login or page in the issue.
  expect(JSON.stringify(opened())).not.toMatch(/bob|plan/i);
  expect((await dir.feedback.list(ada))[0].issue).toBe(1);
  // Opened once: a second try finds nothing to open.
  await fileFeedback(dir, issues, "production");
  expect(opened()).toHaveLength(1);
});

test("if GitHub fails, the feedback stays with no issue, and a later try opens it", async () => {
  const { dir, sql, issues, opened } = await setup("github_pat_wrong");
  await dir.feedback.add(bob, { text: "One", target: "production" });
  await fileFeedback(dir, issues, "production");
  expect(opened()).toEqual([]);
  expect((await dir.feedback.list(ada))[0].issue).toBeNull();
  // A try a minute later, with a token that may.
  sql.db.query("UPDATE feedback SET tried = tried - 61000").run();
  const right = await setup();
  await fileFeedback(dir, right.issues, "production");
  expect(right.opened().map((i) => i.title)).toEqual(["One"]);
  expect((await dir.feedback.list(ada))[0].issue).toBe(1);
}, 15_000);

test("a 5xx from GitHub is tried again, then left for later", async () => {
  const { dir, issues, opened } = await setup();
  await dir.feedback.add(bob, { text: `Broken ${ISSUE_FAILS}`, target: "production" });
  await fileFeedback(dir, issues, "production");
  expect(opened()).toEqual([]);
  expect((await dir.feedback.list(ada))[0].issue).toBeNull();
}, 15_000);

test("a server opens issues only for its own feedback: staging never opens production's", async () => {
  const { dir, issues, opened } = await setup();
  await dir.feedback.add(bob, { text: "Sent on production", target: "production" });
  await dir.feedback.add(bob, { text: "Sent on staging", target: "staging" });
  await fileFeedback(dir, issues, "staging");
  expect(opened().map((i) => [i.title, i.labels.map((l) => l.name)])).toEqual([["Sent on staging", ["feedback", "staging"]]]);
});

test("with no feedback_repository, the feedback stays with no issue; the setting takes only owner/name", async () => {
  const { dir, issues, opened } = await setup(ISSUES_TOKEN, null);
  await dir.feedback.add(bob, { text: "Kept", target: "production" });
  await fileFeedback(dir, issues, "production");
  expect(opened()).toEqual([]);
  expect((await dir.feedback.list(ada))[0].issue).toBeNull();
  await expect(dir.config.set(ada, "feedback_repository", "not a repo")).rejects.toThrow(/owner\/name/);
  expect((await dir.config.set(ada, "feedback_repository", "https://github.com/owner/feedback-repo/")).value).toBe(REPO);
  await fileFeedback(dir, issues, "production");
  expect(opened().map((i) => i.title)).toEqual(["Kept"]);
  expect((await dir.config.set(ada, "feedback_repository", "")).value).toBe("");
});

test("two tries at once open each issue once", async () => {
  const { dir, issues, opened } = await setup();
  for (const text of ["A", "B", "C"]) await dir.feedback.add(bob, { text, target: "" });
  await Promise.all([fileFeedback(dir, issues, ""), fileFeedback(dir, issues, "")]);
  expect(
    opened()
      .map((i) => i.title)
      .sort()
  ).toEqual(["A", "B", "C"]);
});

test("send_feedback keeps the text, the page and how it was sent, answers thanks, and opens the issue after; feedback is for admins", async () => {
  const { dir, issues, opened } = await setup();
  const work: Promise<unknown>[] = [];
  const platform = {
    deploy: { target: "production" },
    edge: { background: (w: Promise<unknown>) => work.push(w) },
    issues,
  } as unknown as Platform;
  const send = OPERATIONS.find((o) => o.name == "send_feedback")!;
  const list = OPERATIONS.find((o) => o.name == "feedback")!;
  await expect(runOperation(send, { text: "  " }, { dir, who: bob, platform })).rejects.toThrow("Write the feedback first.");
  await expect(runOperation(send, { text: "x".repeat(5001) }, { dir, who: bob, platform })).rejects.toThrow(/at most 5000/);
  const answer = (await runOperation(
    send,
    { text: "Love it" },
    { dir, who: { ...bob, via: "their agent" }, platform, here: "https://erga.test/bob/plan?x=1" }
  )) as {
    sent: boolean;
    id: string;
    message: string;
  };
  expect(answer).toMatchObject({ sent: true, message: expect.stringContaining("Thanks, sent.") });
  await Promise.all(work);
  expect(opened().map((i) => i.body)).toEqual([`Love it\n\n---\nFeedback ${answer.id}`]);
  expect((await dir.feedback.list(ada))[0]).toMatchObject({ page: "/bob/plan", via: "their agent", target: "production", issue: 1 });
  const rows = (await runOperation(list, {}, { dir, who: ada, platform })) as { feedback: { url?: string }[] };
  expect(rows.feedback[0].url).toBe(`https://gh.test/__github/${REPO}/issues/1`);
  await expect(runOperation(list, {}, { dir, who: bob, platform })).rejects.toThrow(/admins only/);
  await expect(dir.feedback.list(bob)).rejects.toThrow(NotAllowed);
});
