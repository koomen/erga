// Real tabs in headless Chrome against the target's shell: two people typing
// on the page, carets and coloured marks, undo of your own edits only, the
// source view, the agent panel (scripted), view_page from the owner's tab,
// a tab riding out a restart, and a refused tab saying so.

import { Browser, MOD, type Page } from "../../cdp";
import { tab } from "../../tab";
import { Participant } from "../client";
import { expect, sleep, until, type Ctx, type Test } from "../harness";
import type { Doc } from "../target";

let browser: Promise<Browser> | null = null;
export async function closeBrowser() { (await browser)?.close(); browser = null; }

/** Opens the shell as a person, with the target's auth headers on every request. */
async function open(ctx: Ctx, d: Doc, user: string) {
  browser ??= Browser.launch();
  const p: Page = await (await browser).page();
  ctx.defer(() => p.close());
  const headers = d.headersFor(user);
  if (Object.keys(headers).length) {
    await p.send("Network.enable");
    await p.send("Network.setExtraHTTPHeaders", { headers });
  }
  await p.open(d.pageUrl(user), { clear: false, width: 1100, height: 800 });
  await until(() => p.eval<boolean>(`!!window.ergaPage && !!document.getElementById("frame").contentDocument?.querySelector("[data-erga-id]")`), 10_000, `${user}'s page renders`);
  await p.eval(`document.getElementById("frame").contentDocument.fonts.ready.then(() => true)`);
  await p.settle();
  return tab(p);
}

const peerNames = (t: ReturnType<typeof tab>) => t.p.eval<string>(`[...${t.F}.querySelectorAll("erga-peer-name")].map((e) => e.textContent).join("|")`);
const noErrors = (t: ReturnType<typeof tab>, who: string) => expect(t.p.errors.length == 0, `no page errors (${who})`, t.p.errors);

export const browserTests: Test[] = [
  {
    name: "two people typing on the page see each other's edits and carets",
    needs: ["browser"],
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await open(ctx, d, "Ada"), await open(ctx, d, "Bo")];
      const tips = (t: typeof a) => t.p.eval<string[]>(`[...document.querySelectorAll("#people .avatar")].map((e) => e.dataset.tip)`);
      await until(async () => (await tips(a)).some((t) => t.startsWith("Bo")) && (await tips(b)).some((t) => t.startsWith("Ada")), 3000, "each sees the other at the top", async () => [await tips(a), await tips(b)]);
      await b.p.eval(`document.getElementById("frame").contentWindow.__marker = 1`);
      await a.clickEnd("h1");
      await a.p.type(" (draft)");
      await until(async () => (await b.textOf("h1")) == (await a.textOf("h1")), 3000, "Bo's page shows Ada's typing");
      expect(await b.p.eval<boolean>(`document.getElementById("frame").contentWindow.__marker == 1`), "without a reload");
      const m = await b.marks();
      expect(m.added.join("").includes("(draft)") && m.names.every((n) => /^erga-a\d+-/.test(n)), "marked in Ada's colour", m);
      await until(async () => (await peerNames(b)) == "Ada", 3000, "Ada's caret shows on Bo's page");
      noErrors(a, "Ada"); noErrors(b, "Bo");
    },
  },
  {
    name: "interleaved typing converges and is stored; ⌘Z undoes only your own",
    needs: ["browser"],
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await open(ctx, d, "Ada"), await open(ctx, d, "Bo")];
      await a.clickEnd("figcaption");
      await b.clickEnd("li:first-child");
      for (const [x, y] of [["1", "4"], ["2", "5"], ["3", "6"]]) { await a.p.type(x); await b.p.type(y); }
      await until(async () => (await a.source()) == (await b.source()), 3000, "the tabs converge");
      const s = await a.source();
      expect(s.includes("go.123</figcaption>") && /<li>[^<]*456<\/li>/.test(s), "both people's typing is there", s.match(/<figcaption>.*?<\/figcaption>|<li>.*?<\/li>/g));
      await until(async () => (await d.stored(d.path))?.text == s, 5000, "and stored");
      await b.p.key("z", MOD.Meta);
      await until(async () => !(await a.source()).includes("456"), 3000, "Bo's ⌘Z takes his typing back, for Ada too");
      expect((await a.source()).includes("go.123") && (await b.source()) == (await a.source()), "Ada's typing stays");
      noErrors(a, "Ada"); noErrors(b, "Bo");
    },
  },
  {
    name: "the source view follows others' typing and shows their caret; the page redraws it after",
    needs: ["browser"],
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await open(ctx, d, "Ada"), await open(ctx, d, "Bo")];
      await b.p.key("p", MOD.Meta | MOD.Shift);
      await sleep(300);
      await a.clickEnd("h1");
      await a.p.type("!");
      await until(async () => (await b.p.eval<string>(`document.querySelector("#source .cm-content").textContent`)).includes("Launch notes!"), 3000, "Bo's source view has Ada's typing");
      await until(async () => (await b.p.eval<string>(`[...document.querySelectorAll("#source .cm-peer-name")].map((e) => e.textContent).join("|")`)) == "Ada", 3000, "and her caret");
      await b.p.key("p", MOD.Meta | MOD.Shift);
      await until(async () => (await peerNames(b)) == "Ada", 3000, "back on the page, her caret is drawn again");
      noErrors(b, "Bo");
    },
  },
  {
    name: "a headless participant's edit shows on the page like anyone's",
    needs: ["browser"],
    async run(ctx) {
      const d = await ctx.doc();
      const a = await open(ctx, d, "Ada");
      const x = await Participant.join(d, "Xavier");
      ctx.defer(() => x.destroy());
      x.insertAfter("Where the leads ", "really ");
      await until(async () => (await a.textOf("figcaption")).includes("really"), 3000, "Ada's page shows Xavier's edit");
      x.setCursor(x.str().indexOf("really"));
      await until(async () => (await peerNames(a)) == "Xavier", 3000, "and his caret");
    },
  },
  {
    name: "the agent panel is per person, and the agent sees the page through its owner's tab",
    needs: ["browser", "scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await open(ctx, d, "Ada"), await open(ctx, d, "Bo")];
      await a.p.key("j", MOD.Meta);
      await sleep(300);
      const script = JSON.stringify([{ tool: "edit", args: { path: d.path, edits: [{ oldText: "<h1>Launch notes", newText: "<h1>Launch notes by agent" }] } }, { tool: "view_page", args: { selector: "h1" } }, { text: "Looked." }]);
      await a.p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify("Check it @script " + script)}; i.dispatchEvent(new Event("input")); })()`);
      await a.p.key("Enter");
      await until(async () => a.p.eval<boolean>(`[...document.querySelectorAll(".msg-assistant")].some((e) => e.textContent == "Looked.")`), 15_000, "Ada's panel shows the reply");
      expect(await a.p.eval<boolean>(`[...document.querySelectorAll(".msg-tool")].some((e) => /Looked at the page/.test(e.textContent) && e.querySelector("img.shot")?.naturalWidth > 0)`), "view_page captured the page in Ada's tab", await a.p.eval(`[...document.querySelectorAll(".msg-tool")].map((e) => e.textContent).join(" | ")`));
      await until(async () => (await b.textOf("h1")).includes("by agent"), 3000, "Bo's page shows the agent's edit");
      expect(!(await b.p.eval<boolean>(`[...document.querySelectorAll(".msg-user, .msg-assistant")].length > 0`)), "Bo's panel shows none of it");
      await until(async () => b.p.eval<boolean>(`[...document.querySelectorAll("#people .agent-badge")].some((e) => /Ada’s agent/.test(e.dataset.tip))`), 3000, "the agent's badge shows on Bo's page");
      expect(!(await peerNames(b)).includes("Ada’s agent"), "but no caret of its own on the page", await peerNames(b));
      noErrors(a, "Ada"); noErrors(b, "Bo");
    },
  },
  {
    name: "the agent pane follows the agent's output until you scroll back, like a terminal",
    needs: ["browser", "scriptedAgent"],
    slow: true,
    timeoutMs: 90_000,
    async run(ctx) {
      const d = await ctx.doc();
      const a = await open(ctx, d, "Ada");
      const p = a.p;
      await p.key("j", MOD.Meta);
      await until(() => p.eval<boolean>(`document.body.classList.contains("agent-open") && !!document.getElementById("agent-model").textContent`), 3000, "the panel opens");
      const pane = () => p.eval<{ top: number; max: number; jump: boolean }>(`(() => { const l = document.getElementById("agent-log"); return { top: l.scrollTop, max: l.scrollHeight - l.clientHeight, jump: !document.getElementById("agent-jump").hidden }; })()`);
      const atBottom = async () => { const s = await pane(); return s.max - s.top <= 8; };
      const send = async (steps: unknown[]) => {
        await p.eval(`(() => { const i = document.getElementById("agent-input"); i.focus(); i.value = ${JSON.stringify("Go @script " + JSON.stringify(steps))}; i.dispatchEvent(new Event("input")); })()`);
        await p.key("Enter");
      };
      const busy = () => p.eval<boolean>(`document.getElementById("agent-send").classList.contains("stop")`);
      const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long answer.`).join("\n");
      // A long run: tool calls trickling in, a screenshot (which loads after its event), a long reply.
      const reads = Array.from({ length: 6 }, () => ({ tool: "read", args: { path: d.path }, delay: 120 }));
      await send([...reads, { tool: "view_page", args: {} }, { text: long, delay: 200 }]);
      await until(async () => !(await busy()) && await p.eval<boolean>(`!!document.querySelector(".msg-assistant")`), 20_000, "the run finishes");
      await p.settle();
      const s0 = await pane();
      expect(s0.max > 200, "the log overflows the pane", s0);
      expect(await atBottom(), "the pane followed the output to the end, screenshot and all", s0);

      // Scroll back to read while another run writes more: the pane stays where you put it.
      await send([...reads, { text: long }]);
      await until(busy, 5000, "the second run starts");
      const box = await p.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById("agent-log").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -600 });
      await until(async () => { const s = await pane(); return s.max - s.top > 100; }, 2000, "the wheel scrolls the log up");
      await p.settle();
      const reading = (await pane()).top;
      await until(async () => !(await busy()), 20_000, "the second run finishes");
      await p.settle();
      const s1 = await pane();
      expect(Math.abs(s1.top - reading) <= 2 && s1.max - s1.top > 100, "new output didn't pull you down", { reading, ...s1 });
      expect(s1.jump, "a 'Jump to latest' button offers the way back");
      await p.eval(`document.getElementById("agent-jump").click()`);
      await p.settle();
      expect(await atBottom() && !(await pane()).jump, "jumping goes to the bottom and hides the button");

      // Following again: the next run's output is followed; so is a new message sent while scrolled back.
      await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -600 });
      await p.settle();
      await send([{ text: long, delay: 150 }]);
      await until(async () => !(await busy()), 10_000, "the third run finishes");
      await p.settle();
      expect(await atBottom(), "sending a message brings the pane back to follow its answer", await pane());
      noErrors(a, "Ada");
    },
  },
  {
    name: "a paragraph broken by bad markup explains itself and the button asks the agent to fix it",
    needs: ["browser", "scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const a = await open(ctx, d, "Ada");
      const s = (await d.stored(d.path))!;
      const broken = s.text.replace("Where the leads go.", "Where the</h2> leads go.");
      expect(broken != s.text, "the fixture has the sentence");
      expect((await d.push(d.path, broken, s.etag)).ok, "the broken markup is published");
      await until(() => a.p.eval<boolean>(`!!${a.F}.querySelector("figcaption.erga-locked")`), 5000, "the paragraph locks");
      const r = await a.rectOf("figcaption", 0.2);
      await a.p.click(r.x, r.y);
      await until(() => a.p.eval<boolean>(`!!document.querySelector("#toast.show .toast-fix")`), 2000, "the note offers a fix");
      const note = await a.p.eval<string>(`document.querySelector("#toast .toast-text").textContent`);
      expect(/stray <\/h2>/.test(note) && !/HTML view|⌘⇧P/.test(note), "it names the stray tag and doesn't send you to the HTML", note);
      expect(!(await a.p.eval<boolean>(`document.body.classList.contains("agent-open")`)), "the agent panel starts closed");
      // Watch the note frame by frame as it goes: it fades as it is, nothing jumps.
      await a.p.eval(`window.__frames = []; (function tick(n) { const t = document.getElementById("toast"); const r = t.getBoundingClientRect(); __frames.push({ op: +getComputedStyle(t).opacity, btn: !!t.querySelector(".toast-fix"), w: Math.round(r.width), h: Math.round(r.height) }); if (n < 40) requestAnimationFrame(() => tick(n + 1)); })(0)`);
      const clicked = performance.now();
      await a.p.eval(`document.querySelector("#toast .toast-fix").click()`);
      await until(() => a.p.eval<boolean>(`document.body.classList.contains("agent-open")`), 2000, "the agent panel opens");
      await until(() => a.p.eval<boolean>(`[...document.querySelectorAll("#agent-log .msg-user")].some((e) => e.textContent.includes("stray </h2>"))`), 1000, "the prompt shows in the panel at once");
      ctx.metric("prompt visible after", performance.now() - clicked);
      await until(async () => {
        const log = (await (await d.fetch("/api/agent?user=Ada", {}, "Ada")).json()) as { log: { items: { kind: string; text?: string }[] } };
        return log.log.items.some((i) => i.kind == "user" && /stray <\/h2>/.test(i.text ?? "") && /Where the leads go/.test(i.text ?? "") && /line \d+/.test(i.text ?? ""));
      }, 5000, "Ada's agent gets a prompt naming the problem, the paragraph and its line");
      await until(() => a.p.eval<boolean>(`!!document.querySelector("#agent-log .msg-assistant") && !document.querySelector("#agent-log .msg-user.pending")`), 5000, "and its answer streams into the panel, like any message");
      const frames = await a.p.eval<{ op: number; btn: boolean; w: number; h: number }[]>(`__frames`);
      const visible = frames.filter((f) => f.op > 0.01);
      expect(visible.every((f) => f.btn && f.w == visible[0].w && f.h == visible[0].h), "the note keeps its shape and button until it has faded", frames);
      noErrors(a, "Ada");
    },
  },
  {
    name: "a message that can't be sent says so and can be tried again",
    needs: ["browser", "scriptedAgent"],
    async run(ctx) {
      const d = await ctx.doc();
      const a = await open(ctx, d, "Ada");
      await a.p.key("j", MOD.Meta);
      await sleep(300);
      // The host stops answering the agent's endpoint for a moment.
      await a.p.eval(`window.__realFetch = window.fetch; window.fetch = (u, o) => String(u).startsWith("/api/agent?") && o?.method == "POST" ? Promise.reject(new TypeError("Failed to fetch")) : window.__realFetch(u, o)`);
      await a.p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = "hello there"; i.dispatchEvent(new Event("input")); })()`);
      await a.p.key("Enter");
      await until(() => a.p.eval<boolean>(`!!document.querySelector("#agent-log .msg-user.failed .send-failed button")`), 2000, "the message is marked as not sent, with a retry");
      expect(/Not sent/.test(await a.p.eval<string>(`document.querySelector("#agent-log .msg-user.failed").textContent`)), "and says so");
      await a.p.eval(`window.fetch = window.__realFetch`);
      await a.p.eval(`document.querySelector("#agent-log .msg-user.failed .send-failed button").click()`);
      await until(() => a.p.eval<boolean>(`[...document.querySelectorAll("#agent-log .msg-user")].some((e) => e.textContent == "hello there" && !e.classList.contains("pending") && !e.classList.contains("failed"))`), 5000, "trying again sends it");
      expect(await a.p.eval<number>(`document.querySelectorAll("#agent-log .msg-user.failed").length`) == 0, "and the failed copy is gone");
    },
  },
  {
    name: "a tab rides out a server restart, keeping what was typed while it was down",
    needs: ["browser", "restart"],
    async run(ctx) {
      const d = await ctx.doc();
      const [a, b] = [await open(ctx, d, "Ada"), await open(ctx, d, "Bo")];
      await d.restart!("graceful", async () => {
        await sleep(300);
        await a.clickEnd("h1");
        await a.p.type(" offline");
      });
      await until(async () => (await b.textOf("h1")).endsWith(" offline"), 10_000, "Bo gets Ada's offline typing once the server is back");
      expect((await a.source()) == (await b.source()) && (await a.source()).split("<h1>").length == 2, "the tabs agree and nothing is doubled");
      expect(await a.p.eval<boolean>(`document.getElementById("welcome").hidden`), "no 'out of date' notice");
    },
  },
  {
    name: "a tab the room can't merge any more says so and offers a reload",
    needs: ["browser", "kill"],
    async run(ctx) {
      const d = await ctx.doc();
      const a = await open(ctx, d, "Ada");
      await d.restart!("lose-state");
      await until(async () => !(await a.p.eval<boolean>(`document.getElementById("welcome").hidden`)), 10_000, "the notice appears");
      expect(/out of date/.test(await a.p.eval<string>(`document.getElementById("welcome").textContent`)), "it explains");
      await a.p.eval(`document.getElementById("stale-reload").click()`);
      await until(async () => a.p.eval<boolean>(`document.getElementById("welcome").hidden && !!window.ergaPage`), 10_000, "a reload brings the page back");
    },
  },
];
