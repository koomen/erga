#!/usr/bin/env bun
// The multiplayer suite: black-box tests of a document room and its agents,
// through the deployment's public surface only, so the same run works
// against the local host and a deployment. See tests/suite/README.md.
//
//   bun tests/suite/run.ts                      local host, every suite
//   bun tests/suite/run.ts --suite fuzz,agent   some suites
//   bun tests/suite/run.ts --grep "restart"     tests whose name matches
//   bun tests/suite/run.ts --seed 1234          replay a randomised run
//   bun tests/suite/run.ts --long               bigger crowds, longer runs, real idle eviction waits
//   bun tests/suite/run.ts --repeat 5           run it all five times (new seeds)
//   bun tests/suite/run.ts --remote             against SCRATCHWORK_TARGET_DOC (see target.ts)
//   bun tests/suite/run.ts --live-agent         local, with the real model instead of the script
//   bun tests/suite/run.ts --json out.json      also write the results as JSON

import { writeFileSync } from "fs";
import { runTests, type Result, type Test } from "./harness";
import { LocalTarget, RemoteTarget, type Target } from "./target";
import { sync } from "./suites/sync";
import { fuzz } from "./suites/fuzz";
import { durability } from "./suites/durability";
import { presence } from "./suites/presence";
import { robustness } from "./suites/robustness";
import { agent } from "./suites/agent";
import { latency } from "./suites/latency";
import { browserTests, closeBrowser } from "./suites/browser";

const SUITES: { name: string; tests: Test[] }[] = [
  { name: "sync", tests: sync },
  { name: "presence", tests: presence },
  { name: "agent", tests: agent },
  { name: "durability", tests: durability },
  { name: "robustness", tests: robustness },
  { name: "fuzz", tests: fuzz },
  { name: "latency", tests: latency },
  { name: "browser", tests: browserTests },
];

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string) => args.includes(name);

const only = opt("--suite")?.split(",");
const unknown = only?.filter((s) => !SUITES.some((x) => x.name == s));
if (unknown?.length) { console.error(`no such suite: ${unknown.join(", ")} (have ${SUITES.map((s) => s.name).join(", ")})`); process.exit(2); }
const suites = SUITES.filter((s) => !only || only.includes(s.name));
const target: Target = has("--remote") ? new RemoteTarget() : new LocalTarget({ liveAgent: has("--live-agent"), browser: !has("--no-browser") });
const repeat = Number(opt("--repeat") ?? 1);
const firstSeed = Number(opt("--seed") ?? (Date.now() % 1_000_000));

console.log(`target: ${target.name}  capabilities: ${[...target.caps].join(", ")}`);
const all: (Result & { seed: number })[] = [];
try {
  for (let r = 0; r < repeat; r++) {
    const seed = firstSeed + r;
    console.log(`\n=== seed ${seed}${repeat > 1 ? ` (run ${r + 1} of ${repeat})` : ""}${has("--long") ? ", long" : ""}`);
    const results = await runTests(target, suites, { seed, long: has("--long"), filter: opt("--grep") ? new RegExp(opt("--grep")!, "i") : undefined, verbose: has("--verbose") });
    all.push(...results.map((x) => ({ ...x, seed })));
  }
} finally {
  await closeBrowser();
  await target.close();
}

const count = (s: Result["status"]) => all.filter((x) => x.status == s).length;
console.log(`\n${count("pass")} passed, ${count("fail")} failed, ${count("known")} known gaps, ${count("skip")} skipped`);
for (const f of all.filter((x) => x.status == "fail")) console.log(`  FAIL ${f.suite}: ${f.name}  (seed ${f.seed}: bun tests/suite/run.ts --suite ${f.suite} --grep ${JSON.stringify(f.name.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))} --seed ${f.seed})`);
const json = opt("--json");
if (json) writeFileSync(json, JSON.stringify({ target: target.name, caps: [...target.caps], results: all }, null, 2));
process.exit(count("fail") ? 1 : 0);
