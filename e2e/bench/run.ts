#!/usr/bin/env bun
// How fast a document loads, in the viewer and in the editor, and how fast a
// typed key shows: a benchmark in a real browser (headless Chromium, the e2e
// suite's), against a dev server of its own (e2e/server.ts, as the e2e suite
// starts one). It prints numbers; it doesn't pass or fail. `bun run test`
// doesn't run it.
//
//   bun run bench                          5 runs; the table, and .bench/results.json
//   bun run bench --compare e2e/bench/baseline.json   also each number before and after
//
//   --runs 5          runs of each case; the tables show medians
//   --rtt 50          the network's round trip, ms (the proxy adds it: proxy.ts)
//   --handshake 2     round trips more for each new connection (TCP and TLS)
//   --latency 30      ms each call to the database or a document's Durable Object
//                     waits first (ERGA_REMOTE_LATENCY_MS: cloudflare/timing.ts)
//   --keys 30         keys typed in each run of the key press case
//   --key-gap 100     ms from one key press to the next
//   --only viewer     only the cases whose name has this in it ("large", "editor", "keys")
//   --out FILE        where the JSON goes (.bench/results.json)
//   --compare FILE    an earlier JSON: prints each median before and after
//   --waterfall       prints the requests of each case's last run
//   --headed          shows the browser
//
// The cases, for a small document (10 kB of HTML) and a large one (200 kB):
//
//   viewer cold   the document's address in a new browser profile (nothing
//                 cached), the document a new copy (its Durable Object has its
//                 files but hasn't opened its room)
//   viewer warm   the same address again, in the same profile
//   editor cold   the address with #edit, as for the viewer
//   editor warm   the same again
//   keys          after "editor warm": a key press each 100 ms at the end of the typing line
//
// The browser runs as Chrome does (each site in its own process). Requests
// from the browser to the internet fail at once (the server's own only):
// the runs don't depend on the network.
//
// What each number means: measure.ts (the loads) and report.ts (the tables).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { ROOT } from "../env";
import { startServer, type Server } from "../server";
import { Docs, LARGE, SMALL, type DocKind } from "./docs";
import { keystrokes, load, Tab, type Keys, type Load } from "./measure";
import { startProxy, type Hit } from "./proxy";
import { compare, summarize, table, type Results } from "./report";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback; };
if (args.includes("--help") || args.includes("-h")) {
  console.log(readFileSync(import.meta.path, "utf8").split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
const RUNS = Number(opt("--runs", "5"));
const RTT = Number(opt("--rtt", "50"));
const HANDSHAKE = Number(opt("--handshake", "2"));
const LATENCY = Number(opt("--latency", "30"));
const KEYS = Number(opt("--keys", "30"));
const KEY_GAP = Number(opt("--key-gap", "100"));
const ONLY = opt("--only", "");
const OUT = resolve(opt("--out", join(ROOT, ".bench/results.json")));
const COMPARE = opt("--compare", "");
const wanted = (name: string) => !ONLY || name.includes(ONLY);

const log = (s: string) => process.stderr.write(s + "\n");
const git = (...a: string[]) => spawnSync("git", a, { cwd: ROOT, encoding: "utf8" }).stdout?.trim() ?? "";
const commit = `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain", "--untracked-files=no") ? "+changes" : ""}`;

// The editor's files, built once, as the e2e suite builds them (e2e.config.ts).
if (!process.env.ERGA_BUILT) {
  log("building the editor (client/build.ts)...");
  if (spawnSync("bun", ["client/build.ts"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], timeout: 180_000 }).status != 0) throw new Error("client/build.ts failed");
}
log("starting the dev server...");
const server: Server = await startServer({ processEnv: LATENCY ? { ERGA_REMOTE_LATENCY_MS: String(LATENCY) } : {} });
const proxy = await startProxy(server.root, { rtt: RTT, handshake: HANDSHAKE });
const docs = new Docs(server.root);
const browser = await chromium.launch({
  headless: !args.includes("--headed"),
  // Only the local server: anything else (an avatar from GitHub) fails at once.
  args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost, EXCLUDE 127.0.0.1"],
});
const newContext = () => browser.newContext({ viewport: { width: 1300, height: 860 } });

const loads: Record<string, Load[]> = {};
const keys: Record<string, Keys[]> = {};
/** Each case's last run's requests, for --waterfall. */
const lastRequests: Record<string, Hit[]> = {};
const record = (name: string, l: Load & { requests: Hit[] }) => {
  const { requests, ...rest } = l;
  (loads[name] ??= []).push(rest);
  lastRequests[name] = requests;
};

/** The viewer, cold then warm, on a new copy of the document. */
async function viewer(kind: DocKind, keep: boolean) {
  const doc = await docs.fresh(kind);
  const url = `${proxy.root}${doc.address}`;
  const tab = await Tab.open(newContext, proxy);
  try {
    const cold = await load(tab, proxy, docs, { id: doc.id, url }, { edit: false });
    await tab.page.goto("about:blank");
    const warm = await load(tab, proxy, docs, { id: doc.id, url }, { edit: false });
    if (keep) { record(`${kind.name} viewer cold`, cold); record(`${kind.name} viewer warm`, warm); }
  } finally { await tab.close(); }
}

/** The editor, cold then warm, on a new copy of the document; then key presses in it. */
async function editor(kind: DocKind, keep: boolean) {
  const doc = await docs.fresh(kind);
  const url = `${proxy.root}${doc.address}#edit`;
  const tab = await Tab.open(newContext, proxy);
  try {
    const cold = await load(tab, proxy, docs, { id: doc.id, url }, { edit: true });
    // Away first: the same address again would be a jump within the page, not a load.
    await tab.page.goto("about:blank");
    const warm = await load(tab, proxy, docs, { id: doc.id, url }, { edit: true });
    if (keep && wanted(`${kind.name} editor`)) { record(`${kind.name} editor cold`, cold); record(`${kind.name} editor warm`, warm); }
    if (wanted(`${kind.name} keys`) || wanted(`${kind.name} editor`)) {
      const k = await keystrokes(tab, docs, doc.id, KEYS, KEY_GAP);
      if (keep) (keys[kind.name] ??= []).push(k);
    }
  } finally { await tab.close(); }
}

let failed = false;
try {
  const kinds = [SMALL, LARGE].filter((k) => wanted(`${k.name} viewer`) || wanted(`${k.name} editor`) || wanted(`${k.name} keys`));
  // Once, not counted: the dev server compiles the Worker's modules on first use.
  log("warming the server up...");
  for (const kind of kinds) { await viewer(kind, false); await editor(kind, false); }
  for (let i = 0; i < RUNS; i++) {
    log(`run ${i + 1} of ${RUNS}...`);
    for (const kind of kinds) {
      if (wanted(`${kind.name} viewer`)) await viewer(kind, true);
      if (wanted(`${kind.name} editor`) || wanted(`${kind.name} keys`)) await editor(kind, true);
    }
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  proxy.stop();
  server.dispose();
}
if (failed) process.exit(1);

const results = summarize({
  date: new Date().toISOString(), commit, runs: RUNS, rttMs: RTT, handshakeRtts: HANDSHAKE, serverLatencyMs: LATENCY, keys: KEYS, keyGapMs: KEY_GAP,
  server: "dev server (e2e/server.ts) behind a proxy (e2e/bench/proxy.ts)",
}, loads, keys);
console.log("\n" + table(results));
if (args.includes("--waterfall")) {
  for (const [name, hits] of Object.entries(lastRequests)) {
    console.log(`\n${name} (the last run): ms from the first request`);
    const t0 = Math.min(...hits.map((h) => h.start));
    for (const h of [...hits].sort((a, b) => a.start - b.start)) {
      const url = h.url.replace(/^https?:\/\//, "").replace(/\/t\/[^/]{20,}\//, "/t/…/").slice(0, 90);
      console.log(`  ${String(Math.round(h.start - t0)).padStart(6)} ${String(h.end ? Math.round(h.end - t0) : "").padStart(6)}  ${String(h.status).padStart(3)} ${(h.bytes / 1024).toFixed(1).padStart(7)} kB  ${h.dest.padEnd(9)} ${url}`);
    }
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
log(`\nwrote ${OUT}`);
if (COMPARE) console.log("\n" + compare(JSON.parse(readFileSync(resolve(COMPARE), "utf8")) as Results, results));
process.exit(0);
