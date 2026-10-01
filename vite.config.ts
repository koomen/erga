import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

/** Markdown imported as text (`with { type: "text" }`), as Bun does natively. */
const markdownAsText: Plugin = {
  name: "erga:markdown-as-text",
  transform: (code, id) => (id.endsWith(".md") ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined),
};

export default defineConfig({
  // The editor's own files, gathered by `bun run site`: they're the Worker's static assets.
  publicDir: ".site",
  plugins: [markdownAsText, cloudflare()],
});
