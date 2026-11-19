// Why an agent's turn ended with no reply (shared/agent-log.ts, turnEnded): a comment's thread says it. Which tool
// calls have a line in the panel (callShown). What the card of a call that waits for Approve shows (asked).

import { expect, test } from "bun:test";
import { asked, callShown, emptyLog, reduce, turnEnded, type Log, type LogEvent } from "../shared/agent-log.ts";

const log = (...items: Log["items"]): Log => ({ items, busy: false, undoable: 0 });

test("a turn's end says why there's no reply: an error, a call that waits for the person, or none", () => {
  const user = { kind: "user", text: "@erga x" } as const;
  expect(turnEnded(log({ kind: "error", text: "old." }, user, { kind: "assistant", text: "Done." }))).toBe(
    "Its turn ended with no reply here."
  );
  expect(turnEnded(log(user, { kind: "error", text: "The model is overloaded." }))).toBe("It stopped: The model is overloaded.");
  expect(turnEnded(log(user, { kind: "tool", id: "1", name: "edit", path: null, status: "asking" }))).toBe(
    "It waits for your answer in your agent panel."
  );
});

test("the panel has one line for a turn's tool calls: the last call while the turn runs; what the person must see stays", () => {
  const l = emptyLog();
  /** Applies the events; then the items that have a line, each as its text or "name status". */
  const lines = (...evs: LogEvent[]) => {
    for (const ev of evs) reduce(l, ev);
    return l.items.flatMap((it, i) => (!callShown(l, i) ? [] : it.kind == "tool" ? `${it.name} ${it.status}` : it.text));
  };
  const call = (id: string, name: string, status: "running" | "asking" | "done" | "error", more: object = {}): LogEvent => ({
    t: "tool",
    id,
    name,
    path: "index.html",
    status,
    ...more,
  });
  expect(lines({ t: "user", text: "Go" }, { t: "busy", busy: true }, { t: "text", delta: "First." }, call("1", "read", "running"))).toEqual(
    ["Go", "First.", "read running"]
  );
  // A call that ended keeps the line until the next call starts.
  expect(lines(call("1", "read", "done"), { t: "text", delta: "Then." })).toEqual(["Go", "First.", "read done", "Then."]);
  expect(lines(call("2", "edit", "running"))).toEqual(["Go", "First.", "Then.", "edit running"]);
  // A failed call stays until a later call on its file works; a picture stays.
  expect(lines(call("2", "edit", "error"), call("3", "ls", "running"))).toEqual(["Go", "First.", "Then.", "edit error", "ls running"]);
  expect(lines(call("3", "ls", "done"), call("4", "edit", "done"), call("5", "view_page", "done", { image: "data:," }))).toEqual([
    "Go",
    "First.",
    "Then.",
    "view_page done",
  ]);
  // A message during the turn hides the last call that ended, never one that runs. The turn's end removes the line.
  expect(lines(call("6", "grep", "running"), { t: "user", text: "And" }).at(-2)).toBe("grep running");
  expect(lines(call("6", "grep", "done"))).toEqual(["Go", "First.", "Then.", "view_page done", "And"]);
  expect(lines(call("7", "write", "done"), { t: "text", delta: "Done." }, { t: "busy", busy: false })).toEqual([
    "Go",
    "First.",
    "Then.",
    "view_page done",
    "And",
    "Done.",
  ]);
  // A call that waits for the person shows after the run stopped.
  expect(lines(call("8", "delete_document", "asking")).at(-1)).toBe("delete_document asking");
});

test("the card of a call that waits shows the tool's sentence and the whole call: the tool, its op, each argument", () => {
  const call = {
    tool: "documents",
    args: { op: "share_document", login: "*", role: "editor", page_llm: true, list: [1, { a: "<b>" }], none: "" },
  };
  expect(asked({ name: "share_document", detail: "Share /ada/notes with anyone who has the link (editor)", call })).toEqual({
    says: "Share /ada/notes with anyone who has the link (editor)",
    head: "documents share_document",
    args: [
      { key: "login", text: "*", cut: null },
      { key: "role", text: "editor", cut: null },
      { key: "page_llm", text: "true", cut: null },
      { key: "list", text: '[1,{"a":"<b>"}]', cut: null },
      { key: "none", text: '""', cut: null },
    ],
  });
  // A sentence that is only the tool's name (or its op's), or empty, is no sentence: the call stands alone.
  const run = { tool: "run_command", args: { command: "ls -la", op: 3 } };
  for (const detail of ["run_command", " Run_Command ", "", undefined])
    expect(asked({ name: "run_command", detail, call: run })).toEqual({
      says: null,
      head: "run_command",
      args: [
        { key: "command", text: "ls -la", cut: null },
        { key: "op", text: "3", cut: null },
      ],
    });
  expect(asked({ name: "share_document", detail: "share_document", call }).says).toBeNull();
});

test("the card cuts a long argument, with all of it kept; a character that hides or turns the text shows as its code", () => {
  const arg = (value: unknown) => asked({ name: "run", call: { tool: "run", args: { value } } }).args[0];
  const long = `echo ${"x".repeat(200)}; rm -rf notes`;
  expect(arg(long)).toEqual({ key: "value", text: long, cut: long.slice(0, 160) });
  expect(arg("x".repeat(160)).cut).toBeNull();
  // Lines that would push the rest out of sight: four show.
  expect(arg("a\nb\nc\nd\ne; rm -rf notes")).toMatchObject({ text: "a\nb\nc\nd\ne; rm -rf notes", cut: "a\nb\nc\nd" });
  expect(arg("a\nb\tc").cut).toBeNull();
  expect(arg("abc\u202edef\u200b\u001b[8m").text).toBe("abc\\u202edef\\u200b\\u001b[8m");
  expect(asked({ name: "run", detail: "Run \u202eit", call: { tool: "r\u200bun", args: { "k\u2066": 1 } } })).toEqual({
    says: "Run \\u202eit",
    head: "r\\u200bun",
    args: [{ key: "k\\u2066", text: "1", cut: null }],
  });
});
