// Helpers for the tests of staging's admins-only guard (worker/admins-only.ts): requests as a page, MCP, a
// WebSocket upgrade, and the pages origin's frame.

import { request } from "node:http";
import type { Server } from "../fixtures";

/** Signed out, on this server: locally each names its cookies for its port (worker/cookies.ts). */
export const signedOut = (s: Server) => `erga_signed_out_${s.port}=1`;
export const get = (s: Server, path: string, init: RequestInit = {}) => fetch(path.startsWith("http") ? path : s.root + path, { redirect: "manual", ...init });
export const page = (s: Server, path: string, headers: Record<string, string> = {}) => get(s, path, { headers: { Accept: "text/html", ...headers } });
export const tool = (s: Server, token: string, name: string, args: unknown = {}) => fetch(`${s.root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
export const publish = async (s: Server, token: string, title: string) => (await (await fetch(`${s.root}/api/publish`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title, files: { "index.html": `<h1>${title}</h1>` } }) })).json()) as { id: string; address: string };
export const mcp = (s: Server, headers: Record<string, string>) => fetch(`${s.root}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
/** The guard's refusal of an API request: JSON, 403, adminsOnly. */
export const refusedJson = async (r: Response) => r.status == 403 && ((await r.json().catch(() => ({}))) as { adminsOnly?: boolean }).adminsOnly == true;

/** The editor's frame on the pages origin, as the document's page names it. */
export const frameOf = (html: string) => /<meta name="erga-pages" content="([^"]+)">/.exec(html)?.[1] ?? "";

/** A GET on the pages origin (a *.localhost host on the server's port), through node:http so the Host header goes as is: its status and body. */
export const pagesFetch = (u: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
  const url = new URL(u);
  const req = request({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, headers: { Host: url.host }, timeout: 10_000 }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { text += c; });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
  });
  req.on("timeout", () => req.destroy(new Error(`no answer from ${u} in 10 s`)));
  req.on("error", reject);
  req.end();
});

/**
 * What a WebSocket upgrade gets: its status (101: the socket opens), or "closed" when the server shuts the connection
 * instead of answering, as the dev server does when the Worker refuses an upgrade.
 */
export const upgrade = (url: string, headers: Record<string, string>) => new Promise<number | "closed">((resolve, reject) => {
  const req = request(url, { headers: { ...headers, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" }, timeout: 10_000 });
  req.on("response", (r) => { r.resume(); resolve(r.statusCode ?? 0); });
  req.on("upgrade", (r, socket) => { socket.destroy(); resolve(r.statusCode ?? 101); });
  req.on("timeout", () => req.destroy(new Error("no answer to the upgrade in 10 s")));
  req.on("error", (e: NodeJS.ErrnoException) => (e.code == "ECONNRESET" ? resolve("closed") : reject(e)));
  req.end();
});
