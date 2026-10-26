// The control Worker's page shell (controlLayout): the Ops page's script runs
// in it. That script reads window.ergaView at once, so the shell must set it first.
import { expect, test } from "bun:test";
import { controlLayout } from "../control/routes";
import { adminSourcePage } from "../control/source/index";
import type { Session } from "../server/platform";
import { readFileSync } from "node:fs";
import { inlineFunction } from "../server/pages/inline";

/** The Ops page's script as written (client/inline/ops.ts): the page carries it built (server/pages/inline-code.ts). */
const OPS = readFileSync(new URL("../client/inline/ops.ts", import.meta.url), "utf8");

test("the Ops page on the control Worker sets window.ergaView before its script reads it", async () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const r = adminSourcePage({ session, admin: true, ready: true, origin: "https://ops.erga.test", layout: controlLayout("https://erga.test") });
  const html = await r.text();
  const set = html.search(/window\.ergaView\s*=/);
  const read = html.indexOf(inlineFunction("ops"));
  expect(OPS).toContain("const pageView = window.ergaView;");
  expect(read).toBeGreaterThan(0);
  expect(set).toBeGreaterThan(0);
  expect(set).toBeLessThan(read);
});

test("the Ops page's scripts parse, and each deploy column has a name and its host", async () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const html = await adminSourcePage({ session, admin: true, ready: true, origin: "https://ops.erga.test", layout: controlLayout("https://erga.test") }).text();
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type="(module|application\/json)"/.test(m[1])).map((m) => m[2]);
  expect(scripts.length).toBeGreaterThan(0);
  // A raw newline in a string (a "\n" not escaped in the template) stops the whole page: no rows, no deploys.
  for (const code of scripts) expect(() => new Function(code)).not.toThrow();
  const heads = [...html.matchAll(/id="target-([a-z]+)"[^>]*><b>([^<]+)<\/b><span class="host">([^<]+)<\/span>/g)].map((m) => m.slice(1));
  expect(heads).toEqual([["staging", "staging", "staging.erga.dev"], ["production", "production", "erga.dev"], ["control", "control", "ops.erga.dev"]]);
});

test("the Git instructions come before the git log", async () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const html = await adminSourcePage({ session, admin: true, ready: true, origin: "https://ops.erga.test", layout: controlLayout("https://erga.test") }).text();
  expect(html).toContain("git remote add erga https://ops.erga.test/git/erga.git");
  expect(html.indexOf('id="clone"')).toBeGreaterThan(0);
  expect(html.indexOf('id="clone"')).toBeLessThan(html.indexOf('id="grid"'));
});

test("the Ops page asks for the log and statuses at once, and its live updates hold no HTTP connection", async () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const html = await adminSourcePage({ session, admin: true, ready: true, origin: "https://ops.erga.test", layout: controlLayout("https://erga.test") }).text();
  // An EventSource holds one of the browser's six HTTP/1.1 connections to the host while the page is open: a few admin
  // tabs, and the page's own requests wait minutes. The events come over a WebSocket.
  expect(html).not.toContain("new EventSource");
  expect(html).toContain(inlineFunction("ops"));
  expect(OPS).not.toContain("new EventSource");
  expect(OPS).toContain('new WebSocket((location.protocol == "https:" ? "wss://" : "ws://") + location.host + "/api/events")');
  // The first render's requests go out as the script starts, before the socket, and the socket's first open asks again for nothing.
  expect(OPS).toContain("\n  load();\n  loadDeploys();\n  loadReleases();\n  loadDomains();\n  listen();");
  expect(OPS).toContain("events.onopen = () => {\n      if (opened) {");
  // Until the statuses come, a column says it is loading, not "not set up".
  expect(html.match(/id="target-[a-z]+"[^]*?<span class="st"><i><\/i><span>([^<]*)</)?.[1]).toBe("…");
});

test("the sidebar has one Ops link, in place of Source and Cloudflare: here on the control Worker, marked on its pages", async () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const html = await adminSourcePage({ session, admin: true, ready: true, origin: "https://ops.erga.test", layout: controlLayout("https://erga.test") }).text();
  const side = /<nav class="admin-side"[\s\S]*?<\/nav>/.exec(html)![0];
  const labels = [...side.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1]);
  expect(labels).toContain("Ops");
  expect(labels).not.toContain("Source");
  expect(labels).not.toContain("Cloudflare");
  expect(side).toMatch(/<a href="\/" aria-current="page">/);
});
