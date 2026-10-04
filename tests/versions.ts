#!/usr/bin/env bun
// Versions and publishing (versions.ts, worker/doc-host.ts), against a dev
// server of its own with short timings: a burst of edits is one version, an
// agent's turn is one version, the last editor leaving cuts one; open tabs
// hear of each ({ type: "versions" }); descriptions arrive (the fallback, as
// the scripted model writes none); "latest" mode shows edits at once and
// "manual" mode the chosen version, in the viewer (headless Chrome) and in
// every file a viewer can ask for; only editors may publish; and the agent's
// tools (list_versions, read_version, publish_version) over the API.
//
//   bun tests/versions.ts

import { Browser } from "./cdp";
import { startHost } from "./host";
import { Participant } from "./suite/client";
import { expect, sleep, until } from "./suite/harness";
import type { Doc } from "./suite/target";

const IDLE = 1500;
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script", ERGA_WRITE_DELAY_MS: "50", ERGA_VERSION_IDLE_MS: String(IDLE), ERGA_VERSION_MAX_MS: "8000" } });
const base = host.base.replace(/\/+$/, "");
const origin = new URL(base).origin;
const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

async function signIn(as: string): Promise<string> {
  const r = await fetch(`${base}/auth/github?as=${as}&next=/docs`, { redirect: "manual" });
  return r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="))!;
}
const owner = `vtest${Date.now().toString(36)}`;
const cookie = await signIn(owner);
const bo = await signIn("vbo");
const as = (c: string) => (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init, headers: { Cookie: c, ...(init.headers as Record<string, string>) } });
const get = as(cookie), getBo = as(bo);

interface V { id: string; n: number; at: string; authors: string[]; description: string | null }
interface State { current: V; published: { mode: string; version: V }; versions: V[]; total: number; canEdit: boolean; pending: boolean }
const state = async (id: string, q = "", who = get): Promise<State> => (await who(`/api/docs/${id}/versions${q}`)).json() as Promise<State>;
const publish = (id: string, body: unknown, who = get, headers: Record<string, string> = { Origin: origin }) =>
  who(`/api/docs/${id}/publish`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

try {
  // A document of the owner's.
  const r = await get("/new");
  const at = r.headers.get("location")!.replace(/\/edit$/, "");
  const id = ((await (await get(`${at}/api/name`)).json()) as { id: string }).id;

  let s = await state(id);
  expect(s.total == 1 && s.current.id == "v1" && s.current.description == "First version" && s.current.authors.includes(owner), "a new document has its first version", s);
  expect(s.published.mode == "latest" && s.published.version.id == "v1" && s.canEdit, "published: latest, by default", s);
  ok("a new document starts with version 1, published as \"latest\"");

  // Open tabs hear of every version ({ type: "versions" } on the document's events).
  const events: string[] = [];
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/d/${id}/api/events`, { headers: { Cookie: cookie } } as unknown as string[]);
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type == "versions") events.push("versions"); };
  await until(() => ws.readyState == WebSocket.OPEN, 5000, "the event socket opens");

  // A burst of edits, quicker than the pause: one version, once they stop.
  const doc = { base: `${base}/d/${id}`, path: "index.html", roomUrl: `${base.replace(/^http/, "ws")}/d/${id}/api/room`, roomName: "doc", headersFor: () => ({ Cookie: cookie }) } as unknown as Doc;
  const ada = await Participant.join(doc, "Ada");
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) { ada.edit((t) => t.insert(t.toString().indexOf("</h1>"), ` burst${i}`)); await sleep(150); }
  await sleep(IDLE / 2);
  expect((await state(id)).total == 1, "no version while the burst goes on, nor just after it", await state(id));
  await until(async () => (await state(id)).total == 2, IDLE * 4, "the burst becomes one version");
  s = await state(id);
  expect(s.total == 2 && Date.now() - t0 >= IDLE, "one version for the whole burst", s);
  expect(s.current.authors.length == 1 && !s.pending, "its author is the one who typed", s.current);
  await sleep(IDLE * 1.5);
  expect((await state(id)).total == 2, "and no more after it, with nothing changed");
  await until(async () => (await state(id)).current.description == "Edited index.html", 5000, "the description arrives (the fallback, with the scripted model)");
  await until(() => events.length >= 2, 3000, "tabs hear of the version and of its description", () => events);
  ok("a burst of edits is one version, cut when the edits pause, with its description and events");

  // A long burst: cut at the longest a burst may go (8s here), even while typing goes on.
  // (Not waited for in full here: the idle rule is what matters day to day; the unit tests cover storage.)

  // An agent's turn is one version, even with pauses in it longer than the idle time.
  const before = (await state(id)).total;
  const script = [
    { tool: "edit", args: { path: "index.html", edits: [{ oldText: "</h1>", newText: " agent-one</h1>" }] } },
    { delay: IDLE * 1.6, tool: "edit", args: { path: "index.html", edits: [{ oldText: "</h1>", newText: " agent-two</h1>" }] } },
    { text: "Done." },
  ];
  const sent = await get(`/d/${id}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `@script ${JSON.stringify(script)}` }) });
  expect(sent.ok, "the scripted agent takes the prompt", await sent.text());
  await until(async () => (await state(id)).total == before + 1 && ada.str().includes("agent-two"), IDLE * 6, "the agent's turn becomes a version");
  await sleep(IDLE * 1.5);
  s = await state(id);
  expect(s.total == before + 1, "exactly one version for the agent's turn, though it paused longer than the idle time", s);
  expect(s.current.authors.some((a) => a.endsWith("agent")), "attributed to the agent", s.current);
  const agentVersion = s.current;
  ok("an agent's turn is one version, attributed to the agent");

  // Paging: before= and limit=.
  const page = await state(id, `?limit=1&before=${agentVersion.id}`);
  expect(page.versions.length == 1 && page.versions[0].n == agentVersion.n - 1 && page.total == agentVersion.n, "versions page back with before= and limit=", page);
  ok("versions list newest first, paging back with before= and limit=");

  // The last editor leaving cuts a version at once, without waiting for the pause.
  ada.edit((t) => t.insert(t.toString().indexOf("</h1>"), " leaving"));
  await sleep(300);
  ada.disconnect();
  await until(async () => (await state(id)).total == agentVersion.n + 1, IDLE * 0.9, "leaving cuts a version before the pause would");
  ok("the last editor leaving cuts a version at once");

  // Who may publish: an editor, not a viewer; a browser only from this site.
  await get("/docs/share", { method: "POST", body: new URLSearchParams({ id, login: "vbo", role: "viewer" }), headers: { Origin: origin } });
  const boState = await state(id, "", getBo);
  expect(boState.total >= 4 && boState.canEdit === false, "a viewer may list versions, and is told they can't publish", boState);
  expect((await publish(id, { mode: "manual", versionId: "v1" }, getBo)).status == 403, "a viewer can't publish");
  expect((await publish(id, { mode: "manual", versionId: "v1" }, get, {})).status == 403, "nor can another site's page, for the owner");
  expect((await publish(id, { mode: "manual", versionId: "v99" })).status == 404, "a version that isn't there is refused");
  expect((await (await fetch(`${base}/api/docs/${id}/versions`)).status) == 401, "signed out: nothing");
  ok("only editors may publish (viewers may list), and only from this site's pages");

  // Manual: viewers see the chosen version, whatever happens to the document meanwhile.
  const eventsBefore = events.length;
  const pub = await publish(id, { mode: "manual", versionId: "v2" });
  const pubBody = (await pub.json()) as { published: { mode: string; version: V } };
  expect(pub.ok && pubBody.published.mode == "manual" && pubBody.published.version.id == "v2", "publishing v2", pubBody);
  await until(() => events.length > eventsBefore, 3000, "tabs hear of the publish");
  const bob = await Participant.join(doc, "Bob");
  bob.edit((t) => t.insert(t.toString().indexOf("</h1>"), " unpublished-draft"));
  await until(async () => (await (await get(`/d/${id}/doc/index.html`)).text()).includes("unpublished-draft"), 3000, "the editor's files have the draft");
  // The viewer's frame and its files, as the viewer's page links them.
  const viewer = async (who: typeof get) => {
    const html = await (await who(at)).text();
    const frame = /<iframe id="frame"[^>]* src="([^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    const hostPage = await (await fetch(frame)).text();
    const shown = new URL(/<iframe id="view"[^>]* src="([^"]+)"/.exec(hostPage)![1], frame).href;
    return { frame, shown, docUrl: shown.replace("/pub/", "/doc/") };
  };
  const mine = await viewer(get);
  expect(mine.shown.includes("/pub/"), "the viewer shows the page from pub/", mine);
  const shownText = await (await fetch(mine.shown)).text();
  expect(shownText.includes("burst5") && !shownText.includes("agent-one") && !shownText.includes("unpublished-draft"), "manual: the viewer's page is v2's, not the draft", shownText.slice(0, 400));
  expect((await (await fetch(mine.docUrl)).text()).includes("unpublished-draft"), "while an editor's frame (doc/) has the draft");
  const theirs = await viewer(getBo);
  const boDoc = await (await fetch(theirs.docUrl)).text();
  expect(!boDoc.includes("unpublished-draft") && boDoc.includes("burst5"), "someone who may only view gets v2 from doc/ too", boDoc.slice(0, 300));
  expect((await get(`/api/docs/${id}/versions`).then((x) => x.json()) as State).published.version.id == "v2", "the API says v2 is published");
  // A viewer's copy is of what they see.
  const clone = await getBo(`/new?from=${id}`);
  const copyAt = clone.headers.get("location")!.replace(/\/edit$/, "");
  const copyText = await (await getBo(`${copyAt}/doc/index.html`)).text();
  expect(!copyText.includes("unpublished-draft") && copyText.includes("burst5"), "a viewer's Clone copies the published version", copyText.slice(0, 300));
  ok("manual: viewers see the published version in every file (and copy it); editors edit the draft");

  // In a real browser: the viewer's page shows v2.
  const browser = await Browser.launch();
  try {
    const tab = await browser.page();
    await tab.send("Network.enable");
    await tab.send("Network.setExtraHTTPHeaders", { headers: { Cookie: bo } });
    await tab.open(`${base}${at}`);
    await until(async () => (await tab.inPage<string>("document.body?.innerText ?? ''")).some((t) => t?.includes("burst5")), 10_000, "the viewer shows the page");
    const texts = await tab.inPage<string>("document.body.innerText");
    expect(texts.some((t) => t?.includes("burst5") && !t.includes("unpublished-draft") && !t.includes("agent-one")), "headless Chrome shows v2 in the viewer", texts);
    const shot = await tab.send("Page.captureScreenshot", { format: "png" });
    await Bun.write(`${process.env.ERGA_SHOTS ?? "/tmp"}/versions-manual.png`, Buffer.from(shot.data, "base64"));
    ok("the viewer in headless Chrome shows the published version");
  } finally { browser.close(); }

  // Back to latest: viewers see every edit at once, without waiting for a version.
  expect((await publish(id, { mode: "latest" })).ok, "back to latest");
  bob.edit((t) => t.insert(t.toString().indexOf("</h1>"), " live-now"));
  await until(async () => (await (await fetch(mine.shown)).text()).includes("live-now"), 2000, "latest: the viewer has the edit at once");
  expect((await state(id)).pending, "and it's not a version yet");
  ok("latest: viewers see edits up to the keystroke, before any version is cut");

  // The agent's tools, over the server's API with an agent token.
  const tokensPage = await (await get("/tokens/new", { method: "POST", body: new URLSearchParams({ label: "versions test" }), headers: { Origin: origin } })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(tokensPage)![1];
  const tool = async (name: string, args: object) => {
    const res = await fetch(`${base}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ document: id, ...args }) });
    const body = (await res.json()) as { ok: boolean; content?: { text?: string }[]; error?: string };
    return { status: res.status, text: body.content?.map((c) => c.text ?? "").join("\n") ?? body.error ?? "" };
  };
  let t = await tool("list_versions", {});
  expect(t.status == 200 && t.text.includes("Published: latest") && t.text.includes("v2") && t.text.includes("Edited index.html"), "list_versions", t);
  t = await tool("read_version", { version: "v1" });
  expect(t.status == 200 && t.text.includes("index.html"), "read_version lists a version's files", t);
  t = await tool("read_version", { version: "v2", path: "index.html" });
  expect(t.status == 200 && t.text.includes("burst5") && !t.text.includes("agent-one"), "read_version reads a file as it was", t);
  t = await tool("publish_version", { mode: "manual", version: "v3" });
  expect(t.status == 200 && t.text.includes("manual, v3"), "publish_version", t);
  expect((await state(id)).published.version.id == "v3", "the API agrees");
  t = await tool("publish_version", { mode: "latest" });
  expect(t.status == 200 && (await state(id)).published.mode == "latest", "publish_version back to latest", t);
  // The same over the token on the HTTP API.
  const viaToken = await fetch(`${base}/api/docs/${id}/publish`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "manual", versionId: "v2" }) });
  expect(viaToken.ok, "an agent token publishes over the HTTP API too", await viaToken.text());
  await publish(id, { mode: "latest" });
  ok("the agent's tools list, read and publish versions");

  bob.disconnect();
  ws.close();
  console.log(`\nversions: all ${checks.length} passing`);
} catch (e) {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  console.error(host.output().slice(-3000));
  process.exitCode = 1;
} finally {
  await host.dispose();
}
