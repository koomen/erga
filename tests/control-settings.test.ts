// The control Worker reads its settings from its bindings at each request (control/settings.ts). No other test runs
// its entry (control/index.ts), and a control Worker that can't read them can't deploy its own fix: so here they are
// read from what a deploy gives it, control/wrangler.jsonc's vars as deploy/targets.json fills them in, beside the
// bindings that aren't text.

import { expect, test } from "bun:test";
import { controlWranglerConfig } from "../deploy/release.ts";
import { controlSettings } from "../control/settings.ts";

const vars = (controlWranglerConfig() as { vars?: Record<string, string> }).vars ?? {};
const bindings = { PIPELINE: { getByName: () => null }, SOURCE: {}, DB: {}, CF_VERSION_METADATA: { id: "v1" } };

test("the control Worker reads its settings from the vars a deploy gives it", () => {
  // control/deploys/control-worker.ts adds these two to the config's vars when it deploys the control Worker.
  const set = controlSettings({ ...bindings, ...vars, ERGA_VERSION: " 6aab943 ", CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) });
  expect(set.app).toBe(vars.APP_URL);
  expect(set.app).toStartWith("https://");
  expect(set.accountId).toBe("0".repeat(32));
  expect(set.version).toBe("6aab943");
  expect(set.upstream).toBeNull();
  expect(set.googleId).toBeNull();
  expect(set.oauthSecret).toBe("");
});

test("a downstream's control Worker: its upstream, without a trailing slash; only APP_URL is a must", () => {
  expect(controlSettings({ APP_URL: "https://docs.example.com", UPSTREAM: " https://erga.dev/ " }).upstream).toBe("https://erga.dev");
  expect(controlSettings({ APP_URL: "https://docs.example.com" }).accountId).toBe("");
  expect(() => controlSettings({})).toThrow(/APP_URL/);
});
