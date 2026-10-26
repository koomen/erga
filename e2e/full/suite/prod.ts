#!/usr/bin/env bun
// Runs the multiplayer suite against erga.dev, or any deployment (ERGA_PROD_URL), with a test token
// from its /tokens page:
//
//   ERGA_TEST_TOKEN=erga_test_... bun run test:prod [e2e run arguments: --grep, files under e2e/full/suite, ...]
//
// The token signs in test people (Tester, Ada, Bo, ...), each with their own session cookie, and the suite's
// remote target makes each test a fresh test document (/new?id=test...), whose agent is the
// scripted one if the deployment runs it (ERGA_TARGET_CAPS, "browser,scriptedAgent" by default; leave scriptedAgent
// out for production). The correctness tests run first, then the latency bench (e2e/bench/latency.e2e.ts:
// budget 400 ms, or ERGA_SUITE_P95_MS).
// The cookies go to the tests in a file only this user can read (ERGA_SUITE_TARGET, e2e/full/suite/suite.ts), removed after.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = (process.env.ERGA_PROD_URL || "https://erga.dev").replace(/\/+$/, "");
const token = process.env.ERGA_TEST_TOKEN;
if (!token) {
  console.error(`set ERGA_TEST_TOKEN to a token from ${base}/tokens`);
  process.exit(2);
}

/** A test person's session cookie. */
async function cookieFor(name: string): Promise<string> {
  const r = await fetch(`${base}/auth/test?token=${encodeURIComponent(token!)}&as=${encodeURIComponent(name)}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const cookie = (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).find((c) => /^erga_session(_\d+)?=/.test(c));
  if (!cookie) throw new Error(`signing in ${name}: ${r.status} ${await r.text()}`);
  return cookie;
}

const tester = await cookieFor("Tester");
const users: Record<string, { Cookie: string }> = {};
for (const name of ["Ada", "Bo", "Cy", "Dee"]) users[name] = { Cookie: await cookieFor(name) };
// A first test document, which RemoteTarget checks the address of; each test then makes its own.
const made = await fetch(`${base}/new?id=${process.env.ERGA_TEST_DOC || "testsuit"}`, { headers: { Cookie: tester }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
const location = made.headers.get("location");
if (made.status != 302 || !location) throw new Error(`making the test document: ${made.status} ${await made.text()}`);
const first = new URL(location, base);
first.hash = "";
const doc = first.toString();
console.log(`suite against ${base} (first document ${doc})`);

const dir = mkdtempSync(join(tmpdir(), "erga-prod-"));
const file = join(dir, "target.json");
writeFileSync(file, JSON.stringify({
  ERGA_TARGET_DOC: doc,
  ERGA_TARGET_COOKIE: tester,
  ERGA_TARGET_USERS: JSON.stringify(users),
  ERGA_TARGET_CAPS: process.env.ERGA_TARGET_CAPS || "browser,scriptedAgent",
  ERGA_TARGET_NEW_DOC: `${base}/new?id={id}`,
}), { mode: 0o600 });
const env = { ...process.env, ERGA_SUITE_TARGET: file };
const args = process.argv.slice(2);
const root = new URL("../../..", import.meta.url).pathname;
let code = 0;
try {
  // Four tests at a time: each makes its documents and people on the deployment. Everything runs, with a retry each.
  const files = args.some((a) => a.startsWith("e2e/")) ? [] : ["e2e/full/suite"];
  code =
    spawnSync("bun", ["e2e/run.ts", "--e2e", "--workers", "4", ...files, ...args], {
      cwd: root,
      env,
      stdio: "inherit",
      timeout: 30 * 60_000,
    }).status ?? 1;
  if (!args.some((a) => a.startsWith("e2e/"))) {
    const bench =
      spawnSync("bun", ["e2e/run.ts", "--e2e", "e2e/bench/latency.e2e.ts", ...args], {
        cwd: root,
        env,
        stdio: "inherit",
        timeout: 10 * 60_000,
      }).status ?? 1;
    code ||= bench;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
