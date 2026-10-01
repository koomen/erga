// The agent editor as a participant, driven by the scripted model (agent.ts:
// a message with `@script [...]` plays tool calls in order), so every run is
// the same and free. Checks the agent's edits are attributed and visible to
// others, that stale aim fails cleanly, that `write` keeps edits made since
// its read, its undo, its presence, and that conversations stay private.

import { converged, Participant } from "../client";
import { expect, sleep, until, type Test } from "../harness";
import type { Doc } from "../target";

type Item = { kind: string; text?: string; name?: string; status?: string; detail?: string; image?: string };
interface Log { items: Item[]; busy: boolean; undoable: number }

async function agentLog(d: Doc, user: string): Promise<Log> {
  const r = await d.fetch(`/api/agent?user=${encodeURIComponent(user)}`, {}, user);
  const j = (await r.json()) as { enabled: boolean; reason?: string; log?: Log };
  expect(j.enabled, `the agent is on for ${user}`, j.reason);
  return j.log!;
}

/** Sends a script and waits for the run to end; returns the log. */
async function runScript(d: Doc, user: string, steps: unknown[], opts: { wait?: boolean; text?: string } = {}): Promise<Log> {
  const before = (await agentLog(d, user)).items.length;
  const r = await d.fetch(`/api/agent?user=${encodeURIComponent(user)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `${opts.text ?? "Test"} @script ${JSON.stringify(steps)}` }) }, user);
  expect(r.ok, `the prompt is accepted (${r.status})`);
  if (opts.wait === false) return agentLog(d, user);
  let log: Log = await agentLog(d, user);
  await until(async () => { log = await agentLog(d, user); return !log.busy && log.items.length > before + 1; }, 20_000, `${user}'s agent finishes`, () => log);
  return log;
}

const edit = (path: string, oldText: string, newText: string, extra: object = {}) => ({ tool: "edit", args: { path, edits: [{ oldText, newText }] }, ...extra });

export const agent: Test[] = [
  {
    name: "the agent's edit reaches others, attributed to it, and is stored",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      const t0 = performance.now();
      const log = await runScript(d, "Ada", [edit(d.path, "<h1>Launch notes", "<h1>Launch notes, revised"), { text: "Done." }]);
      await until(() => b.str().includes("<h1>Launch notes, revised"), 3000, "Bo sees the agent's edit");
      ctx.metric("prompt to edit seen", performance.now() - t0);
      const by = b.seen.find((s) => s.inserted.includes("revised"));
      expect(by?.author == "Ada’s agent" && by.kind == "agent", "attributed to Ada's agent", b.seen);
      expect(log.items.some((i) => i.kind == "tool" && i.name == "edit" && i.status == "done"), "the log shows the edit", log.items);
      expect(log.items.some((i) => i.kind == "assistant" && i.text == "Done."), "and the reply");
      await until(async () => (await d.stored(d.path))?.text.includes("<h1>Launch notes, revised"), 5000, "stored");
    },
  },
  {
    name: "while it works it's present: busy, saying what it does, with a caret where it edited",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      await runScript(d, "Ada", [edit(d.path, "<h1>Launch notes", "<h1>Launch notes!"), { text: "Done.", delay: 1500 }], { wait: false });
      const agentState = () => b.others().find((o) => o.user.kind == "agent" && o.user.name == "Ada’s agent");
      await until(() => agentState()?.busy, 3000, "Bo sees the agent busy");
      await until(() => agentState()?.cursor, 3000, "with a caret");
      const at = b.resolve(agentState()!.cursor!.anchor)!;
      expect(b.str().slice(0, at).endsWith("<h1>Launch notes!"), "the caret sits at the end of its edit", b.str().slice(Math.max(0, at - 30), at + 10));
      await until(() => agentState() && !agentState()!.busy, 5000, "and idle when it's done");
    },
  },
  {
    name: "an edit aimed at text that has since changed fails cleanly",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      b.delete(b.str().indexOf("<h1>Launch notes") + 4, "Launch notes".length);
      b.insertAfter("<h1>", "Release notes");
      await sleep(200);
      const before = b.str();
      const log = await runScript(d, "Ada", [edit(d.path, "<h1>Launch notes", "<h1>Launch memo"), { text: "ok" }]);
      const failed = log.items.find((i) => i.kind == "tool" && i.name == "edit");
      expect(failed?.status == "error" && /isn't in the current text/.test(failed.detail ?? ""), "the edit fails with 'read again'", failed);
      await sleep(200);
      expect(b.str() == before, "and changes nothing");
    },
  },
  {
    name: "write keeps edits others made after the agent read the file",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      const rewritten = d.fixture[d.path].replace("Launch notes", "Field notes");
      await runScript(d, "Ada", [{ tool: "read", args: { path: d.path } }, { tool: "write", args: { path: d.path, content: rewritten }, delay: 1500 }, { text: "ok" }], { wait: false });
      await until(async () => (await agentLog(d, "Ada")).items.some((i) => i.kind == "tool" && i.name == "read" && i.status == "done"), 5000, "the agent has read the file");
      b.insertAfter("Where the leads go.", " BO-WAS-HERE");
      await until(async () => !(await agentLog(d, "Ada")).busy, 10_000, "the agent finishes");
      await until(() => b.str().includes("Field notes"), 3000, "the write landed");
      expect(b.str().includes(" BO-WAS-HERE"), "Bo's edit made after the read survives the write", b.str().slice(0, 600));
    },
  },
  {
    name: "undo takes back exactly the agent's last change, then the one before",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      await runScript(d, "Ada", [edit(d.path, "<h1>Launch notes", "<h1>Launch notes ONE"), edit(d.path, "Where the leads go.", "Where the leads go. TWO"), { text: "ok" }]);
      await until(() => b.str().includes("ONE") && b.str().includes("TWO"), 3000, "both edits landed");
      b.insertAfter("<h1>", "BO ");
      await sleep(200);
      expect((await agentLog(d, "Ada")).undoable == 2, "two changes to undo");
      let r = await (await d.fetch("/api/agent/undo?user=Ada", { method: "POST" }, "Ada")).json() as { ok: boolean };
      expect(r.ok, "undo succeeds");
      await until(() => !b.str().includes("TWO"), 3000, "the last change is gone");
      expect(b.str().includes("ONE") && b.str().includes("BO "), "the earlier change and Bo's edit stay");
      const by = b.seen.at(-1);
      expect(by?.author == "Ada’s agent", "the undo is attributed to the agent", b.seen.slice(-2));
      r = await (await d.fetch("/api/agent/undo?user=Ada", { method: "POST" }, "Ada")).json() as { ok: boolean };
      await until(() => !b.str().includes("ONE"), 3000, "then the first");
      expect(b.str().includes("BO "), "Bo's edit still stays");
      r = await (await d.fetch("/api/agent/undo?user=Ada", { method: "POST" }, "Ada")).json() as { ok: boolean };
      expect(!r.ok, "nothing more to undo");
    },
  },
  {
    name: "an external agent with Ada's share token edits as Ada's agent, and she can undo it",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      const share = async (rotate = false) => ((await (await d.fetch("/api/share?user=Ada", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rotate }) }, "Ada")).json()) as { token: string }).token;
      const token = await share();
      expect(/^swx_[\w-]{40,}$/.test(token), "the share button gets a token", token);
      expect((await share()) == token, "asking again gives the same one");
      const ext = (path: string, init: RequestInit = {}, t = token) => fetch(d.base + path, { ...init, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } });
      expect((await fetch(d.base + "/api/ext")).status == 401, "the API needs the token");
      const guide = await (await ext("/api/ext")).text();
      expect(/Editing .* in Scratchwork/.test(guide) && /### edit/.test(guide) && /data-sw-noedit/.test(guide), "the guide explains the tools and the document rules", guide.slice(0, 300));
      const run = async (name: string, args: unknown) => { const r = await ext(`/api/ext/tools/${name}`, { method: "POST", body: JSON.stringify(args) }); return { status: r.status, body: (await r.json()) as { ok: boolean; content?: { type: string; text?: string }[]; error?: string } }; };
      const read = await run("read", { path: d.path });
      expect(read.body.ok && read.body.content?.[0]?.text?.includes("<h1>Launch notes") == true, "read returns the file", read);
      const ed = await run("edit", edit(d.path, "<h1>Launch notes", "<h1>Launch notes EXT").args);
      expect(ed.body.ok, "edit succeeds", ed);
      await until(() => b.str().includes("Launch notes EXT"), 3000, "Bo sees the external agent's edit");
      expect(b.seen.at(-1)?.author == "Ada’s agent", "attributed to Ada's agent", b.seen.slice(-2));
      const bad = await run("edit", { path: d.path });
      expect(bad.status == 400 && /edits/.test(bad.body.error ?? ""), "bad arguments say what's wrong", bad);
      expect((await run("nope", {})).status == 404, "an unknown tool is a 404");
      const log = await agentLog(d, "Ada");
      expect(log.items.some((i) => i.kind == "tool" && i.name == "edit" && i.status == "done" && (i as { via?: string }).via == "external"), "the call is in Ada's transcript, marked external", log.items);
      expect(log.undoable == 1, "and Ada can undo it");
      await d.fetch("/api/agent/undo?user=Ada", { method: "POST" }, "Ada");
      await until(() => !b.str().includes("EXT"), 3000, "the undo takes it back");
      const fresh = await share(true);
      expect((await ext("/api/ext")).status == 401 && (await ext("/api/ext", {}, fresh)).status == 200, "a new token turns the old one off");
    },
  },
  {
    name: "conversations are private: Bo's tabs never see Ada's",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      // Bo's event channel, listening the whole time.
      let boEvents = "";
      const headers = d.headersFor("Bo");
      const bo = new WebSocket(d.base.replace(/^http/, "ws") + "/api/events?user=Bo", (Object.keys(headers).length ? { headers } : undefined) as unknown as string[]);
      ctx.defer(() => bo.close());
      bo.onmessage = (e) => { boEvents += String(e.data); };
      await new Promise((r) => { bo.onopen = r; });
      await runScript(d, "Ada", [edit(d.path, "<h1>Launch notes", "<h1>Launch notes (private)"), { text: "secret reply" }], { text: "a private question" });
      await sleep(300);
      expect(!boEvents.includes("private") && !boEvents.includes("secret"), "nothing of Ada's reaches Bo's stream", boEvents.slice(0, 500));
      const lb = await agentLog(d, "Bo");
      expect(lb.items.length == 0, "Bo's transcript is empty", lb.items);
      const la = await agentLog(d, "Ada");
      expect(la.items.some((i) => i.kind == "user" && i.text == `a private question @script ${JSON.stringify([edit(d.path, "<h1>Launch notes", "<h1>Launch notes (private)"), { text: "secret reply" }])}`), "Ada's has her message");
    },
  },
  {
    name: "the agent keeps going with no tab open, and the transcript waits for you",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      await runScript(d, "Ada", [edit(d.path, "<h1>Launch notes", "<h1>Launch notes (unattended)"), { text: "finished alone" }]);
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      expect(b.str().includes("(unattended)"), "its edit is in the room");
      expect((await agentLog(d, "Ada")).items.some((i) => i.text == "finished alone"), "the transcript has the reply");
    },
  },
  {
    name: "view_page with none of the owner's tabs open says so",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const log = await runScript(d, "Ada", [{ tool: "view_page", args: {} }, { text: "ok" }]);
      const v = log.items.find((i) => i.kind == "tool" && i.name == "view_page");
      expect(v?.status == "error" && /no editor tab open/.test(v.detail ?? ""), "the tool explains there's no browser", v);
    },
  },
  {
    name: "two people's agents editing one file at once both land",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const c = await Participant.join(d, "Cy");
      ctx.defer(() => c.destroy());
      await Promise.all([
        runScript(d, "Ada", [edit(d.path, "<h1>Launch notes", "<h1>Launch notes [ada]", { delay: 100 }), edit(d.path, "Where the leads go.", "Where the leads go. [ada2]", { delay: 150 }), { text: "ok" }]),
        runScript(d, "Bo", [edit(d.path, "Typing never waits.", "Typing never waits. [bo]", { delay: 120 }), edit(d.path, "Faster builds", "Faster builds [bo2]", { delay: 140 }), { text: "ok" }]),
      ]);
      await until(() => ["[ada]", "[ada2]", "[bo]", "[bo2]"].every((t) => c.str().includes(t)), 5000, "all four edits are in", () => c.str().slice(0, 800));
    },
  },
  {
    name: "a person typing in the paragraph the agent edits keeps every keystroke",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      const typing = (async () => { for (const ch of " and more") { b.insertAfter("Launch notes", ch); await sleep(40); } })();
      await runScript(d, "Ada", [edit(d.path, "<h1>Launch", "<h1>Big launch", { delay: 150 }), { text: "ok" }]);
      await typing;
      const p = await Participant.join(d, "Check");
      ctx.defer(() => p.destroy());
      await converged([b, p], 3000);
      expect(p.str().includes("Big launch notes"), "the agent's edit landed", p.str().slice(0, 200));
      expect(p.str().replace(/[^a-z ]/g, "").includes("erom dna"), "and Bo's typing is all there (each char went in right after 'Launch notes')", p.str().slice(0, 200));
    },
  },
  {
    name: "an agent whose person can only view can't edit",
    needs: ["scriptedAgent", "roles"],
    async run() {
      throw new Error("not written: needs a deployment with view-only roles");
    },
  },
];
