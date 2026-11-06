// Checks an Erga server feature by feature, as its people and agents use it: the editor in a browser (live editing
// between two tabs, offline and back), then the tools API (versions, files, a page's own API, view_page), the
// homepage signed out, and the person's agent. Each line says what it saw: ok, or what failed.
//
//   SESSION_SECRET=... bun deploy/celld/check.ts <origin> [login]
//
// The session cookie is signed here with the server's SESSION_SECRET, for `login` (koomen), who must be a user there.
// The tools get a documents token made with it, as on the Settings page, which ends the next day.

import * as Base64Url from "effect/encoding/Base64Url";
import { chromium } from "playwright-core";
import { cookieName, SESSION_COOKIE, sign } from "../../server/identity/index.ts";
import { openEditor } from "../../e2e/helpers/editor";
import type { Server } from "../../e2e/helpers/server";

const [origin, login = "koomen"] = process.argv.slice(2);
const secret = process.env.SESSION_SECRET;
if (!origin || !secret) {
  console.error("usage: SESSION_SECRET=... bun deploy/celld/check.ts <origin> [login]");
  process.exit(2);
}
const root = origin.replace(/\/+$/, "");
const url = new URL(root);
const session = Base64Url.encode(JSON.stringify({ login, name: login, exp: Math.floor(Date.now() / 1000) + 3600 }));
const cookie = { name: cookieName(url, SESSION_COOKIE), value: await sign(secret, session) };
const headers = { cookie: `${cookie.name}=${cookie.value}`, origin: root, "content-type": "application/json" };

const results: [string, string][] = [];
async function check(feature: string, run: () => Promise<string>) {
  const started = Date.now();
  const seen = await run().then(
    (ok) => `ok: ${ok}`,
    (e: Error) => `FAILS: ${e.message.split("\n")[0]}`
  );
  results.push([feature, seen]);
  console.log(`${feature}: ${seen} (${Date.now() - started} ms)`);
}
const until = async <T>(read: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`waited ${ms / 1000} s for ${what}`);
    await Bun.sleep(250);
  }
};
/** A documents token for the tools an outside agent calls, made as a person makes one in Settings: it ends tomorrow. */
let token = "";
/** One tool call (POST /api/tools/<name>), as an outside agent makes it: its result, or its error thrown. */
async function tool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!token) {
    const expires = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = await fetch(`${root}/tokens/new`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "celld check", scope: "documents", expires }),
    });
    token = ((await r.json()) as { token?: string }).token ?? "";
    if (!token) throw new Error(`no token: ${r.status}`);
  }
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const r = await fetch(`${root}/api/tools/${name}`, { method: "POST", headers: auth, body: JSON.stringify(args) });
  const body = (await r.json().catch(() => ({ ok: false, error: `${r.status}, not JSON` }))) as { ok: boolean; result?: T; error?: string };
  if (!body.ok) throw new Error(body.error ?? `${r.status}`);
  return body.result as T;
}

await check("health", async () => {
  const r = await fetch(`${root}/api/health`);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return `${r.status}`;
});

let address = "";
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.addCookies([
    { ...cookie, domain: url.hostname, path: "/", secure: url.protocol == "https:", httpOnly: true, sameSite: "Lax" },
  ]);
  const tabOf = async () => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    return { page, errors, strict: false, own: () => Promise.reject(new Error("no server of its own")) };
  };
  const opened = (at: string) => ({ fixture: async () => ({ dir: "", address: at }) }) as unknown as Server;
  // What openEditor needs of a server: a new document (GET /new), opened.
  const fresh = {
    async fixture() {
      const r = await fetch(`${root}/new`, { redirect: "manual", headers });
      const at = r.headers.get("location");
      if (r.status != 302 || !at) throw new Error(`making a document: ${r.status} ${await r.text()}`);
      return { dir: "", address: root + at.replace(/[?&]edit$/, "") };
    },
  } as unknown as Server;

  await check("rooms and live editing", async () => {
    const a = await openEditor(await tabOf(), fresh, "", { allowErrors: true });
    address = a.address;
    const b = await openEditor(await tabOf(), opened(address), "", { allowErrors: true });
    const words = `Typed in tab A at ${new Date().toISOString()}`;
    await a.clickEnd("[data-erga-text]:not(.erga-locked)");
    await a.type(` ${words}`);
    await until(async () => (await b.visible()).includes(words), 10_000, "tab B to show tab A's words");
    return "tab B showed tab A's typing live";
  });

  await check("offline editing", async () => {
    const tab = await tabOf();
    await tab.page.addInitScript(() => {
      const sockets: WebSocket[] = ((window as any).__sockets = []);
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(u: string | URL, p?: string | string[]) {
          super(u, p);
          sockets.push(this);
        }
      } as typeof WebSocket;
    });
    const ed = await openEditor(tab, opened(address), "", { allowErrors: true });
    await context.setOffline(true);
    await until(
      async () => {
        for (const f of tab.page.frames()) await f.evaluate(`(window.__sockets ?? []).forEach((s) => s.close())`).catch(() => {});
        return !(await ed.eval<boolean>("ergaPage.collab.connected"));
      },
      10_000,
      "the socket closed"
    );
    const words = `Typed offline at ${new Date().toISOString()}`;
    await ed.clickEnd("[data-erga-text]:not(.erga-locked)");
    await ed.type(` ${words}`);
    await context.setOffline(false);
    await until(() => ed.eval<boolean>("ergaPage.collab.connected"), 20_000, "the socket back");
    await ed.idle();
    const again = await openEditor(await tabOf(), opened(address), "", { allowErrors: true });
    await until(async () => (await again.visible()).includes(words), 10_000, "a new tab to show the offline words");
    return "the words typed offline reached the server";
  });
} finally {
  await browser.close();
}
const document = new URL(address || root).pathname;

await check("versions", async () => {
  const v = await until(
    () => tool<{ total: number; pending: boolean }>("read", { op: "versions", document }).then((r) => !r.pending && r.total >= 2 && r),
    120_000,
    "a version of the typed edits"
  );
  return `${v.total} versions`;
});

await check("files (blobs)", async () => {
  // A 1x1 PNG: a file that isn't text is a blob, in the server's bucket (FILES).
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await tool("edit", { op: "write", document, path: "dot.png", content_base64: png });
  const read = await tool<unknown>("read", { op: "read", document, path: "dot.png" });
  if (!JSON.stringify(read).includes("image")) throw new Error(`read dot.png: ${JSON.stringify(read).slice(0, 200)}`);
  return "wrote a PNG and read it back";
});

await check("page's own API (Worker Loader)", async () => {
  const made = await tool<{ address: string }>("documents", {
    op: "create_document",
    template: "slides",
    title: `celld check ${Date.now()}`,
  });
  const deck = made.address ?? (made as any).document?.address;
  const api = await tool<any>("read", { op: "document_api", document: deck });
  if (!JSON.stringify(api).includes("add_slide")) throw new Error(`document_api: ${JSON.stringify(api).slice(0, 160)}`);
  await tool("edit", {
    op: "call_edit",
    document: deck,
    edit: "add_slide",
    input: { after: 1, layout: "content", title: "From the sandbox" },
  });
  const html = await tool<unknown>("read", { op: "read", document: deck, path: "index.html" });
  if (!JSON.stringify(html).includes("From the sandbox")) throw new Error("the new slide isn't in index.html");
  return "the deck's api.js ran in a Dynamic Worker: add_slide added a slide";
});

await check("view_page (Browser Rendering)", async () => {
  const r = await tool<any>("page", { op: "view_page", document });
  return JSON.stringify(r).slice(0, 120);
});

await check("homepage, signed out", async () => {
  const r = await fetch(`${root}/`, { redirect: "manual" });
  const text = await r.text();
  if (r.status != 200 || !text.includes("<html")) throw new Error(`${r.status} ${text.slice(0, 120)}`);
  return `${r.status}, ${text.length} bytes`;
});

await check("page LLM (window.ergaLLM)", async () => {
  await tool("documents", { op: "share_document", document, page_llm: true });
  const id = JSON.stringify(await tool("read", { op: "ls", document })).match(/"id":"([^"]+)"/)?.[1];
  const r = await fetch(`${root}/api/llm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ document: id, messages: [{ role: "user", content: "Say hi." }], max_tokens: 20 }),
  });
  return `${r.status} ${(await r.text()).slice(0, 140)}`;
});

await check("person's agent", async () => {
  const r = await fetch(`${root}/api/agent`, { method: "POST", headers, body: JSON.stringify({ text: "Say hi.", context: "" }) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const log = await until(
    async () => {
      const c = (await (await fetch(`${root}/api/agent/conversation`, { headers })).json()) as { log: { busy: boolean; items: unknown[] } };
      return !c.log.busy && c.log.items.length > 1 && c.log;
    },
    60_000,
    "the agent's turn to end"
  );
  return JSON.stringify(log.items.at(-1)).slice(0, 160);
});

process.exit(results.some(([, seen]) => seen.startsWith("FAILS")) ? 1 : 0);
