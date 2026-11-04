// The checks' browser: a folder served over http on a free port, and a headless Chromium that may load only from it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { Files, Probe } from "./types.ts";

const TEXT = /\.(html?|css|m?js|json|txt|md|svg|xml|csv)$/i;

/** The folder's text files, by their path relative to it ("/" between folders). */
export function readFiles(dir: string): Files {
  const files: Files = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (TEXT.test(name)) files[relative(dir, path).split(sep).join("/")] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return files;
}

/** Runs fn with a Probe on the folder; the server and the browser stop after it. */
export async function withProbe<T>(dir: string, fn: (p: Probe) => Promise<T>): Promise<T> {
  const root = resolve(dir);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      let path = resolve(root, `.${decodeURIComponent(new URL(req.url).pathname)}`);
      if (path != root && !path.startsWith(root + sep)) return new Response("Not found", { status: 404 });
      try {
        if (statSync(path).isDirectory()) path = join(path, "index.html");
        if (statSync(path).isFile()) return new Response(Bun.file(path));
      } catch {}
      return new Response("Not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}/`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route("**/*", (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const problems = new WeakMap<Page, string[]>();
    return await fn({
      async open(path = "index.html") {
        const page = await context.newPage();
        const list: string[] = [];
        problems.set(page, list);
        page.on("pageerror", (e) => list.push(`script error: ${e.message}`));
        page.on("response", (r) => {
          if (r.url().startsWith(base) && r.status() >= 400) list.push(`${r.status()} ${r.url().slice(base.length)}`);
        });
        await page.goto(base + path.replace(/^\.?\//, ""), { waitUntil: "load" });
        return page;
      },
      errors: (page) => problems.get(page) ?? [],
    });
  } finally {
    await browser.close();
    server.stop(true);
  }
}
