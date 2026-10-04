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
import { publishFiles, TEXT, type Files, type Published } from "./landing-publish.ts";

export type { Published };


/** A folder's files, by path relative to it, as the API takes them: text as text, anything else as base64. Dotfiles left out. */
export async function readProject(folder: string): Promise<Files> {
  const out: Files = {};
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

/**
 * Publishes `folder` to `server` as `token`'s person's document at
 * /<login>/<slug> (made if it isn't there, else published into) and makes it
 * the front page (landing_document): see publishFiles.
 */
export async function publishLanding(opts: { server: string; token: string; folder: string; slug?: string; wait?: number; log?: (line: string) => void }): Promise<Published> {
  const slug = opts.slug ?? (basename(resolve(opts.folder)).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "landing");
  return publishFiles({ ...opts, slug, files: await readProject(opts.folder) });
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
