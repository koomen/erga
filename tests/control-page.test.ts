// The control Worker's page shell (controlLayout): the Source page's script runs
// in it. That script reads window.ergaView at once, so the shell must set it first.
import { expect, test } from "bun:test";
import { controlLayout } from "../control/routes";
import { adminSourcePage } from "../server/source/index";
import type { Session } from "../server/identity/index";

test("the Source page on the control Worker sets window.ergaView before its script reads it", async () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const r = adminSourcePage({ session, admin: true, ready: true, origin: "https://ops.erga.test", mirrorUrl: "", worker: null, layout: controlLayout("https://erga.test") });
  const html = await r.text();
  const set = html.indexOf("window.ergaView =");
  const read = html.indexOf("const pageView = window.ergaView");
  expect(read).toBeGreaterThan(0);
  expect(set).toBeGreaterThan(0);
  expect(set).toBeLessThan(read);
});

test("the Source page's scripts parse, and each deploy column has a name and its host", async () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const html = await adminSourcePage({ session, admin: true, ready: true, origin: "https://ops.erga.test", mirrorUrl: "", worker: null, layout: controlLayout("https://erga.test") }).text();
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type="(module|application\/json)"/.test(m[1])).map((m) => m[2]);
  expect(scripts.length).toBeGreaterThan(0);
  // A raw newline in a string (a "\n" not escaped in the template) stops the whole page: no rows, no deploys.
  for (const code of scripts) expect(() => new Function(code)).not.toThrow();
  const heads = [...html.matchAll(/id="target-([a-z]+)"[^>]*><b>([^<]+)<\/b><span class="host">([^<]+)<\/span>/g)].map((m) => m.slice(1));
  expect(heads).toEqual([["staging", "staging", "staging.erga.dev"], ["production", "production", "erga.dev"], ["control", "control", "ops.erga.dev"]]);
});
