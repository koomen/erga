// The live page, for the agents (shared/live-page.ts): a document with audio,
// opened in the editor. With agent control off, the agent's page_click is
// refused; the person turns it on with a real click; the agent clicks play
// through the editor's handlers, and reads the media's state, the console
// (a repeated warning collapses into one line), the requests and the events.
import { expect, servers, test, until } from "../../fixtures";
import { person, tools } from "../versions/versions";

await servers.script();

/** One second of a quiet 440 Hz tone, as a WAV file (PCM, 8 kHz, 16-bit mono). */
function tone(): string {
  const rate = 8000, n = rate, data = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) data.setUint8(at + i, s.charCodeAt(i)); };
  str(0, "RIFF"); data.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); str(36, "data"); data.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) data.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 2000), true);
  return Buffer.from(data.buffer).toString("base64");
}

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Player</title></head>
<body>
<h1>Player</h1>
<p>Press play.</p>
<div data-erga-noedit><button id="play" type="button">Play</button><audio id="track" src="tone.wav" preload="auto" loop></audio></div>
<script>
for (let i = 0; i < 1000; i++) console.warn("The AudioContext was not allowed to start");
document.getElementById("play").addEventListener("click", () => {
  document.getElementById("track").play().then(() => console.log("playing"), (e) => console.warn("play() failed: " + e.name));
});
</script>
</body>
</html>
`;

test("the agent reads the live page and, once the person allows it, clicks play: the audio plays, and the console and requests say so", { timeout: 60_000 }, async ({ tab }) => {
  const server = await servers.script();
  const owner = await person(server, "tester");
  const token = await owner.token("Live page test");
  const made = await (await fetch(`${server.root}/api/ext/tools/create_document`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Player", slug: `player-${crypto.randomUUID().slice(0, 8)}`, files: { "index.html": PAGE, "tone.wav": { base64: tone() } } }) })).json() as { ok: boolean; content: { text: string }[] };
  expect(made.ok).toBe(true);
  const doc = JSON.parse(made.content[0].text) as { id: string; address: string };
  const tool = tools(server, token, doc.id);
  const p = tab.page;
  await p.setViewportSize({ width: 1200, height: 800 });
  await p.goto(`${server.root}${doc.address}#edit`);
  await until(() => p.evaluate(() => ["erga-editor-ready", "erga-editing", "erga-listening"].every((c) => document.body.classList.contains(c))).catch(() => false), 15_000, "the editor is ready");

  // Read-only tools work with agent control off: the console, with the page's 1000 warnings as one line.
  const consoled = await until(async () => { const r = await tool("page_console", { level: ["warn"], pattern: "AudioContext" }); return r.ok && /×1000/.test(r.text) ? r : null; }, 10_000, "the console's warnings");
  expect(consoled!.text).toMatch(/\[×1000, [\d:.]+–[\d:.]+\] warn \(page\): The AudioContext was not allowed to start/);
  // The page's media and permissions, without code: control off, so the page's frame may not autoplay.
  const before = await tool("page_inspect", {});
  expect(before.ok).toBe(true);
  const factsBefore = JSON.parse(before.text.slice(0, before.text.lastIndexOf("\n"))) as { frame: string; allow?: string; autoplay?: { allowsFeature: boolean }; media?: { element: string; paused: boolean; type: unknown; readyState: string }[] }[];
  const pageBefore = factsBefore.find((f) => f.frame == "page")!;
  expect(pageBefore.allow).toBe("autoplay 'none'; fullscreen 'none'");
  expect(pageBefore.autoplay?.allowsFeature).toBe(false);
  expect(pageBefore.media?.[0]).toMatchObject({ element: "<audio#track>", paused: true });
  expect(factsBefore[0]).toMatchObject({ frame: "the editor (the tab itself)", editorFrame: { allow: "autoplay; fullscreen" } });
  // The tab shows the person a line each time the agent inspects their page.
  await until(() => p.evaluate(() => document.getElementById("agent-live-text")?.textContent ?? ""), 3000, "the line in the tab").then((t) => expect(t).toMatch(/The agent read the page's media and permissions/));

  // page_click needs the person's switch.
  const refused = await tool("page_click", { selector: "#play" });
  expect(refused.ok).toBe(false);
  expect(refused.text).toMatch(/Allow the agent to control this page/);

  // The person turns it on: a real click (it gives the tab user activation). The page renders again with autoplay allowed.
  if (await p.locator("#agent-control").isHidden()) await p.locator("#agent-fab").click();
  await p.locator("#agent-control").click();
  await expect.poll(() => p.evaluate(() => (document.getElementById("agent-control") as HTMLInputElement).checked)).toBe(true);
  await expect.poll(() => p.evaluate(() => document.getElementById("agent-live")!.hidden ? "" : document.getElementById("agent-live-text")!.textContent)).toBe("The agent can control this page");
  const allowed = await until(async () => {
    const r = await tool("page_inspect", {});
    const f = r.ok ? (JSON.parse(r.text.slice(0, r.text.lastIndexOf("\n"))) as { frame: string; allow?: string; autoplay?: { allowsFeature: boolean; mediaelement: string }; media?: { readyState: string }[] }[]).find((x) => x.frame == "page") : null;
    return f?.allow == "autoplay; fullscreen" && f.autoplay?.allowsFeature && f.media?.[0]?.readyState.startsWith("4") ? f : null;
  }, 10_000, "the page renders again, with autoplay delegated, and its audio loads", async () => (await tool("page_inspect", {})).text);
  expect(allowed!.autoplay?.allowsFeature).toBe(true);

  // The agent clicks play, through the editor's handlers: untrusted, so no activation of its own, but the audio plays.
  const clicked = await tool("page_click", { selector: "#play" });
  expect(clicked.ok).toBe(true);
  expect(clicked.text).toMatch(/Clicked <button#play> at \(\d+, \d+\): pointerdown, mousedown, pointerup, mouseup, click\./);
  expect(clicked.text).toMatch(/Trusted: false/);
  // (Whatever the page's frame has: Playwright's own calls into the tab count as gestures. In a person's browser it has
  // none, and play() succeeds on the activation of the tab above it, which Chrome checks when autoplay is delegated.)
  expect(clicked.text).toMatch(/User activation in the page's frame: before isActive (true|false), hasBeenActive (true|false); after isActive (true|false), hasBeenActive (true|false)\./);
  expect(clicked.text).toMatch(/"element":"<audio#track>"[^}]*"paused":false/);
  expect(clicked.text).toMatch(/log \(page\): playing/);
  await expect.poll(() => p.evaluate(() => document.getElementById("agent-live-text")?.textContent)).toBe("The agent clicked #play");

  // The media keeps playing: its time moves on.
  const playing = await until(async () => {
    const r = await tool("page_inspect", { expression: `(() => { const a = document.querySelector("#track"); return { paused: a.paused, t: a.currentTime, error: a.error }; })()` });
    const v = r.ok ? JSON.parse(r.text.slice(0, r.text.indexOf("\n"))) as { paused: boolean; t: number; error: unknown } : null;
    return v && !v.paused && v.t > 0.2 ? v : null;
  }, 5_000, "the audio plays");
  expect(playing!.error).toBeNull();

  // The events: the agent's click, untrusted, and nobody consumed it.
  const events = await tool("page_events", { since: "1m" });
  expect(events.text).toMatch(/click on <button#play>, sent by the agent, untrusted: nobody consumed it/);
  // The requests: the audio file, from Erga's server, as audio/wav.
  const net = await tool("page_network", { pattern: "tone\\.wav" });
  expect(net.ok).toBe(true);
  expect(net.text).toMatch(/GET {2}doc\/tone\.wav {2}20[06] {2}audio\/wav/);
  expect(net.text).not.toMatch(/\/t\/ey/); // the token in the files' address stays in the tab
  expect(net.text).toMatch(/via erga/);

  // A key the editor takes for itself (⌘S / Ctrl+S, its own save): the events say the editor consumed it.
  const key = await tool("page_key", { key: "s", meta: true, ctrl: true, selector: "p" });
  expect(key.text).toMatch(/Pressed a key on <p>: keydown \(default prevented\), keyup\./);
  expect((await tool("page_events", { since: "10s" })).text).toMatch(/keydown on <p>, sent by the agent, untrusted: the editor called preventDefault \(its listener on document, bubble phase\)/);

  // The embedded agent has the same tools.
  const turn = await owner.get(`/d/${doc.id}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `Why is it quiet? @script ${JSON.stringify([{ tool: "page_console", args: { pattern: "playing" } }, { text: "It plays." }])}` }) });
  expect(turn.ok).toBe(true);
  const log = await until(async () => {
    const l = ((await (await owner.get(`/d/${doc.id}/api/agent`)).json()) as { log: { busy: boolean; items: { kind: string; name?: string; status?: string }[] } }).log;
    return !l.busy && l.items.some((i) => i.kind == "tool" && i.name == "page_console") ? l : null;
  }, 10_000, "the embedded agent's turn");
  expect(log!.items.find((i) => i.name == "page_console")?.status).toBe("done");

  // One click turns control off; page_click is refused again.
  await p.locator("#agent-live-off").click();
  await expect.poll(() => p.evaluate(() => (document.getElementById("agent-control") as HTMLInputElement).checked)).toBe(false);
  expect((await tool("page_click", { selector: "#play" })).ok).toBe(false);
});
