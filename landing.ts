#!/usr/bin/env bun
// Publishes the repo's landing project (server.config.ts, `landing`: a
// folder with index.html or index.md) to a server and makes it the front
// page, the way any agent would: through the server's API, with an agent
// token.
//
//   bun landing.ts [server]        server: the argument, else ERGA_URL, else https://erga.dev
//
// The token is ERGA_DEPLOY_TOKEN: an admin's agent token (make one at
// <server>/tokens). The landing document is that admin's, at
// /<their login>/<the folder's name> ("landing"), and each run publishes
// into the same one (POST /api/publish with document=, replacing its files:
// open tabs see the change as an edit), making it the first time. Then it
// sets landing_document to it, so the front page shows it. If the deploy
// locks landing_document (server.config.ts) it publishes into the document
// that names instead, and sets nothing.
//
// `bun run deploy` runs it after `cf deploy`; on Workers Builds the deploy
// command is `bunx cf deploy && bun landing.ts`, with ERGA_DEPLOY_TOKEN set
// as a build secret. `bun start` does the same against the local server as it
// starts (dev/plugin.ts), with a token the dev server makes for DEV_LOGIN.
// With no landing project (landing: null, or ERGA_LANDING=""), it does nothing.

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const TEXT = /\.(html?|md|markdown|css|m?js|json|svg|txt|xml|csv)$/i;

/** A folder's files, by path relative to it, as the API takes them: text as text, anything else as base64. Dotfiles left out. */
export async function readProject(folder: string): Promise<Record<string, string | { base64: string }>> {
  const out: Record<string, string | { base64: string }> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      const rel = relative(folder, full).split("\\").join("/");
      const bytes = await readFile(full);
      out[rel] = TEXT.test(rel) ? bytes.toString("utf8") : { base64: bytes.toString("base64") };
    }
  };
  await walk(folder);
  if (!out["index.html"] && !out["index.md"]) throw new Error(`${folder} has no index.html or index.md: it isn't a page`);
  return out;
}

export interface Published {
  id: string;
  url: string;
  address: string;
  /** Made by this run (else published into the one there was). */
  created: boolean;
  /** Whether landing_document was set by this run (it isn't when it already named it, or the deploy locks it). */
  set: boolean;
}

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

/**
 * Publishes `folder` to `server` as `token`'s person's document at
 * /<login>/<slug> (made if it isn't there, else published into) and makes it
 * the front page (landing_document). `wait`: how long to keep asking a server
 * that doesn't know landing_document yet (a deploy still rolling out), in ms.
 */
export async function publishLanding(opts: { server: string; token: string; folder: string; slug?: string; wait?: number; log?: (line: string) => void }): Promise<Published> {
  const server = opts.server.replace(/\/+$/, "");
  const log = opts.log ?? (() => {});
  const slug = opts.slug ?? (basename(resolve(opts.folder)).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "landing");
  const files = await readProject(opts.folder);
  const call = async (path: string, body: unknown) => {
    const r = await fetch(server + path, { method: "POST", headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const answer = (await r.json().catch(() => ({ ok: false, error: `${server}${path} answered ${r.status}, not JSON` }))) as { ok: boolean; error?: string; content?: { text: string }[] } & Record<string, unknown>;
    if (!r.ok || !answer.ok) throw new ApiError(answer.error ?? `${server}${path} answered ${r.status}`, r.status);
    return answer;
  };
  const tool = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => JSON.parse((await call(`/api/ext/tools/${name}`, args)).content?.[0]?.text ?? "null") as T;

  // An admin's token, on a server that has the setting (just after a deploy, the old Worker may still be answering).
  type Entry = { key: string; value: unknown; locked: boolean };
  let entry: Entry | undefined;
  for (const until = Date.now() + (opts.wait ?? 0); ;) {
    let settings: Entry[];
    try { settings = await tool<Entry[]>("list_settings"); } catch (e) {
      if (e instanceof ApiError && (e.status == 401 || e.status == 403)) throw new Error(`${server} won't let this token change its settings: the landing page needs an admin's agent token (make one at ${server}/tokens). It said: ${e.message}`);
      throw e;
    }
    entry = settings.find((s) => s.key == "landing_document");
    if (entry || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!entry) throw new Error(`${server} has no landing_document setting: is it running this version of Erga?`);
  const { login } = await tool<{ login: string }>("whoami");

  // Into the same document each time: the one the deploy locks, else this person's at /<login>/<slug>.
  const target = entry.locked ? String(entry.value ?? "") : `/${login}/${slug}`;
  if (entry.locked && !target) throw new Error("The deploy locks landing_document to nothing: take it out of server.config.ts, or lock it to a document.");
  let doc: { id: string; url: string; address: string }, created = false;
  try {
    doc = await call("/api/publish", { document: target, files }) as unknown as typeof doc;
  } catch (e) {
    if (!(e instanceof ApiError && e.status == 404) || entry.locked) throw e;
    doc = await call("/api/publish", { files, slug }) as unknown as typeof doc;
    created = true;
  }
  const refused = (doc as { refused?: { path: string; why: string }[] }).refused ?? [];
  log(`${created ? "published" : "republished"} ${opts.folder} at ${doc.url}${refused.length ? ` (refused: ${refused.map((r) => `${r.path}, ${r.why}`).join("; ")})` : ""}`);
  let set = false;
  if (!entry.locked && entry.value != doc.id) {
    await tool("set_setting", { key: "landing_document", value: doc.id });
    set = true;
    log(`landing_document is now ${doc.address}: ${server}/ shows it`);
  }
  return { id: doc.id, url: doc.url, address: doc.address, created, set };
}

if ((import.meta as { main?: boolean }).main) {
  const { landingFolder } = await import("./server.config.ts");
  const folder = landingFolder();
  if (!folder) { console.log("No landing project (server.config.ts, landing): nothing to publish."); process.exit(0); }
  const server = process.argv[2] ?? process.env.ERGA_URL ?? "https://erga.dev";
  const token = process.env.ERGA_DEPLOY_TOKEN?.trim();
  if (!token) {
    console.error(`landing.ts: set ERGA_DEPLOY_TOKEN to an admin's agent token (make one at ${server}/tokens) to publish the landing project (${folder}) to ${server}. On Workers Builds it's a build secret.`);
    process.exit(1);
  }
  const root = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
  const path = resolve(root, folder);
  if (!(await stat(path).catch(() => null))?.isDirectory()) { console.error(`landing.ts: the landing project ${folder} isn't a folder in the repo.`); process.exit(1); }
  try {
    await publishLanding({ server, token, folder: path, slug: basename(path), wait: process.env.WORKERS_CI ? 120_000 : 15_000, log: (l) => console.log(l) });
  } catch (e) {
    console.error(`landing.ts: ${(e as Error).message}`);
    process.exit(1);
  }
}
