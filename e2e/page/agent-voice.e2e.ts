// Voice mode, against a stand-in for the browser's speech recognition: dictation fills the box
// and each pause sends it (tests/page.ts, "Agent, voice mode").
import { expect, servers, test } from "../fixtures";
import { openEditor, type Editor } from "../editor";
import type { Tab } from "../fixtures";

await servers.agent();

type State = { on: string | null; input: string; readOnly: boolean; send: string | null; title: string; sent: string[]; recs: number };

/** The editor with the stand-in: each session in __recs; messages to the agent caught in __sent, not sent. */
async function voice(tab: Tab) {
  await tab.page.addInitScript(() => {
    const w = window as any;
    w.__recs = []; w.__sent = [];
    w.SpeechRecognition = class extends EventTarget { running = false; onend?: () => void; start() { this.running = true; w.__recs.push(this); } stop() { this.abort(); } abort() { if (!this.running) return; this.running = false; setTimeout(() => this.onend?.()); } };
    w.__hear = (...rs: [string, boolean][]) => w.__recs.at(-1).onresult({ results: rs.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })) });
    const f = window.fetch;
    window.fetch = ((url: RequestInfo, init?: RequestInit) => String(url).split("?")[0].endsWith("/api/agent") && init?.method == "POST" ? (w.__sent.push(JSON.parse(String(init.body)).text), Promise.resolve(new Response("{}"))) : f(url, init)) as typeof fetch;
  });
  const ed = await openEditor(tab, await servers.agent(), "page");
  await ed.openAgent();
  await expect.poll(() => ed.eval<string>(`document.getElementById("agent-send").title`), { timeout: 10_000 }).toMatch(/Type a message/);
  // `before` runs in the same evaluation as the read: the pause timer is a tenth of real time here, shorter than a round trip on a busy machine.
  const st = (before = "") => ed.eval<State>(`(() => { ${before}; const v = document.getElementById("agent-voice"), i = document.getElementById("agent-input"), b = document.getElementById("agent-send"); return { on: v.getAttribute("aria-pressed"), input: i.value, readOnly: i.readOnly, send: b.getAttribute("aria-disabled"), title: b.title, sent: [...__sent], recs: __recs.length }; })()`);
  return { ed, st };
}

test("the voice button shows; voice mode listens with Send off and saying why; words show unsent as heard; a pause sends them and empties the box", async ({ tab }) => {
  const { ed, st } = await voice(tab);
  expect(await ed.eval<boolean>(`!document.getElementById("agent-voice").hidden`)).toBe(true);
  await ed.eval(`document.getElementById("agent-voice").click()`);
  let v = await st();
  expect(v).toMatchObject({ on: "true", recs: 1, readOnly: true, send: "true" });
  expect(v.title).toMatch(/Voice mode/);
  v = await st(`__hear(["make the title", false])`);
  expect(v).toMatchObject({ input: "make the title", sent: [] });
  await ed.eval(`__hear(["make the title blue", true])`);
  await expect.poll(async () => (await st()).sent.length).toBe(1);
  v = await st();
  expect(v).toMatchObject({ sent: ["make the title blue"], input: "" });
});

test("the next words show alone; each pause sends again, words not yet final included; a fresh session takes over", async ({ tab }) => {
  const { ed, st } = await voice(tab);
  await ed.eval(`document.getElementById("agent-voice").click()`);
  await ed.eval(`__hear(["make the title blue", true])`);
  await expect.poll(async () => (await st()).sent.length).toBe(1);
  const v = await st(`__hear(["make the title blue", true], [" and bigger", false])`);
  expect(v.input).toBe("and bigger");
  await expect.poll(async () => (await st()).sent.length).toBe(2);
  expect((await st()).sent[1]).toBe("and bigger");
  await expect.poll(async () => (await st()).recs).toBe(2);
});

test("leaving voice mode keeps what wasn't sent in the box, to edit; collapsing the panel stops listening", async ({ tab }) => {
  const { ed, st } = await voice(tab);
  await ed.eval(`document.getElementById("agent-voice").click()`);
  const v = await st(`__hear(["thanks", true]); document.getElementById("agent-voice").click()`);
  expect(v).toMatchObject({ on: "false", input: "thanks", readOnly: false, sent: [] });
  await ed.eval(`document.getElementById("agent-voice").click()`);
  await ed.press("ControlOrMeta+j");
  await expect.poll(async () => (await st()).on).toBe("false");
  expect(await ed.eval<boolean>(`!__recs.at(-1).running`)).toBe(true);
});
