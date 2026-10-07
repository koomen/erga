#!/usr/bin/env bun
// The admin agent's conversation and panel, kept on the server (worker/factory.ts, factory/chat-store.ts;
// GET|DELETE /api/admin/agent/conversation, GET|PUT /api/admin/agent/prefs), in a real browser, on the
// scripted test model:
//
//   - a conversation on /admin/factory is there on /admin (Settings) and after a reload;
//   - it is there after the server restarts, and after the server stops while a reply streams in:
//     what arrived is kept, and the next message works;
//   - the panel's open or closed state, side and width follow the admin to a fresh browser;
//   - "New conversation" empties it, for good.
//
//   bun tests/admin-agent-chat.ts            the checks
//   bun tests/admin-agent-chat.ts --shots    and screenshots, in tests/cdp.ts's SHOTS

import { mkdirSync } from "fs";
import { join } from "path";
import { Browser, type Page, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const keepShots = process.argv.includes("--shots");
const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script" } });
const browser = await Browser.launch();
const ok = (what: string) => console.log(`ok   ${what}`);
const W = 1440, H = 900;

async function shot(p: Page, name: string) {
  if (!keepShots) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `admin-agent-chat-${name}.png`);
  await p.screenshot(file);
  console.log(`shot ${file}`);
}

/** How many times the panel shows `text` (a scripted message has its reply in it too). */
const times = async (p: Page, text: string) => (await chat(p)).split(text).length - 1;
const chat = (p: Page) => p.eval<string>(`document.getElementById("agent-log").textContent`);
const ready = (p: Page) => until(() => p.eval<boolean>(`document.getElementById("agent-send").title == "Type a message to send it."`), 15_000, "the agent is on");
async function say(p: Page, text: string) {
  // The panel reads the conversation again once its event stream opens: a message sent before that may show late.
  await Bun.sleep(1000);
  await p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); })()`);
}
const api = (p: Page, method: string, path: string, body?: unknown) => p.eval<unknown>(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json" }${body ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} }).then((r) => r.json())`);

let failed = false;
try {
  let p = await browser.page(await browser.context());
  await p.open(`${host.root}/admin/factory`, { width: W, height: H });
  await ready(p);
  await say(p, `@script [{"text":"Kept: the first reply."}]`);
  await until(async () => (await times(p, "Kept: the first reply.")) == 2, 15_000, "the reply", () => p.eval(`({ log: document.getElementById("agent-log").outerHTML.slice(0, 500), hint: document.getElementById("agent-hint").textContent, input: document.getElementById("agent-input").value, send: document.getElementById("agent-send").title })`));
  ok("a reply on /admin/factory");

  await p.navigate(`${host.root}/admin`);
  await until(async () => (await times(p, "Kept: the first reply.")) == 2, 15_000, "the conversation on Settings", () => chat(p));
  const r = await api(p, "GET", "/api/admin/agent/conversation") as { log: { items: { kind: string }[] } };
  expect(r.log.items.map((i) => i.kind).join() == "user,assistant", "GET /api/admin/agent/conversation has it", r);
  ok("the same conversation on /admin (Settings), from /api/admin/agent/conversation");

  // The server restarts (a deploy, say): the conversation is in the Factory object's storage.
  await host.stop();
  await host.start();
  await p.navigate(`${host.root}/admin/users`);
  await until(async () => (await times(p, "Kept: the first reply.")) == 2, 20_000, "the conversation after a restart", () => chat(p));
  ok("the conversation is there after the server restarts");

  // The server stops while a reply streams in: the message is kept, the history stays good.
  await ready(p);
  await say(p, `@script [{"tool":"factory_status"},{"delay":20000,"text":"never arrives"}]`);
  await until(async () => (await chat(p)).includes("Checked the factory"), 15_000, "the tool call", () => chat(p));
  await Bun.sleep(1500);
  await host.stop();
  await host.start();
  await p.navigate(`${host.root}/admin/factory`);
  await ready(p);
  await until(async () => (await chat(p)).includes("factory_status"), 15_000, "the cut-off turn", () => chat(p));
  await say(p, `@script [{"text":"Still working after the crash."}]`);
  await until(async () => (await times(p, "Still working after the crash.")) == 2, 15_000, "a reply after the crash", () => chat(p));
  expect(await times(p, "never arrives") == 1 && await times(p, "Checked the factory") == 1 && await times(p, "The server restarted before the agent finished") == 1, "the cut-off turn kept as it was, its reply not invented", await chat(p));
  ok("a reply cut off by a crash keeps what arrived, and the next message works");
  await shot(p, "1-kept");

  // The panel: closed, on the right, 520px wide; a fresh browser (no localStorage) shows it so.
  await api(p, "PUT", "/api/admin/agent/prefs", { side: "right", width: 520 });
  await p.eval(`document.getElementById("agent-close").click()`);
  await until(async () => { const r = await api(p, "GET", "/api/admin/agent/prefs") as { side?: string; width?: number; open?: boolean }; return r.side == "right" && r.width == 520 && r.open === false; }, 5000, "the prefs on the server", () => api(p, "GET", "/api/admin/agent/prefs"));
  p.close();
  p = await browser.page(await browser.context());
  await p.open(`${host.root}/admin`, { width: W, height: H });
  await until(() => p.eval<boolean>(`document.documentElement.classList.contains("agent-closed") && document.getElementById("workspace").classList.contains("agent-right")`), 10_000, "closed, on the right, in a fresh browser");
  await p.eval(`document.getElementById("agent-fab").click()`);
  await until(() => p.eval<boolean>(`Math.round(document.getElementById("agent").getBoundingClientRect().width) == 520`), 5000, "520px wide", () => p.eval(`document.getElementById("agent").getBoundingClientRect().width`));
  await until(async () => (await api(p, "GET", "/api/admin/agent/prefs") as { open?: boolean }).open == true, 5000, "opened, on the server");
  ok("open or closed, the side and the width follow the admin to a fresh browser");
  await until(async () => (await times(p, "Still working after the crash.")) == 2, 15_000, "the conversation in the fresh browser", () => chat(p));
  await shot(p, "2-fresh-browser");

  // New conversation: empty, here and after a reload.
  await p.eval(`document.getElementById("agent-reset").click()`);
  await until(async () => !(await chat(p)).includes("Kept"), 5000, "the panel empties", () => chat(p));
  await p.navigate(`${host.root}/admin`);
  await ready(p);
  const empty = await api(p, "GET", "/api/admin/agent/conversation") as { log: { items: unknown[] } };
  expect(empty.log.items.length == 0 && !(await chat(p)).includes("Kept"), "a new conversation, after a reload too", empty);
  ok("New conversation empties it, for good");
} catch (e) {
  failed = true;
  console.error(e);
  console.error(host.output().slice(-3000));
} finally {
  browser.close();
  await host.dispose();
}
process.exit(failed ? 1 : 0);
