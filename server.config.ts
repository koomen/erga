// The server settings this repo's deploy fixes (config.ts, SETTINGS). A key
// set here is locked: erga.dev (and local development, `bun start`) uses
// this value, and nobody can change it in the admin page, the API or through
// an agent; the admin page shows it read-only, with this value. A key left
// out is the admins' to set (the server_config table, in D1).
//
// ERGA_SERVER_CONFIG, a JSON object in the environment of the deploy (or of
// `bun start`), adds to these or overrides them, e.g.
//
//     ERGA_SERVER_CONFIG='{"unedited_hours":72}' bun start
//
// cloudflare.config.ts hands them to the Worker as the SERVER_CONFIG
// binding. `bun server.config.ts` checks them against SETTINGS (a key that
// isn't one, or a value it won't take) and prints them; site.sh runs it
// before every deploy and dev.ts before it starts, so a bad one fails there.
//
// Take a key out and deploy to hand it back to the admins: what they set
// before it was locked counts again.
//
// `landing` names the repo's landing project: a folder (with index.html or
// index.md, and whatever it uses) whose page is the server's front page.
// After each deploy, `bun landing.ts` publishes it to the server through the
// server's API (POST /api/publish), as a document of whoever's token the
// deploy holds (ERGA_DEPLOY_TOKEN, an admin's), into the same document each
// time, and sets the landing_document setting to it. `bun start` does the
// same against the local server as it starts. null: the repo has none, and
// the front page is whatever the admins choose (landing_document on /admin).
// ERGA_LANDING, in the environment, overrides it for one deploy or dev
// server: a folder, or "" for none.

import type { SETTINGS } from "./config.ts";

type Values = { [K in keyof typeof SETTINGS]?: ReturnType<(typeof SETTINGS)[K]["parse"]> };

const settings: Values = {
  // unedited_hours: 24,
};
export default settings;

/** The repo's landing project: a folder, relative to the repo (see above), or null for none. */
export const landing: string | null = "landing";

/** The landing project's folder as this deploy or dev server has it (ERGA_LANDING over `landing`), relative to the repo; null for none. */
export function landingFolder(env: Record<string, string | undefined> = process.env): string | null {
  if (env.ERGA_LANDING !== undefined) return env.ERGA_LANDING.trim() || null;
  return landing;
}

// (This file is loaded by cloudflare.config.ts under Node's type stripping,
// and must not import config.ts itself: the dev server can't then load it
// into the Worker. Hence the check below imports it only when run.)

/** What the deploy fixes: the settings above, with ERGA_SERVER_CONFIG (JSON) over them. Unchecked. */
export function deployed(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const extra = env.ERGA_SERVER_CONFIG?.trim();
  let over: unknown = {};
  if (extra) {
    try { over = JSON.parse(extra); } catch { throw new Error(`ERGA_SERVER_CONFIG isn't JSON: ${extra.slice(0, 200)}`); }
    if (!over || typeof over != "object" || Array.isArray(over)) throw new Error(`ERGA_SERVER_CONFIG must be a JSON object of settings by key, not ${extra.slice(0, 200)}`);
  }
  return { ...settings, ...(over as Record<string, unknown>) };
}

if (import.meta.main) {
  const { deployedSettings } = await import("./config.ts");
  try {
    const values = deployedSettings(deployed());
    console.log(Object.keys(values).length ? `The deploy locks: ${JSON.stringify(values)}` : "The deploy locks no settings.");
  } catch (e) {
    console.error(`server.config.ts: ${(e as Error).message}`);
    process.exit(1);
  }
}
