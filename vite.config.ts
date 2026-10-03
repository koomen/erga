import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { ergaDev } from "./dev/plugin.ts";

/** Markdown imported as text (`with { type: "text" }`), as Bun does natively. */
const markdownAsText: Plugin = {
  name: "erga:markdown-as-text",
  transform: (code, id) => (id.endsWith(".md") ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined),
};

// The Worker's local state: its Durable Objects' storage, and the files linked to documents.
const stateDir = resolve(process.env.ERGA_STATE_DIR || ".cloudflare/state");
// What the dev server proves itself to the Worker with (cloudflare.config.ts reads it): new each run unless dev.ts set it.
process.env.ERGA_LINK_SECRET ||= randomBytes(24).toString("hex");

export default defineConfig({
  // The editor's own files, gathered by site.sh: they're the Worker's static assets.
  publicDir: ".site",
  // Tests point these elsewhere: their own .dev.vars, and a cache of their own so servers started at once don't trip on each other.
  envDir: process.env.ERGA_ENV_DIR || undefined,
  cacheDir: process.env.ERGA_VITE_CACHE || undefined,
  // Only this machine: in development anyone who reaches the server is signed in (DEV_LOGIN).
  // Agents' scratch copies of this repo are no part of it.
  server: { host: "127.0.0.1", watch: { ignored: ["**/.claude/**"] } },
  plugins: [
    markdownAsText,
    ergaDev({
      stateDir,
      secret: process.env.ERGA_LINK_SECRET,
      open: process.env.ERGA_OPEN || undefined,
      browser: process.env.ERGA_BROWSER == "1",
      cwd: process.env.ERGA_CWD || process.cwd(),
    }),
    cloudflare({ persistState: { path: stateDir }, ...(process.env.ERGA_INSPECTOR == "0" ? { inspectorPort: false } : {}) }),
  ],
});
