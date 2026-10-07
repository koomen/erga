// The browser the tests drive: Chromium through e2e's web engine (Playwright
// underneath, pinned by @e2e-dev/web). One instance, shared by the config and
// the fixtures: surfaceOf(engine) is how a test reaches the attempt's page.
// A factory VM's image has Chromium of its own (factory/vm/Dockerfile), but the
// engine launches the browser its Playwright pins: `bunx @e2e-dev/web install chromium`.

import { web } from "@e2e-dev/web";

export const engine = web({ browser: "chromium", viewport: { width: 1100, height: 800 } });
