// Each person's agent as a participant in a document, driven by the scripted model (agents/models.ts: a message with
// `@script [...]` plays tool calls in order), so every run is the same and free. Its document tools run in the
// document's host as the person's agent (agents/document/session.ts). Checks the agent's edits are attributed and
// visible to others, that stale aim fails cleanly, that `write` keeps edits made since its read, its undo, its
// presence, and that conversations stay private.

import { converged, Participant } from "../client";
import { expect, type Test } from "../harness";
import { sleep } from "../../../../shared/time";
import { until } from "../../../helpers/fixtures";
import type { Doc } from "../target";

type Item = { kind: string; text?: string; name?: string; status?: string; detail?: string; image?: string };
interface Log {
  items: Item[];
  busy: boolean;
}

/** A request to the person's agent (agents/person/sessions.ts: on the app, not the document), as `user`. */
function agentApi(d: Doc, user: string, path: string, init: RequestInit = {}) {
  const origin = new URL(d.base).origin;
  return fetch(`${origin}${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(user)}`, {
    ...init,
    headers: { ...d.headersFor(user), Origin: origin, ...(init.headers as Record<string, string> | undefined) },
  });
}

/** The document's id: the document a message names, for the agent's tools that name none. */
const ids = new WeakMap<Doc, Promise<string>>();
const docId = (d: Doc) => {
  if (!ids.has(d))
    ids.set(
      d,
      d.fetch("/api/doc").then(async (r) => ((await r.json()) as { docName: { id: string } }).docName.id)
    );
  return ids.get(d)!;
};

async function agentLog(d: Doc, user: string): Promise<Log> {
  const j = (await (await agentApi(d, user, "/api/agent")).json()) as { enabled: boolean; reason?: string };
  expect(j.enabled, `the agent is on for ${user}`, j.reason);
  return ((await (await agentApi(d, user, "/api/agent/conversation")).json()) as { log: Log }).log;
}

/** How many of `user`'s agent's changes to the document Undo can take back (the document's host keeps them). */
const undoable = async (d: Doc, user: string) =>
  ((await (await d.fetch(`/api/agent/undo?user=${encodeURIComponent(user)}`, {}, user)).json()) as { count: number }).count;

/** A new conversation for each of `users` (the agent is the person's, across documents and tests). */
const fresh = (d: Doc, ...users: string[]) =>
  Promise.all(users.map((u) => agentApi(d, u, "/api/agent/conversation", { method: "DELETE" })));

/** Sends a script and waits for the run to end; returns the log of this run (the conversation goes on across tests). */
async function runScript(d: Doc, user: string, steps: unknown[], opts: { wait?: boolean; text?: string } = {}): Promise<Log> {
  const before = (await agentLog(d, user)).items.length;
  const r = await agentApi(d, user, "/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `${opts.text ?? "Test"} @script ${JSON.stringify(steps)}`, doc: await docId(d) }),
  });
  expect(r.ok, `the prompt is accepted (${r.status})`);
  if (opts.wait === false) return agentLog(d, user);
  let log: Log = await agentLog(d, user);
  await until(async () => { log = await agentLog(d, user); return !log.busy && log.items.length > before + 1; }, 20_000, `${user}'s agent finishes`, () => log);
  return { ...log, items: log.items.slice(before) };
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
      // Typed in a few steps (agents/document/workspace.ts, paced): each of them by the agent.
      const by = b.seen.filter((s) => s.inserted && ", revised".includes(s.inserted));
      const agents = by.length > 0 && by.every((s) => s.author == "Ada, via their agent" && s.kind == "agent");
      expect(agents, "attributed to Ada's agent", b.seen);
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
      const agentState = () => b.others().find((o) => o.user.kind == "agent" && o.user.name == "Ada, via their agent");
      await until(() => agentState()?.busy, 3000, "Bo sees the agent busy");
      await until(() => agentState()?.cursor, 3000, "with a caret");
      // At the edit first, then after it once the new text is in.
      const caret = () => b.resolve(agentState()!.cursor!.anchor) ?? 0;
      const near = () => b.str().slice(Math.max(0, caret() - 30), caret() + 10);
      await until(() => b.str().slice(0, caret()).endsWith("<h1>Launch notes!"), 3000, "the caret sits at the end of its edit", near);
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
      expect((await undoable(d, "Ada")) == 2, "two changes to undo");
      let r = await (await d.fetch("/api/agent/undo?user=Ada", { method: "POST" }, "Ada")).json() as { ok: boolean };
      expect(r.ok, "undo succeeds");
      await until(() => !b.str().includes("TWO"), 3000, "the last change is gone");
      expect(b.str().includes("ONE") && b.str().includes("BO "), "the earlier change and Bo's edit stay");
      const by = b.seen.at(-1);
      expect(by?.author == "Ada, via their agent", "the undo is attributed to the agent", b.seen.slice(-2));
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
      expect(/^erga_[\w-]{40,}$/.test(token), "the share button gets a token", token);
      expect((await share()) == token, "asking again gives the same one");
      // As the Share card's prompt says: the tools, with the document's address as "document".
      const origin = new URL(d.base).origin;
      const ext = (path: string, init: RequestInit = {}, t = token) =>
        fetch(origin + path, { ...init, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } });
      expect((await ext("/api/tools/whoami", { method: "POST", body: "{}" }, "erga_forged")).status == 401, "the API needs a real token");
      const listed = ((await (await ext("/api/tools")).json()) as { tools: { name: string; description: string }[] }).tools;
      expect(
        listed.some((t) => t.name == "edit") && /data-erga-noedit/.test(listed.find((t) => t.name == "write")?.description ?? ""),
        "the tools are listed, and write's description has the page rules",
        listed.map((t) => t.name)
      );
      const run = async (name: string, args: Record<string, unknown>) => {
        const r = await ext(`/api/tools/${name}`, { method: "POST", body: JSON.stringify({ document: d.base, ...args }) });
        return { status: r.status, body: (await r.json()) as { ok: boolean; result?: { type: string; text?: string }[]; error?: string } };
      };
      const read = await run("read", { path: d.path });
      expect(read.body.ok && read.body.result?.[0]?.text?.includes("<h1>Launch notes") == true, "read returns the file", read);
      const ed = await run("edit", edit(d.path, "<h1>Launch notes", "<h1>Launch notes EXT").args);
      expect(ed.body.ok, "edit succeeds", ed);
      await until(() => b.str().includes("Launch notes EXT"), 3000, "Bo sees the external agent's edit");
      // (A share token's edits are its person's, via it, under its label: agents/document/session.ts.)
      expect(b.seen.at(-1)?.author == "Ada, via a shared agent (Share button)", "attributed to Ada, via her shared agent", b.seen.slice(-2));
      const bad = await run("edit", { path: d.path });
      expect(bad.status == 400 && /edits/.test(bad.body.error ?? ""), "bad arguments say what's wrong", bad);
      expect((await run("nope", {})).status == 404, "an unknown tool is a 404");
      expect((await undoable(d, "Ada")) == 1, "and Ada can undo it");
      await d.fetch("/api/agent/undo?user=Ada", { method: "POST" }, "Ada");
      await until(() => !b.str().includes("EXT"), 3000, "the undo takes it back");
      const fresh = await share(true);
      expect(
        (await ext("/api/tools")).status == 401 && (await ext("/api/tools", {}, fresh)).status == 200,
        "a new token turns the old one off"
      );
    },
  },
  {
    name: "conversations are private: Bo's tabs never see Ada's",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      await fresh(d, "Ada", "Bo");
      // Bo's event channel, listening the whole time.
      let boEvents = "";
      const headers = d.headersFor("Bo");
      const bo = new WebSocket(d.base.replace(/^http/, "ws") + "/api/room?events=1&user=Bo", (Object.keys(headers).length ? { headers } : undefined) as unknown as string[]);
      ctx.defer(() => bo.close());
      // (The document's new title, which follows the heading the agent edits, goes to everyone: it's the document's, not the
      // conversation's. So are the room's own messages, binary, and the hello: its name and pages.)
      bo.onmessage = (e) => { if (typeof e.data == "string" && !e.data.startsWith(`{"type":"name"`) && !e.data.startsWith(`{"type":"hello"`)) boEvents += e.data; };
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
    name: "view_page with none of the owner's tabs open renders the page in the server's browser",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const log = await runScript(d, "Ada", [{ tool: "view_page", args: {} }, { text: "ok" }]);
      const v = log.items.find((i) => i.kind == "tool" && i.name == "view_page");
      expect(!!v && v.status != "error" && !!v.image, "the tool answers a picture", v);
    },
  },
  {
    name: "two people's agents at once: the one editing the source holds the lock; the other's edit waits for its run to end",
    needs: ["scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const c = await Participant.join(d, "Cy");
      ctx.defer(() => c.destroy());
      // Ada's agent edits the source twice; Bo's tries once in between, while Ada's holds the lock (document/room.ts).
      await Promise.all([
        runScript(d, "Ada", [
          edit(d.path, "<h1>Launch notes", "<h1>Launch notes [ada]", { delay: 100 }),
          edit(d.path, "Where the leads go.", "Where the leads go. [ada2]", { delay: 600 }),
          { text: "ok" },
        ]),
        runScript(d, "Bo", [edit(d.path, "Typing never waits.", "Typing never waits. [bo]", { delay: 350 }), { text: "ok" }]),
      ]);
      await until(
        () => ["[ada]", "[ada2]"].every((t) => c.str().includes(t)),
        5000,
        "Ada's agent's edits are in",
        () => c.str().slice(0, 800)
      );
      expect(!c.str().includes("[bo]"), "Bo's agent's edit, while Ada's held the lock, changed nothing", c.str().slice(0, 800));
      // Ada's run is over: Bo's agent edits now.
      await runScript(d, "Bo", [edit(d.path, "Typing never waits.", "Typing never waits. [bo]", { delay: 50 }), { text: "ok" }]);
      await until(
        () => c.str().includes("[bo]"),
        5000,
        "and Bo's lands once Ada's run is over",
        () => c.str().slice(0, 800)
      );
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
    async run(ctx) {
      const d = await ctx.doc();
      // Only those it's shared with: Bo may edit, Dee may only view.
      await d.share!("*", null);
      await d.share!("Bo", "editor");
      await d.share!("Dee", "viewer");
      const b = await Participant.join(d, "Bo");
      ctx.defer(() => b.destroy());
      // Someone who may only view: their agent can't change the document (it changes others only): its edit is refused.
      const tried = await runScript(d, "Dee", [edit(d.path, "<h1>Launch notes", "<h1>Dee's notes"), { text: "Tried." }]);
      expect(
        tried.items.some((i) => i.kind == "tool" && i.status == "error" && !!i.detail),
        "the viewer's agent's edit is refused, saying why",
        tried.items.slice(-3)
      );
      expect(!(await d.stored(d.path))!.text.includes("Dee's notes"), "the document is as it was");
      // Nor do the viewer's own edits, in the room or as a publish, go anywhere.
      const v = await Participant.join(d, "Dee");
      ctx.defer(() => v.destroy());
      v.insertAfter("<h1>", "Dee typed. ");
      b.insertAfter("<h1>", "Bo typed. ");
      await until(() => v.str().includes("Bo typed. "), 3000, "the viewer sees Bo's edit");
      const push = await d.fetch(`/api/stored/${d.path}?user=Dee`, { method: "PUT", body: "<h1>Dee's page</h1>" }, "Dee");
      expect(push.status == 403, "the viewer's publish is refused", push.status);
      await sleep(d.writeDelay + 600);
      expect(!b.str().includes("Dee") && !(await d.stored(d.path))!.text.includes("Dee"), "nothing of the viewer's reached Bo or storage", b.str().slice(0, 200));
      // Made an editor, their agent edits.
      await d.share!("Dee", "editor");
      await runScript(d, "Dee", [edit(d.path, "<h1>Bo typed. Launch notes", "<h1>Dee's notes"), { text: "Done." }]);
      await until(() => b.str().includes("<h1>Dee's notes"), 3000, "the document agent's edit reaches Bo");
    },
  },
];
