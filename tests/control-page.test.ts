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
