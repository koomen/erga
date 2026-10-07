// Voice mode: what was left in the box isn't sent later, after the pause timer ("Agent, voice mode"): it waits the timer out, so a bench.
import { expect, servers, test } from "../fixtures";
import { openEditor, TIMESCALE } from "../editor";

await servers.agent();

test("leaving voice mode doesn't send what was left in the box later", async ({ tab }) => {
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
  await ed.eval(`document.getElementById("agent-voice").click()`);
  await ed.eval(`__hear(["thanks", true]); document.getElementById("agent-voice").click()`);
  await new Promise((r) => setTimeout(r, 1000 * TIMESCALE + 100));
  expect(await ed.eval<number>(`__sent.length`)).toBe(0);
});
