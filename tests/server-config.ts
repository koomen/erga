#!/usr/bin/env bun
// The settings a deploy fixes (server.config.ts, ERGA_SERVER_CONFIG) reach
// the Worker (cloudflare.config.ts → SERVER_CONFIG → worker/d1.ts) and win:
// a dev server started with unedited_hours locked to 3 says so on /docs and
// gives a new document 3 hours. A value the settings won't take stops the
// server from starting, saying why. (What's locked can't be changed by
// anyone: tests/directory.test.ts.)
//
//   bun tests/server-config.ts

import { startHost } from "./host";
import { expect } from "./suite/harness";

const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

const host = await startHost(null, { env: { ERGA_SERVER_CONFIG: JSON.stringify({ unedited_hours: 3 }) } });
try {
  const login = `cfg${Date.now().toString(36)}`;
  const signedIn = await fetch(`${host.root}/auth/github?as=${login}&next=/docs`, { redirect: "manual" });
  const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="));
  expect(cookie, "signed in", signedIn.status);
  const get = (path: string) => fetch(host.root + path, { redirect: "manual", headers: { Cookie: cookie } });

  const empty = await (await get("/docs")).text();
  expect(empty.includes("goes away after 3 hours"), "/docs gives the deployed unedited_hours", empty.slice(0, 2000));
  ok("the deploy's unedited_hours (3) reaches the server");

  const made = await get("/new");
  expect(made.status == 302, "/new makes a document", made.status);
  const listed = await (await get("/docs")).text();
  expect(/deleted in [23]h/.test(listed) && listed.includes("deleted 3 hours after"), "a new document goes in 3 hours", listed.match(/<span class="note"[^]*?<\/span>/)?.[0]);
  ok("a new document gets the deployed 3 hours");
} finally {
  await host.dispose();
}

// A deploy config the settings won't take: the server doesn't start, and says why.
const bad = await startHost(null, { env: { ERGA_SERVER_CONFIG: JSON.stringify({ unedited_hours: "soon" }) } }).then(
  async (h) => { await h.dispose(); return null; },
  (e: Error) => e.message,
);
expect(bad && /unedited_hours to "soon", but it must be a whole number/.test(bad), "a bad deploy config stops the server, saying why", bad?.slice(-1500));
ok("a bad deploy config fails at start, saying why");

console.log(`\n${checks.length} checks passed`);
process.exit(0);
