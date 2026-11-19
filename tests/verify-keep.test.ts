// The verify suite's fast way (`bun erga verify <setting> --keep`, `bun erga verify update <setting>`): what an update
// deploys again (dev/verify/update.ts), the record of the kept settings (dev/verify/cli.ts), what each command does
// from its words (dev/verify/suite.ts, commandOf), and the kept settings on the ops page (deploy/cli/verify-view.ts).
// Nothing deploys, and no account is asked.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Change } from "../deploy/aws/stack";
import { type VerifyFacts, verifyHtml, verifySide } from "../deploy/cli/verify-view";
import type { Release } from "../deploy/pipeline/release-format";
import { readKept, writeKept } from "../dev/verify/cli";
import { issuerPart, workerParts } from "../dev/verify/cloudflare";
import type { Id, Prereq } from "../dev/verify/prereqs";
import type { Run } from "../dev/verify/run";
import {
  commandOf,
  headline,
  hostsOf,
  inTheWay,
  type Kept,
  type Left,
  leftOf,
  type Mode,
  type RunRecord,
  resultOf,
  type State,
  stepAfter,
  units,
} from "../dev/verify/suite";
import { bundleHash, hashOf, type Part, redeploy, releaseHash, remakes } from "../dev/verify/update";

const NOW = Date.parse("2026-11-05T12:00:00Z");

test("a deploy deploys again only the parts whose hash changed, and records each at once", async () => {
  const code: Record<string, string> = { idp: "a", erga: "b", gate: "c" };
  const ran: string[] = [];
  const saved: Record<string, string>[] = [];
  const parts = (fails = ""): Part[] =>
    Object.keys(code).map((name) => ({
      name,
      hash: () => hashOf(code[name]),
      deploy: () => {
        if (name == fails) throw new Error(`${name} did not deploy`);
        ran.push(name);
      },
    }));
  const go = (had: Record<string, string>, fails = "") =>
    redeploy(
      parts(fails),
      had,
      (now) => saved.push(now),
      () => {}
    );
  // A first deploy has no hash on record: each part goes, in order, and its hash is recorded after it.
  expect(await go({})).toEqual(["idp", "erga", "gate"]);
  expect(saved.map((s) => Object.keys(s))).toEqual([["idp"], ["idp", "erga"], ["idp", "erga", "gate"]]);
  const first = saved.at(-1)!;
  expect(first).toEqual({ idp: hashOf("a"), erga: hashOf("b"), gate: hashOf("c") });
  // The same code again: nothing is deployed, and nothing is recorded.
  ran.length = saved.length = 0;
  expect(await go(first)).toEqual([]);
  expect([ran, saved]).toEqual([[], []]);
  // Only Erga's code changed: only Erga goes.
  code.erga = "b2";
  expect(await go(first)).toEqual(["erga"]);
  expect(ran).toEqual(["erga"]);
  expect(saved.at(-1)).toEqual({ ...first, erga: hashOf("b2") });
  // A part that fails stops the deploy: its hash is not recorded (the next update deploys it again), and the parts
  // after it do not run. What went before it stays recorded.
  code.idp = "a2";
  code.gate = "c2";
  ran.length = saved.length = 0;
  await expect(go(first, "erga")).rejects.toThrow("erga did not deploy");
  expect(ran).toEqual(["idp"]);
  expect(saved).toEqual([{ ...first, idp: hashOf("a2") }]);
  // A part's hash is asked just before its turn: it sees what the parts before it did (the issuer's address).
  let address = "";
  const order: Part[] = [
    { name: "idp", hash: () => "1", deploy: () => (address = "https://idp.example") },
    { name: "gate", hash: () => hashOf(address), deploy: () => {} },
  ];
  const kept: Record<string, string>[] = [];
  await redeploy(
    order,
    {},
    (now) => kept.push(now),
    () => {}
  );
  expect(kept.at(-1)!.gate).toBe(hashOf("https://idp.example"));
});

test("a part's hash is of its build's output: the same code gives the same hash", async () => {
  const idp = await bundleHash("dev/verify/idp.ts");
  expect(idp).toMatch(/^[0-9a-f]{64}$/);
  expect(await bundleHash("dev/verify/idp.ts")).toBe(idp);
  expect(await bundleHash("dev/verify/stub.ts")).not.toBe(idp);
  // The issuer's part: its code, where it sends a person back to, and the run's client secret and password.
  const run = { idp: { url: "", secret: "s", password: "p" } };
  const s = { n: 2 } as Parameters<typeof issuerPart>[0];
  const hash = await issuerPart(s, run, "https://s2.example/_edge/callback").hash();
  expect(await issuerPart(s, run, "https://s2.example/_edge/callback").hash()).toBe(hash);
  expect(await issuerPart(s, run, "https://team.example/callback").hash()).not.toBe(hash);
  expect(await issuerPart(s, { idp: { ...run.idp, password: "q" } }, "https://s2.example/_edge/callback").hash()).not.toBe(hash);

  // A setting's Workers: the stub and the gate's own Worker; with the gate inside (OAuth), the stub alone; with a real
  // Erga as the origin, the gate's Worker alone (the Erga is a part of its own: its release).
  const cf = (more: Partial<Run> = {}): Run => ({
    n: 2,
    name: "cf-sso",
    where: "cloudflare",
    who: "sso",
    shell: "s2.verify-shell.example",
    content: "c2.verify-pages.example",
    key: "edge",
    gateKey: "gate",
    parts: {},
    idp: { url: "https://erga-verify-idp-2.example.workers.dev", secret: "s", password: "p" },
    ...more,
  });
  const erga = (hosts: string[]) => ({
    database: "d",
    version: "v",
    session: "s",
    factory: "f",
    docs: hosts.map((host, i) => ({ id: `d${i}`, address: `/ada/d${i}`, host })),
  });
  const hashes = async (r: Run) => Object.fromEntries(await Promise.all(workerParts(r).map(async (p) => [p.name, await p.hash()])));
  expect(Object.keys(await hashes(cf()))).toEqual(["stub", "gate"]);
  expect(Object.keys(await hashes(cf({ who: "oauth" })))).toEqual(["stub"]);
  expect(Object.keys(await hashes(cf({ erga: erga([]) })))).toEqual(["gate"]);
  const before = await hashes(cf());
  expect(await hashes(cf())).toEqual(before);
  // A new key is a new secret of both; a new issuer's address is a setting of the gate's Worker only.
  const rekeyed = await hashes(cf({ gateKey: "another" }));
  expect([rekeyed.stub == before.stub, rekeyed.gate == before.gate]).toEqual([true, false]);
  const moved = await hashes(cf({ idp: { url: "https://other.example.workers.dev", secret: "s", password: "p" } }));
  expect([moved.stub == before.stub, moved.gate == before.gate]).toEqual([true, false]);
  // The real Erga's documents' hosts are the gate's: a new document's host is a new deploy of the gate's Worker.
  const one = await hashes(cf({ erga: erga(["d0-ada.c2.verify-pages.example"]) }));
  expect(await hashes(cf({ erga: erga(["d0-ada.c2.verify-pages.example"]) }))).toEqual(one);
  expect((await hashes(cf({ erga: erga(["d0-ada.c2.verify-pages.example", "d1-ada.c2.verify-pages.example"]) }))).gate).not.toBe(one.gate);

  const bytes = (text: string) => new TextEncoder().encode(text);
  const release = (more: Partial<Release> = {}): Release => ({
    version: "one",
    built: "2026-11-05T11:00:00.000Z",
    worker: {} as Release["worker"],
    mainModule: "index.js",
    modules: { "index.js": bytes("export default {}"), "b.js": bytes("b") },
    assets: { "/page.js": bytes("page") },
    migrations: { "0001.sql": "CREATE TABLE a (b)" },
    ...more,
  });
  const h = releaseHash(release());
  // Not the release's name or its time, and not the order of its files.
  expect(releaseHash(release({ version: "two", built: "2026-11-06T11:00:00.000Z" }))).toBe(h);
  expect(releaseHash(release({ modules: { "b.js": bytes("b"), "index.js": bytes("export default {}") } }))).toBe(h);
  // Each file's bytes count: the Worker's, a static file's, a migration's.
  expect(releaseHash(release({ modules: { "index.js": bytes("export default {a: 1}"), "b.js": bytes("b") } }))).not.toBe(h);
  expect(releaseHash(release({ assets: { "/page.js": bytes("page 2") } }))).not.toBe(h);
  expect(releaseHash(release({ migrations: { "0001.sql": "CREATE TABLE a (b)", "0002.sql": "CREATE TABLE c (d)" } }))).not.toBe(h);
});

test("an update on AWS changes resources in place only: it makes no network, machine, distribution or certificate again", () => {
  const change = (type: string, action = "Modify", replacement?: string): Change => ({ action, resource: "X", type, replacement });
  // The gate's code, new: its functions and its Lambda change in place, the Lambda gets a new version (the old one
  // stays), and a distribution takes the new version.
  expect(
    remakes([
      change("AWS::CloudFront::Function"),
      change("AWS::Lambda::Function"),
      change("AWS::Lambda::Version", "Add"),
      change("AWS::Lambda::Version", "Remove"),
      change("AWS::CloudFront::Distribution"),
    ])
  ).toEqual([]);
  // A resource that AWS would make again, or may make again; a new one; one that goes.
  const no = [
    change("AWS::EC2::Instance", "Modify", "True"),
    change("AWS::CloudFront::Distribution", "Modify", "Conditional"),
    change("AWS::EC2::VPC", "Add"),
    change("AWS::CertificateManager::Certificate", "Remove"),
    change("AWS::CloudFront::KeyValueStore", "Modify", "True"),
  ];
  expect(remakes([change("AWS::CloudFront::Function"), ...no])).toEqual(no);
});

test("a run removes always; with --keep only a deploy that failed is removed; an update removes nothing", () => {
  const walk = (mode: Mode, codes: Record<string, number>, stopAfter = "") => {
    const done: { step: RunRecord["steps"][number]["step"]; code: number }[] = [];
    for (let s = stepAfter(mode, [], false); s; s = stepAfter(mode, done, !!stopAfter && done.some((d) => d.step == stopAfter)))
      done.push({ step: s, code: codes[s] ?? 0 });
    return done.map((d) => d.step).join(" ");
  };
  expect(walk("run", {})).toBe("deploy check remove");
  expect(walk("run", { deploy: 1 })).toBe("deploy remove");
  expect(walk("run", { check: 1 })).toBe("deploy check remove");
  expect(walk("run", {}, "deploy")).toBe("deploy remove");
  expect(walk("keep", {})).toBe("deploy check");
  // Its checks failed: the deploy stays, for an update with the repaired code.
  expect(walk("keep", { check: 1 })).toBe("deploy check");
  expect(walk("keep", { deploy: 1 })).toBe("deploy remove");
  expect(walk("keep", {}, "deploy")).toBe("deploy");
  expect(walk("update", {})).toBe("update check");
  expect(walk("update", { update: 1 })).toBe("update");
  expect(walk("update", { check: 1 })).toBe("update check");
  expect(walk("update", {}, "update")).toBe("update");
});

const record = (steps: [RunRecord["steps"][number]["step"], number][], more: Partial<RunRecord> = {}): RunRecord => ({
  id: "2026-11-05T11-00-00-000Z-5",
  unit: "5",
  command: "bun erga verify update 5",
  from: "terminal",
  pid: 7,
  pidStart: "then",
  commit: "c".repeat(40),
  browsers: ["chromium"],
  started: "2026-11-05T11:00:00.000Z",
  ended: "2026-11-05T11:04:00.000Z",
  steps: steps.map(([step, code]) => ({ step, started: "2026-11-05T11:00:00.000Z", seconds: 100, code })),
  rows: [{ check: "Health", browser: "", ok: true, note: "200" }],
  left: [],
  ...more,
});

test("a run that keeps its deploy passes with its two steps: deploy or update, and check", () => {
  const alive = () => true;
  expect(
    resultOf(
      record([
        ["deploy", 0],
        ["check", 0],
      ]),
      alive
    )
  ).toBe("passed");
  expect(
    resultOf(
      record([
        ["update", 0],
        ["check", 0],
      ]),
      alive
    )
  ).toBe("passed");
  expect(
    resultOf(
      record([
        ["update", 0],
        ["check", 1],
      ]),
      alive
    )
  ).toBe("failed");
  expect(resultOf(record([["update", 1]]), alive)).toBe("failed");
  expect(
    resultOf(
      record(
        [
          ["update", 0],
          ["check", 0],
        ],
        { rows: [{ check: "Health", browser: "", ok: false, note: "500" }] }
      ),
      alive
    )
  ).toBe("failed");
  // With --keep, a deploy that failed was removed: no check ran.
  expect(
    resultOf(
      record([
        ["deploy", 1],
        ["remove", 0],
      ]),
      alive
    )
  ).toBe("failed");
  // A run with its remove still needs its three steps.
  expect(
    resultOf(
      record([
        ["deploy", 0],
        ["check", 0],
        ["remove", 0],
      ]),
      alive
    )
  ).toBe("passed");
});

const KEPT: Kept = { since: "2026-11-05T10:00:00.000Z", hosts: ["erga-verify-5.aws.verify-shell.example", "*.aws.verify-pages.example"] };
const stacks: Left[] = [
  { kind: "CloudFormation stack", name: "erga-verify-5-aws-verify-shell-example", unit: "5" },
  { kind: "CloudFormation stack", name: "erga-verify-5-aws-verify-shell-example-certs", unit: "5" },
  { kind: "Worker", name: "erga-verify-idp-5", unit: "5" },
];
const worker: Left = { kind: "Worker", name: "erga-verify-gate-2", unit: "2" };

test("what a kept setting has in the accounts is kept, not left", () => {
  const left = [...stacks, worker, { kind: "Worker", name: "erga-verify-safari-1", unit: null }];
  expect(leftOf(left, {})).toEqual(left);
  expect(leftOf(left, { "5": KEPT }).map((l) => l.name)).toEqual(["erga-verify-gate-2", "erga-verify-safari-1"]);
  expect(leftOf(left, { "5": KEPT, "2": KEPT }).map((l) => l.name)).toEqual(["erga-verify-safari-1"]);
  // The settings on AWS share the documents' zone: one that is kept, or left, is in the way of each other one there.
  const unit = (id: string) => units().find((u) => u.id == id)!;
  expect(inTheWay(unit("6"), [], { "5": KEPT })).toEqual(["5"]);
  expect(inTheWay(unit("celld"), stacks, {})).toEqual(["5"]);
  expect(inTheWay(unit("5"), stacks, { "5": KEPT })).toEqual([]);
  expect(inTheWay(unit("2"), stacks, { "5": KEPT })).toEqual([]);
  expect(inTheWay(unit("5"), [worker], { "2": KEPT })).toEqual([]);
  // A kept setting's hosts, from this machine's zones.
  const cf = { shell: "verify-shell.example", content: "verify-pages.example" };
  const aws = { shell: "aws.verify-shell.example", content: "aws.verify-pages.example" };
  expect(hostsOf("2", cf, aws)).toEqual(["s2.verify-shell.example", "*.c2.verify-pages.example"]);
  expect(hostsOf("5", cf, aws)).toEqual(KEPT.hosts);
  expect(hostsOf("celld", cf, aws)).toEqual(["erga-verify-celld.aws.verify-shell.example", "*.aws.verify-pages.example"]);
});

test("the record of the kept settings: a file in the suite's folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "erga-verify-kept-"));
  try {
    expect(readKept(dir)).toEqual({});
    writeKept(dir, "5", KEPT);
    writeKept(dir, "2", { since: "2026-11-05T11:00:00.000Z", hosts: ["s2.verify-shell.example"] });
    expect(readKept(dir)).toEqual({ "5": KEPT, "2": { since: "2026-11-05T11:00:00.000Z", hosts: ["s2.verify-shell.example"] } });
    // `remove` ends it, and leaves the others.
    writeKept(dir, "5", null);
    expect(Object.keys(readKept(dir))).toEqual(["2"]);
    writeKept(dir, "5", null);
    expect(Object.keys(readKept(dir))).toEqual(["2"]);
    // A file that is not readable keeps nothing: what is in the accounts then shows as left, with its Remove button.
    writeFileSync(join(dir, "verify/kept.json"), "{");
    expect(readKept(dir)).toEqual({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const IDS = [...new Set(units().flatMap((u) => [...u.needs, ...u.wants]))];
const prereqs = (open: Id[] = []): Prereq[] =>
  IDS.map((id) => ({ id, title: `the ${id}`, done: !open.includes(id), detail: "", todo: `set up the ${id}` }));

test("each command of bun erga verify, from its words: run, --keep, update, remove", () => {
  const at = (words: string, o: { keep?: boolean; kept?: Record<string, Kept>; left?: Left[]; open?: Id[] } = {}) => {
    const c = commandOf(words.split(" ").filter(Boolean), !!o.keep, {
      prereqs: prereqs(o.open),
      left: o.left ?? [],
      kept: o.kept ?? {},
      browsers: ["chromium"],
    });
    if (c.at == "fail") return `fail: ${c.why}${c.next ? ` | ${c.next}` : ""}`;
    if (c.at == "check") return "check";
    return `${c.at} ${c.targets.map((u) => u.id).join(" ")}${"notes" in c && c.notes.length ? ` (${c.notes.length} out)` : ""}`;
  };
  const kept = { "5": KEPT };
  expect(at("")).toBe("check");
  expect(at("check")).toBe("check");
  // A run, by a setting's number or its name; all: each setting.
  expect(at("2 cf-sso-same")).toBe("run 2 3");
  expect(at("all")).toBe("run 1 2 3 4 5 6 celld");
  expect(at("7")).toBe("fail: No setting 7: 1, 2, 3, 4, 5, 6, celld, or all.");
  expect(at("2", { open: ["wrangler"] })).toContain(
    "fail: Setting 2 (Cloudflare, SSO, content on another site) can't run. It is blocked by: the wrangler"
  );
  expect(at("all", { open: ["wrangler"] })).toBe("run 6 celld (5 out)");
  expect(at("all", { open: ["config"] })).toBe("fail: No setting is ready. | bun erga verify");
  // What an earlier run left of the setting stops its next run.
  expect(at("2 3", { left: [worker] })).toBe(
    "fail: An earlier run of 2 left erga-verify-gate-2 in the accounts, or a run is on now from another folder. | bun erga verify remove 2"
  );
  // --keep: the same run, with no remove. Only one setting on AWS at a time.
  expect(at("2 5", { keep: true })).toBe("keep 2 5");
  expect(at("5 6", { keep: true })).toContain("fail: Only one setting on AWS is kept at a time (5, 6");
  expect(at("update 5", { keep: true })).toContain("fail: --keep goes with a run");
  // A kept setting takes no new run: update or remove. What it has in the accounts does not count as left.
  expect(at("5", { kept, left: stacks })).toBe(
    `fail: Setting 5 (AWS, SSO: the gate on CloudFront, content on another site) is kept since ${KEPT.since}: update deploys its code again and checks it, remove ends it. | bun erga verify update 5`
  );
  expect(at("5", { kept, left: stacks, keep: true })).toContain("is kept since");
  expect(at("2", { kept, left: stacks })).toBe("run 2");
  // The other settings on AWS wait for it: they share the documents' zone.
  expect(at("6", { kept, left: stacks })).toContain("can't run while setting 5 is in the AWS account");
  expect(at("6", { kept, left: stacks })).toContain("| bun erga verify remove 5");
  expect(at("celld", { left: stacks })).toContain("can't run while setting 5 is in the AWS account");
  expect(at("all", { kept, left: stacks })).toBe("run 1 2 3 4 (3 out)");
  // update: only a kept setting; all: each kept one.
  expect(at("update 5", { kept, left: stacks })).toBe("update 5");
  expect(at("update aws-sso", { kept, left: stacks })).toBe("update 5");
  expect(at("update all", { kept: { ...kept, "2": KEPT }, left: stacks })).toBe("update 2 5");
  expect(at("update 2", { kept })).toBe(
    "fail: Setting 2 (Cloudflare, SSO, content on another site) is not kept. | bun erga verify 2 --keep"
  );
  expect(at("update all")).toBe("fail: No setting is kept. | bun erga verify <setting> --keep");
  expect(at("update")).toBe("fail: Name the setting: bun erga verify update <setting>|all.");
  expect(at("update 5", { kept, open: ["aws"] })).toContain("can't run. It is blocked by: the aws");
  // remove: a kept setting, or what a run left; it needs no prerequisite.
  expect(at("remove 5", { kept, open: ["aws"] })).toBe("remove 5");
  expect(at("remove all")).toBe("remove 1 2 3 4 5 6 celld");
  expect(at("remove")).toBe("fail: Name the setting: bun erga verify remove <setting>|all.");
});

test("the page shows each kept setting: since when, its hosts, its cost for each hour, Update and Remove", () => {
  const state: State = { at: "2026-11-05T11:30:00.000Z", prereqs: prereqs(), left: [...stacks, worker], unread: [] };
  const v: VerifyFacts = { state, runs: [], kept: { "5": KEPT }, busy: "", error: "" };
  const html = verifyHtml(v, "", NOW);
  const text = html.replace(/<[^>]+>/g, " ");
  expect(headline(state, {}, v.kept)).toContain("Kept: 5. 1 left in the accounts.");
  expect(text).toContain("Kept in the accounts");
  expect(text).toContain("Setting 5: kept since 2 hours ago");
  for (const h of KEPT.hosts) expect(html).toContain(`<code>${h}</code>`);
  expect(text).toContain("3 resources in the accounts");
  // What each hour costs: the machines, the NAT's address, the web ACL; no NAT gateway.
  expect(text).toMatch(/Cost:\s+About \$0\.045 for each hour \(\$1\.10 a day\)/);
  expect(text).toContain("No NAT gateway");
  // Its buttons: Update (no question) in its row, Remove (with a question) with what is kept. It has no Run button.
  expect(html).toContain('data-verify="update" data-unit="5"');
  expect(html).toContain('data-verify="remove" data-unit="5" data-ask="Remove setting 5, which is kept?"');
  expect(html).not.toContain('data-verify="run" data-unit="5"');
  expect(/data-unit="5">.*?<span class="u-state kept">([^<]*)/.exec(html)?.[1]).toBe(
    "Kept since 2 hours ago: Update deploys its code again"
  );
  // Its resources are not under "Left in the accounts": setting 2's Worker is, and it blocks setting 2's run.
  const left = html.slice(html.indexOf("Left in the accounts</h3>"));
  expect(left).toContain("erga-verify-gate-2");
  expect(left).not.toContain("erga-verify-5-aws");
  expect(html.match(/data-verify="remove"/g)?.length).toBe(2);
  // The sidebar says it always: a kept setting costs money by the hour.
  expect(verifySide(v, false).replace(/<[^>]+>/g, " ")).toMatch(/1 kept\s+1 left/);
  expect(verifySide({ ...v, state: { ...state, left: stacks } }, false).replace(/<[^>]+>/g, " ")).toMatch(/1 kept\s*$/);
  // On Cloudflare a kept setting has no price by the hour.
  const cf = verifyHtml({ ...v, kept: { "2": { since: KEPT.since, hosts: ["s2.verify-shell.example"] } } }, "", NOW);
  expect(cf.replace(/<[^>]+>/g, " ")).toMatch(/Setting 2: kept since 2 hours ago.*Cost:\s+\$0 for each hour/);
  // With nothing left but what is kept, the page says so.
  expect(verifyHtml({ ...v, state: { ...state, left: stacks } }, "", NOW)).toContain(
    "Nothing of the suite is left in the accounts: only what is kept."
  );
});
