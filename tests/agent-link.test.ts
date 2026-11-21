// An attached session (agents/link.ts, and its owner in agents/person/sessions.ts): a helper's link to its person's
// agent object. Its first frame names the session; its AG-UI events are the panel's log; the panel's message, its
// answer to a card and its Stop go down the link. A prompt typed in the terminal shows as one. A revoked grant closes
// the link.

import { expect, test } from "bun:test";
import { linkStart, linkStep, type Link, type LinkEffect, type LinkEvent } from "../agents/link.ts";
import { PersonAgents } from "../agents/person/sessions.ts";
import type { Platform } from "../server/platform.ts";
import { objectSql } from "./helpers/memory-sql.ts";

const HELLO = {
  type: "CUSTOM",
  name: "hello",
  value: { session: "s1", agent: "Claude Code", where: "ada-laptop, ~/trip", model: "Fable 5.2" },
};
const frame = (value: unknown): LinkEvent => ({ e: "frame", text: JSON.stringify(value) });

function play(link: Link, ...events: LinkEvent[]): { link: Link; effects: LinkEffect[] } {
  const effects: LinkEffect[] = [];
  for (const ev of events) {
    const r = linkStep(link, ev);
    link = r.link;
    effects.push(...r.effects);
  }
  return { link, effects };
}

test("the first frame names the session; a link that breaks the protocol closes", () => {
  const hello = play(linkStart(), frame(HELLO));
  expect(hello.effects).toEqual([{ t: "hello" }]);
  expect(hello.link.hello).toEqual({ id: "s1", agent: "Claude Code", where: "ada-laptop, ~/trip", model: "Fable 5.2" });
  expect(play(linkStart(), frame({ type: "RUN_STARTED", threadId: "t", runId: "r" })).effects).toMatchObject([{ t: "close" }]);
  expect(play(linkStart(), frame({ type: "CUSTOM", name: "hello", value: { session: "no spaces here" } })).effects).toMatchObject([
    { t: "close" },
  ]);
  expect(play(hello.link, { e: "frame", text: "not json" }).effects).toEqual([{ t: "close", why: "a frame that is not JSON" }]);
  expect(play(hello.link, frame({ type: "TEXT_MESSAGE_CONTENT", messageId: 1 })).effects).toMatchObject([{ t: "close" }]);
  // A type that 1.0 lacks is not an error.
  expect(play(hello.link, frame({ type: "LATER" })).effects).toEqual([]);
});

test("a message from the panel goes down as a run's input; a prompt in the terminal comes up as one; the link keeps the log", () => {
  const { link } = play(linkStart(), frame(HELLO));
  const sent = play(link, { e: "prompt", text: "Add a map", context: "Open: Trip", id: "tab-1", run: "r1" });
  expect(sent.effects).toMatchObject([
    { t: "log", ev: { t: "user", text: "Add a map", id: "tab-1" } },
    {
      t: "down",
      frame: { threadId: "s1", runId: "r1", messages: [{ role: "user", content: "Add a map" }], context: [{ value: "Open: Trip" }] },
    },
  ]);
  const ran = play(
    sent.link,
    // The helper's echo of the panel's own run adds no second message.
    frame({
      type: "RUN_STARTED",
      threadId: "s1",
      runId: "r1",
      input: { threadId: "s1", runId: "r1", messages: [{ id: "u", role: "user", content: "Add a map" }] },
    }),
    frame({ type: "TEXT_MESSAGE_CHUNK", messageId: "m1", delta: "Done." }),
    frame({ type: "RUN_FINISHED", threadId: "s1", runId: "r1" }),
    frame({
      type: "RUN_STARTED",
      threadId: "s1",
      runId: "r2",
      input: { threadId: "s1", runId: "r2", messages: [{ id: "u2", role: "user", content: "Use winter.jpg" }] },
    })
  );
  expect(ran.link.log.items).toEqual([
    { kind: "user", text: "Add a map", id: "tab-1" },
    { kind: "assistant", text: "Done." },
    { kind: "user", text: "Use winter.jpg", away: true },
  ]);
  expect(ran.link.log.busy).toBe(true);
  // The session owns the thread: the link sends only the new message each time.
  const next = play(ran.link, { e: "prompt", text: "And a legend", context: null, run: "r3" });
  const down = next.effects.find((f) => f.t == "down");
  expect(down?.t == "down" && "messages" in down.frame && down.frame.messages.map((m) => m.role)).toEqual(["user"]);
});

test("a call that waits has a card that says the terminal asks too; the answer goes down as a resume; Stop is a cancel frame", () => {
  const asked = play(
    linkStart(),
    frame(HELLO),
    frame({ type: "RUN_STARTED", threadId: "s1", runId: "r1" }),
    frame({ type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Bash" }),
    frame({ type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"command":"sips -Z 1600 winter.jpg"}' }),
    frame({ type: "TOOL_CALL_END", toolCallId: "c1" })
  );
  expect(play(asked.link, { e: "stop" }).effects).toEqual([{ t: "down", frame: { cancel: "r1" } }]);
  const waits = play(
    asked.link,
    frame({
      type: "RUN_FINISHED",
      threadId: "s1",
      runId: "r1",
      outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "permission", toolCallId: "c1" }] },
    })
  );
  expect(waits.link.log.items.at(-1)).toMatchObject({
    kind: "tool",
    id: "c1",
    name: "Bash",
    status: "asking",
    by: "Claude Code",
    note: "Also asked in the terminal. The first answer counts.",
    call: { tool: "Bash", args: { command: "sips -Z 1600 winter.jpg" } },
  });
  expect(play(waits.link, { e: "stop" }).effects).toEqual([]);
  const answered = play(waits.link, { e: "answer", item: "c1", approve: true, run: "r2" });
  expect(answered.effects).toMatchObject([
    { t: "log", ev: { t: "tool", id: "c1", status: "running" } },
    { t: "down", frame: { runId: "r2", messages: [], resume: [{ interruptId: "i1", status: "resolved", payload: { approved: true } }] } },
  ]);
  // The terminal answered first: the session's next run takes the card away, and the panel's answer is too late.
  const terminal = play(waits.link, frame({ type: "RUN_STARTED", threadId: "s1", runId: "r2", parentRunId: "r1" }));
  expect(terminal.link.log.items.at(-1)).toMatchObject({ id: "c1", status: "running" });
  expect(play(terminal.link, { e: "answer", item: "c1", approve: true, run: "r3" }).effects).toEqual([]);
});

/** A person's agent object with one hosted setting and a grant store: `live` says whether grants work. */
function object(live = { now: true }) {
  const platform = { directory: { config: { get: async () => [] } }, grants: { live: async () => live.now } };
  return new PersonAgents({ sql: objectSql(), platform: platform as unknown as Platform });
}
/** A helper's socket on `a`: what it got, and whether the object closed it. */
function helper(a: PersonAgents, login = "ada") {
  const got: unknown[] = [];
  const state = { closed: false };
  const headers = { "x-erga-login": login, "x-erga-grant": "g1" };
  const socket = a.attach(
    new Request("http://x/api/agent/link", { headers }),
    (text) => got.push(JSON.parse(text)),
    () => (state.closed = true)
  );
  return { got, state, say: (value: unknown) => socket.hear(JSON.stringify(value)), leave: socket.leave };
}
/** A tab of the person's: the events it hears. */
function tab(a: PersonAgents, login = "ada") {
  const heard: { type: string; [k: string]: unknown }[] = [];
  a.join(new Request("http://x/api/agent/events", { headers: { "x-erga-login": login } }), (text) => heard.push(JSON.parse(text)));
  return heard;
}

test("the person's object lists an attached session, and shows it when they pick it: its log, its model; their message goes down the link", async () => {
  const a = object();
  const heard = tab(a),
    other = tab(a, "bob");
  const h = helper(a);
  h.say(HELLO);
  await Bun.sleep(0);
  const session = { id: "s1", agent: "Claude Code", where: "ada-laptop, ~/trip", model: "Fable 5.2", on: true };
  expect(heard).toEqual([{ type: "who", agents: [], sessions: [session], agent: null }]);
  expect(await a.setAgent("bob", "link:s1")).toMatchObject({ ok: false });
  expect(await a.setAgent("ada", "link:s1")).toEqual({ ok: true });
  expect(await a.agentState("ada", null, "http://x")).toMatchObject({
    enabled: true,
    model: "Fable 5.2",
    agent: "link:s1",
    log: { items: [] },
  });

  expect(await a.agentPrompt("ada", "http://x", "Add a map", "Open: Trip", undefined, null, "Ada", "tab-1")).toEqual({ ok: true });
  expect(h.got).toMatchObject([{ threadId: "s1", messages: [{ role: "user", content: "Add a map" }] }]);
  // The same message again (Try again) is not sent again; files do not go to a session.
  await a.agentPrompt("ada", "http://x", "Add a map", null, undefined, null, "Ada", "tab-1");
  expect(h.got.length).toBe(1);
  expect(await a.agentPrompt("ada", "http://x", "x", null, [{ name: "a.png" }])).toMatchObject({
    ok: false,
    reason: "Claude Code takes text only here: remove the files",
  });

  h.say({
    type: "RUN_STARTED",
    threadId: "s1",
    runId: "t9",
    input: { threadId: "s1", runId: "t9", messages: [{ id: "u", role: "user", content: "From the terminal" }] },
  });
  expect(heard.slice(-2)).toEqual([
    { type: "link", id: "s1", ev: { t: "user", text: "From the terminal", away: true } },
    { type: "link", id: "s1", ev: { t: "busy", busy: true } },
  ]);
  expect((await a.conversation("ada", null)).items.map((i) => i.kind == "user" && i.text)).toEqual(["Add a map", "From the terminal"]);
  expect(await a.agentControl("ada", null, "abort")).toEqual({ ok: true });
  expect(h.got.at(-1)).toEqual({ cancel: "t9" });
  expect(await a.agentControl("ada", null, "reset")).toMatchObject({ ok: false });
  expect(await a.agentControl("ada", null, "approve", "nope")).toEqual({ ok: false, reason: "that call no longer waits for your answer" });
  expect(other, "another person hears nothing of it").toEqual([]);

  // The helper leaves: the session is off, and a run that was open ends in the panel.
  h.leave();
  await Bun.sleep(0);
  expect(heard.slice(-2)).toMatchObject([
    { type: "link", id: "s1", ev: { t: "busy", busy: false } },
    { type: "who", sessions: [{ ...session, on: false }], agent: "link:s1" },
  ]);
  expect(await a.agentPrompt("ada", "http://x", "Still there?", null)).toEqual({ ok: false, reason: "Claude Code is not attached" });
  // It attaches again: the same session, with what the panel showed.
  const again = helper(a);
  again.say(HELLO);
  expect((await a.conversation("ada", null)).items.length).toBe(2);
  expect(await a.agentPrompt("ada", "http://x", "Still there?", null)).toEqual({ ok: true });
  // She goes on in a new session: the panel, which showed the one that left, shows the new one.
  again.leave();
  const next = helper(a);
  next.say({ ...HELLO, value: { ...HELLO.value, session: "s2" } });
  await Bun.sleep(0);
  expect(await a.agentState("ada", null, "http://x")).toMatchObject({ agent: "link:s2", log: { items: [] } });
});

test("a link whose grant was revoked closes before the next message goes down", async () => {
  const live = { now: true };
  const a = object(live);
  const h = helper(a);
  h.say(HELLO);
  await a.setAgent("ada", "link:s1");
  live.now = false;
  expect(await a.agentPrompt("ada", "http://x", "Hi", null)).toEqual({ ok: false, reason: "Claude Code is not attached" });
  expect(h.state.closed).toBe(true);
  expect(h.got).toEqual([{ error: "the grant was revoked" }]);
});
