// The verify suite (`bun erga verify`, dev/verify/): what it may touch (safe.ts), this machine's settings (config.ts),
// each prerequisite's check from fake facts (prereqs.ts, decide), each setting's state and a run's result (suite.ts),
// and its part of the ops page (deploy/cli/verify-view.ts), with the page's server and a fake `bun erga`: nothing
// deploys, and no account is asked.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { type VerifyFacts, verifyHtml, verifySide } from "../deploy/cli/verify-view";
import { dedicatedEnv, localOf } from "../dev/verify/config";
import { decide, type Facts, framesKeepCookies, type Id, type Zone } from "../dev/verify/prereqs";
import type { Row } from "../dev/verify/run";
import { awsStrangers, cloudflareStrangers, type Held, hostProblem, mine, zoneProblem } from "../dev/verify/safe";
import { headline, matrix, neededBy, type RunRecord, readiness, resultOf, type State, tally, unitOfName, units } from "../dev/verify/suite";

const NOW = Date.parse("2026-11-05T12:00:00Z");

test("a run deletes only resources with the suite's name", () => {
  for (const name of ["erga-verify", "erga-verify-3", "erga-verify-gate-2", "erga-verify-3-files", "erga-verify-celld-5"])
    expect(mine(name)).toBe(name);
  for (const name of ["erga", "erga-staging-verify", "my-erga-verify-3", "erga-verify_3", "erga-verify-3/../x", ""])
    expect(() => mine(name)).toThrow("not a resource of the verify suite");
});

test("a test zone is under no refused name, and holds no instance", () => {
  const o = { refuse: ["example.org"], instances: ["example.com", "staging.example.com", "app.verify.example.net"] };
  expect(zoneProblem("erga-verify.example", o)).toBeNull();
  expect(zoneProblem("aws.erga-verify.example", o)).toBeNull();
  expect(zoneProblem("verify.example.org", o)).toContain("refuse");
  expect(zoneProblem("example.org", o)).toContain("refuse");
  // Not a name that only ends like a refused one.
  expect(zoneProblem("notexample.org", o)).toBeNull();
  // A zone with an instance's host at it or under it is no test zone.
  expect(zoneProblem("example.com", o)).toContain("registered instance");
  expect(zoneProblem("verify.example.net", o)).toContain("app.verify.example.net");
  expect(zoneProblem("Verify.Example", o)).toContain("not a zone's name");
  expect(zoneProblem("verify.example/x", o)).toContain("not a zone's name");
  expect(zoneProblem("localhost", o)).toContain("not a zone's name");
  expect(hostProblem("s3.verify-shell.example", ["verify-shell.example", "verify-pages.example"])).toBeNull();
  expect(hostProblem("example.com", ["verify-shell.example"])).toContain("under no test zone");
  expect(hostProblem("xverify-shell.example", ["verify-shell.example"])).toContain("under no test zone");
});

const CF = { account: "a".repeat(32), shell: "verify-shell.example", content: "verify-pages.example", team: "verify" };
const AWS = { profile: "verify", account: "123456789012", shell: "aws.verify-shell.example", content: "aws.verify-pages.example" };
const FILE = JSON.stringify({ cloudflare: CF, aws: AWS, refuse: ["example.org"] });

test("the settings name the suite's own accounts and zones: from the file only", () => {
  expect(localOf(FILE, [])).toMatchObject({ cloudflare: CF, aws: AWS, refuse: ["example.org"], problem: null });
  expect(localOf(null, []).problem).toBe("The suite's Cloudflare account and its two test zones are not set.");
  expect(localOf("{", []).problem).toContain("not JSON");
  // The settings of the suite before it had accounts of its own name nothing that it may use.
  expect(localOf(JSON.stringify({ shell: "verify.example.com", content: "verify.example.net", awsProfile: "test" }), []).problem).toContain(
    "not set"
  );
  const with_ = (cloudflare: object, aws: object = AWS) =>
    localOf(JSON.stringify({ cloudflare, aws, refuse: ["example.org"] }), []).problem;
  expect(with_({ ...CF, account: "my account" })).toContain("not a Cloudflare account's ID");
  expect(with_({ ...CF, content: "pages.verify-shell.example" })).toContain("on one site");
  expect(with_({ ...CF, shell: "verify.example.org" })).toContain("refuse");
  expect(with_(CF, { ...AWS, account: "1234" })).toContain("not an AWS account's ID");
  expect(with_(CF, { ...AWS, content: "pages.verify-shell.example" })).toContain("on one site");
  expect(with_(CF, { ...AWS, shell: "aws.example.org" })).toContain("refuse");
  // (The deploy's code names no profile for "default": the environment's own keys would then count.)
  expect(with_(CF, { ...AWS, profile: "default" })).toContain('not "default"');
  // The AWS account is not needed for the settings on Cloudflare.
  expect(with_(CF, {})).toBeNull();
  expect(localOf(FILE, ["s1.verify-shell.example"]).problem).toContain("registered instance");
  // The account's ID and the AWS profile go to each step's commands. The token does not: each call takes it itself.
  expect(dedicatedEnv(localOf(FILE, []))).toEqual({ CLOUDFLARE_ACCOUNT_ID: CF.account, AWS_PROFILE: "verify" });
  // An account is the suite's alone unless the file says that it is shared; the token is the file's unless it says "cf".
  expect(localOf(FILE, []).cloudflare).toMatchObject({ shared: false, login: "file" });
  expect(localOf(JSON.stringify({ cloudflare: { ...CF, shared: true, login: "cf" } }), [])).toMatchObject({
    cloudflare: { shared: true, login: "cf" },
    problem: null,
  });
  expect(with_({ ...CF, shared: "yes" })).toContain('"shared" is true or false');
  expect(with_({ ...CF, login: "wrangler" })).toContain('"login" is "cf"');
});

/** Accounts that hold only what the suite makes: nothing, or what a run left. */
const held = (): Held => ({
  cloudflare: {
    accounts: [CF.account],
    zones: {
      [CF.shell]: { account: CF.account, records: [], routes: [], domains: [] },
      [CF.content]: { account: CF.account, records: [], routes: [], domains: [] },
    },
    otherZones: [],
    workers: [],
    databases: [],
    buckets: [],
    team: "verify",
    apps: [],
    providers: [],
  },
  aws: { account: AWS.account, stacks: [] },
});

test("a run starts only where the accounts, the zones and the team hold nothing but the suite's own", () => {
  const l = localOf(FILE, []);
  const cf = (change: (h: Held["cloudflare"]) => void) => {
    const h = held().cloudflare;
    change(h);
    return cloudflareStrangers(l, h).join(" ");
  };
  expect(cf(() => {})).toBe("");
  // What a run makes, and what a run that stopped left, is the suite's own.
  expect(
    cf((h) => {
      h.zones[CF.shell]!.records = [
        { type: "AAAA", name: `s2.${CF.shell}` },
        { type: "AAAA", name: `d1.p.s3.${CF.shell}` },
      ];
      h.zones[CF.content]!.records = [{ type: "AAAA", name: `accept.c2.${CF.content}` }];
      h.zones[CF.content]!.routes = [`d1.c4.${CF.content}/*`];
      h.workers = ["erga-verify-gate-2", "erga-verify-2", "erga-verify-idp-5"];
      h.databases = ["erga-verify-2"];
      h.buckets = ["erga-verify-2-files"];
      h.apps = ["erga-verify-4", "erga-verify-4-open"];
      h.providers = ["erga-verify-4"];
    })
  ).toBe("");
  // The names that hand a part of a zone to Route 53, for the runs on AWS, may stay.
  expect(cf((h) => (h.zones[CF.shell]!.records = [{ type: "NS", name: AWS.shell }]))).toBe("");
  // Anything else is not the suite's: a record, a route, a Worker, an application, another account, another team.
  expect(cf((h) => (h.zones[CF.shell]!.records = [{ type: "A", name: CF.shell }]))).toContain(
    `The zone ${CF.shell} has DNS records that the suite did not make: A ${CF.shell}`
  );
  expect(cf((h) => (h.zones[CF.shell]!.records = [{ type: "MX", name: `mail.${CF.shell}` }]))).toContain("did not make: MX");
  expect(cf((h) => (h.zones[CF.shell]!.records = [{ type: "A", name: `s7.${CF.shell}` }]))).toContain("did not make");
  expect(cf((h) => (h.zones[CF.shell]!.records = [{ type: "A", name: AWS.shell }]))).toContain("did not make");
  expect(cf((h) => (h.zones[CF.content]!.routes = [`*.${CF.content}/*`]))).toContain("Workers routes that the suite did not make");
  expect(cf((h) => (h.workers = ["erga-verify-gate-2", "erga", "blog"]))).toContain("Workers that the suite did not make: erga, blog");
  expect(cf((h) => (h.apps = ["Intranet"]))).toContain("Access applications that the suite did not make: Intranet");
  expect(cf((h) => (h.providers = ["Okta"]))).toContain("Access identity providers that the suite did not make: Okta");
  expect(cf((h) => (h.databases = ["erga"]))).toContain("D1 databases that the suite did not make: erga");
  expect(cf((h) => (h.buckets = ["erga-files"]))).toContain("R2 buckets that the suite did not make: erga-files");
  expect(cf((h) => (h.otherZones = ["example.com"]))).toContain("zones besides the two test zones: example.com");
  expect(cf((h) => (h.accounts = [CF.account, "b".repeat(32)]))).toContain("The API token reaches 2 accounts");
  expect(cf((h) => (h.accounts = ["b".repeat(32)]))).toContain("the suite's token reaches only");
  expect(cf((h) => (h.team = "work"))).toContain("Zero Trust team is work, not verify");
  expect(cf((h) => (h.zones[CF.content] = null))).toContain(`sees no zone ${CF.content}`);
  expect(cf((h) => (h.zones[CF.content]!.account = "b".repeat(32)))).toContain("another account");
  // What was not read is not known to be the suite's own: no run.
  expect(cf((h) => (h.workers = null))).toContain("were not read");
  expect(cf((h) => (h.accounts = null))).toContain("were not read");
  expect(cf((h) => (h.apps = null))).toContain("were not read");
  for (const k of ["otherZones", "databases", "buckets", "providers"] as const) expect(cf((h) => (h[k] = null))).toContain("were not read");

  const aws = (h: Held["aws"]) => awsStrangers(l, h).join(" ");
  expect(aws({ account: AWS.account, stacks: [] })).toBe("");
  expect(
    aws({ account: AWS.account, stacks: ["erga-verify-5-aws-verify-shell-example", "erga-verify-5-aws-verify-shell-example-certs"] })
  ).toBe("");
  expect(aws({ account: AWS.account, stacks: ["erga-verify-6-x", "erga-example-com", "CDKToolkit"] })).toContain(
    "2 CloudFormation stacks that the suite did not make (erga-example-com, CDKToolkit)"
  );
  expect(aws({ account: "999999999999", stacks: [] })).toContain("not the settings'");
  expect(aws({ account: null, stacks: null })).toContain("was not read");
  expect(aws({ account: AWS.account, stacks: null })).toContain("were not read");
});

test("a shared account: only the two test zones are the suite's, and they hold nothing else", () => {
  const l = localOf(JSON.stringify({ cloudflare: { ...CF, team: "", shared: true }, refuse: ["example.org"] }), []);
  const cf = (change: (h: Held["cloudflare"]) => void) => {
    // (The rest of a shared account is not read: null.)
    const h: Held["cloudflare"] = {
      ...held().cloudflare,
      otherZones: null,
      workers: null,
      databases: null,
      buckets: null,
      team: null,
      apps: null,
      providers: null,
    };
    change(h);
    return cloudflareStrangers(l, h).join(" ");
  };
  expect(cf(() => {})).toBe("");
  // The account's other work does not stop a run: it is not the suite's, and the suite does not touch it.
  expect(
    cf((h) => Object.assign(h, { otherZones: ["example.com"], workers: ["erga", "blog"], databases: ["erga"], buckets: ["erga-files"] }))
  ).toBe("");
  // What a run made in the two zones is the suite's: a host's record and its Custom Domain, on one of the suite's Workers.
  expect(
    cf((h) => {
      h.zones[CF.shell]!.records = [{ type: "AAAA", name: `s2.${CF.shell}` }];
      h.zones[CF.shell]!.domains = [{ hostname: `s2.${CF.shell}`, service: "erga-verify-gate-2" }];
      h.zones[CF.content]!.routes = [`*.c1.${CF.content}/*`];
    })
  ).toBe("");
  // Anything else in a test zone stops each run: a record, a route, a Custom Domain, another Worker at a run's host.
  expect(cf((h) => (h.zones[CF.shell]!.records = [{ type: "A", name: CF.shell }]))).toContain("DNS records that the suite did not make");
  expect(cf((h) => (h.zones[CF.content]!.routes = [`*.${CF.content}/*`]))).toContain("Workers routes that the suite did not make");
  expect(cf((h) => (h.zones[CF.shell]!.domains = [{ hostname: `www.${CF.shell}`, service: "erga-verify-gate-2" }]))).toContain(
    `Custom Domains that the suite did not make: www.${CF.shell} (erga-verify-gate-2)`
  );
  expect(cf((h) => (h.zones[CF.shell]!.domains = [{ hostname: `s2.${CF.shell}`, service: "erga" }]))).toContain(
    `Custom Domains that the suite did not make: s2.${CF.shell} (erga)`
  );
  // The token reaches that account only, and the zones are that account's.
  expect(cf((h) => (h.accounts = [CF.account, "b".repeat(32)]))).toContain("The API token reaches 2 accounts");
  expect(cf((h) => (h.zones[CF.content] = null))).toContain(`sees no zone ${CF.content}`);
  // A shared account's team, when the settings name it: the account's team is that one. Its other applications stay.
  const withTeam = localOf(JSON.stringify({ cloudflare: { ...CF, shared: true } }), []);
  expect(cloudflareStrangers(withTeam, { ...held().cloudflare, apps: ["Intranet"], providers: ["Okta"], workers: ["erga"] })).toEqual([]);
  expect(cloudflareStrangers(withTeam, { ...held().cloudflare, team: "work" }).join(" ")).toContain("Zero Trust team is work, not verify");
  expect(cloudflareStrangers(withTeam, { ...held().cloudflare, team: null }).join(" ")).toContain("team was not read");
});

const zone = (more: Partial<Zone> = {}): Zone => ({ id: "z", account: CF.account, active: true, ssl: true, analytics: false, ...more });
const WRANGLER = "You are logged in with an API Token";
/** A machine with all of it set up. */
const facts = (more: Partial<Facts> = {}): Facts => ({
  local: localOf(FILE, []),
  token: "",
  wrangler: WRANGLER,
  zones: { [CF.shell]: zone(), [CF.content]: zone() },
  subdomain: "team",
  access: true,
  held: held(),
  aws: { why: "", region: "us-west-2" },
  awsZones: { [AWS.shell]: { delegated: true }, [AWS.content]: { delegated: true } },
  browsers: { chromium: true, firefox: true, webkit: true },
  safari: { version: "26.2", automation: "", preview: true },
  system: "26.2",
  ...more,
});
const open = (f: Facts) =>
  decide(f)
    .filter((p) => !p.done)
    .map((p) => p.id);

test("each prerequisite's check says done or not done, and what to do", () => {
  expect(open(facts())).toEqual([]);
  expect(decide(facts()).every((p) => p.done == !p.todo)).toBe(true);
  const one = (f: Partial<Facts>, id: Id) => {
    const p = decide(facts(f)).find((x) => x.id == id)!;
    expect(p.done).toBe(false);
    return `${p.detail} ${p.todo}`;
  };
  const cf = (change: (h: Held["cloudflare"]) => void): Partial<Facts> => {
    const h = held();
    change(h.cloudflare);
    return { held: h };
  };
  // The settings: accounts that the suite alone uses.
  expect(one({ local: localOf(null, []) }, "config")).toContain(".erga/verify.json");
  expect(one({ local: localOf(null, []) }, "config")).toContain("that the suite alone uses");
  // The token: a file of this user's only, with the permissions that a run needs.
  expect(one({ token: "No .erga/verify-cloudflare.token." }, "token")).toContain("for that account only");
  expect(one({ token: "No .erga/verify-cloudflare.token." }, "token")).toContain("chmod 600");
  expect(one({ wrangler: "" }, "wrangler")).toContain("Workers Scripts Edit");
  // The account is the suite's own, or no run: what is in it that the suite did not make, by name.
  expect(
    one(
      cf((h) => (h.workers = ["erga"])),
      "cloudflare"
    )
  ).toContain("Workers that the suite did not make: erga");
  expect(
    one(
      cf((h) => (h.zones[CF.shell]!.records = [{ type: "A", name: `www.${CF.shell}` }])),
      "cloudflare"
    )
  ).toContain(`A www.${CF.shell}`);
  expect(
    one(
      cf((h) => (h.accounts = [CF.account, "b".repeat(32)])),
      "cloudflare"
    )
  ).toContain("that the suite alone uses");
  expect(one({ token: "no token" }, "cloudflare")).toContain("Not read");
  expect(one({ zones: { [CF.shell]: zone(), [CF.content]: null } }, "zones")).toContain(`sees no zone ${CF.content}`);
  expect(one({ zones: { [CF.shell]: zone({ ssl: false }), [CF.content]: zone() } }, "zones")).toContain(
    `Universal SSL is off on ${CF.shell}`
  );
  expect(one({ subdomain: null }, "workers-dev")).toContain("workers.dev");
  expect(one({ zones: { [CF.shell]: zone({ analytics: true }), [CF.content]: zone() } }, "analytics")).toContain(
    `Automatic setup is on for ${CF.shell}`
  );
  // Not read is not done: the check never passes on no answer.
  expect(one({ zones: { [CF.shell]: zone({ analytics: null }), [CF.content]: zone() } }, "analytics")).toContain("Not read");
  // Access: the team of the dedicated account, and a token that edits it.
  expect(one({ access: false }, "access")).toContain("Access: Apps and Policies Edit");
  expect(one({ access: null }, "access")).toContain("Not asked");
  expect(
    one(
      cf((h) => (h.team = "")),
      "access"
    )
  ).toContain("not set up");
  expect(one({ local: localOf(JSON.stringify({ cloudflare: { ...CF, team: "" }, aws: AWS }), []) }, "access")).toContain(
    "No team is named"
  );
  // AWS: the dedicated account, by its ID; only the suite's stacks in it; and its two zones, which the internet finds.
  expect(one({ aws: { why: "Profile verify: the session has expired.", region: "" } }, "aws")).toContain("aws sso login --profile verify");
  expect(one({ held: { ...held(), aws: { account: "999999999999", stacks: [] } } }, "aws")).toContain("not ...9012");
  expect(one({ local: localOf(JSON.stringify({ cloudflare: CF }), []) }, "aws")).toContain("that the suite alone uses");
  expect(one({ held: { ...held(), aws: { account: AWS.account, stacks: ["erga-prod"] } } }, "aws-own")).toContain(
    "1 CloudFormation stacks that the suite did not make (erga-prod)"
  );
  expect(one({ awsZones: { [AWS.shell]: { delegated: true }, [AWS.content]: null } }, "aws-zones")).toContain(
    `no public Route 53 zone ${AWS.content}`
  );
  expect(one({ awsZones: { [AWS.shell]: { delegated: false }, [AWS.content]: { delegated: true } } }, "aws-zones")).toContain(
    "four NS records"
  );
  // (The name servers were not read: that blocks no run. A certificate's check then waits, as it does for a real instance.)
  expect(open(facts({ awsZones: { [AWS.shell]: { delegated: null }, [AWS.content]: { delegated: null } } }))).toEqual([]);
  expect(one({ browsers: { chromium: true, firefox: false, webkit: false } }, "browsers")).toContain(
    "bunx playwright-core install firefox webkit"
  );
  // Safari keeps a frame's cookie from 26.2 on, on a system from 26.2 on: both count.
  expect(one({ safari: { version: "18.6", automation: "", preview: false }, system: "15.6" }, "safari-version")).toContain(
    "macOS 26.2 or later"
  );
  expect(one({ system: "15.7" }, "safari-version")).toContain("Safari 26.2 alone, on an older macOS, is not enough");
  expect(open(facts({ safari: { version: "27.0", automation: "", preview: true }, system: "27.1" }))).not.toContain("safari-version");
  expect([framesKeepCookies("26.2", "26.2"), framesKeepCookies("26.4", "15.7"), framesKeepCookies("18.6", "26.2")]).toEqual([
    true,
    false,
    false,
  ]);
  expect(
    one({ safari: { version: "26.2", automation: "You must enable 'Allow remote automation'", preview: true } }, "safari-automation")
  ).toContain("sudo safaridriver --enable");
});

test("a shared account: the prerequisites say what the suite touches there, and what stays blocked", () => {
  const local = localOf(
    JSON.stringify({ cloudflare: { ...CF, team: "", shared: true, login: "cf" }, aws: { ...AWS, shared: true }, refuse: ["example.org"] }),
    []
  );
  // (The rest of a shared account is not read.)
  const h = held();
  Object.assign(h.cloudflare, { otherZones: null, workers: null, databases: null, buckets: null, team: null, apps: null, providers: null });
  h.aws.stacks = ["erga-example-com", "CDKToolkit"];
  const f = facts({ local, held: h, access: null });
  const row = (id: Id, of = f) => decide(of).find((p) => p.id == id)!;
  // Each setting on Cloudflare but the one with Access is ready, and so are those on AWS: the accounts' other work blocks none.
  expect(open(f)).toEqual(["access"]);
  expect(row("config").detail).toContain("shared: it holds other work, which the suite never touches");
  expect(row("cloudflare").title).toBe("The two test zones hold only what the suite makes (a shared account)");
  expect(row("cloudflare").detail).toContain("only what is named erga-verify-..., under those two zones");
  expect(row("aws-own").detail).toContain("only stacks named erga-verify-...");
  // The token is the cf CLI's login: the row says that it reaches more than a run needs, and how to sign in.
  expect(row("token").detail).toContain("the suite's rule is asked before each call");
  expect(row("token", facts({ local, held: h, token: "The cf CLI is not signed in on this machine." })).todo).toBe("bunx cf auth login");
  // Access: a shared account's team holds other work. The setting stays blocked, and the row says what it needs.
  expect(row("access").detail).toContain("The account is shared: its Zero Trust team holds other work");
  expect(row("access").todo).toContain("Setting 4 needs a dedicated account, with a Zero Trust team of its own");
  const all = units();
  const state = (id: string) => readiness(all.find((u) => u.id == id)!, decide(f)).at;
  expect(["1", "2", "3", "4", "5", "6", "celld"].map(state)).toEqual(["ready", "ready", "ready", "blocked", "ready", "ready", "ready"]);
  // Something else in a test zone blocks each setting on Cloudflare, in a shared account too.
  h.cloudflare.zones[CF.shell]!.records = [{ type: "A", name: `www.${CF.shell}` }];
  expect(row("cloudflare", facts({ local, held: h, access: null })).todo).toContain("out of the two test zones");
});

test("each setting lists the prerequisites it needs, and says what blocks it", () => {
  const all = units();
  expect(all.map((u) => u.id)).toEqual(["1", "2", "3", "4", "5", "6", "celld"]);
  const by = (f: Partial<Facts>, id: string, browsers: string[] = []) => {
    const r = readiness(all.find((u) => u.id == id)!, decide(facts(f)), browsers);
    return r.at == "ready" ? `ready${r.weak.map((p) => ` weak:${p.id}`).join("")}` : `${r.at}: ${r.by.map((p) => p.id).join(",")}`;
  };
  const down = { aws: { why: "no", region: "" } };
  expect(by({}, "3")).toBe("ready");
  // Web Analytics blocks no run: a check fails with it.
  expect(by({ zones: { [CF.shell]: zone({ analytics: true }), [CF.content]: zone() } }, "2")).toBe("ready weak:analytics");
  expect(by({ wrangler: "" }, "1")).toBe("blocked: wrangler");
  // A Cloudflare account that holds another's work blocks each setting that deploys there: also setting 5, whose
  // test issuer is a Worker. Erga's own deploy on AWS needs no Cloudflare.
  const shared: Partial<Facts> = { held: { ...held(), cloudflare: { ...held().cloudflare, workers: ["erga"] } } };
  for (const id of ["1", "2", "3", "4", "5"]) expect(by(shared, id)).toBe("blocked: cloudflare");
  for (const id of ["6", "celld"]) expect(by(shared, id)).toBe("ready");
  // An AWS account that holds another's stacks blocks each setting on AWS, and none on Cloudflare.
  const sharedAws: Partial<Facts> = { held: { ...held(), aws: { account: AWS.account, stacks: ["erga-prod"] } } };
  for (const id of ["5", "6", "celld"]) expect(by(sharedAws, id)).toBe("blocked: aws-own");
  expect(by(sharedAws, "2")).toBe("ready");
  expect(by(down, "3")).toBe("ready");
  expect(by(down, "5")).toBe("blocked: aws,aws-own,aws-zones");
  expect(by({ ...down, browsers: { chromium: false, firefox: true, webkit: true } }, "celld")).toBe(
    "blocked: aws,aws-own,aws-zones,browsers"
  );
  expect(by({ awsZones: {} }, "6")).toBe("blocked: aws-zones");
  // Setting 4 needs a token that edits Access.
  expect(by({ access: false }, "4")).toBe("blocked: access");
  expect(by({}, "6")).toBe("ready");
  // No token: no setting that deploys to Cloudflare.
  expect(by({ token: "no token", wrangler: "" }, "2")).toBe("blocked: token,wrangler,cloudflare");
  // Safari is asked for: its automation counts. Its version does not: an older Safari runs, and must show the gate's
  // page for an unsupported browser.
  expect(by({ safari: { version: "18.6", automation: "off", preview: false } }, "3", ["safari"])).toBe("blocked: safari-automation");
  expect(by({ safari: { version: "18.6", automation: "", preview: false } }, "2", ["safari"])).toBe("ready");
  expect(by({ safari: { version: "18.6", automation: "off", preview: false } }, "3", ["chromium"])).toBe("ready");
  expect(neededBy("access")).toEqual(["4"]);
  expect(neededBy("analytics")).toEqual(["1", "2", "3", "4"]);
  expect(neededBy("cloudflare")).toEqual(["1", "2", "3", "4", "5"]);
  expect(neededBy("aws-own")).toEqual(["5", "6", "celld"]);
  expect(neededBy("safari-automation")).toEqual(["safari"]);
  expect(neededBy("safari-version")).toEqual([]);
});

const rows: Row[] = [
  { check: "Health", browser: "", ok: true, note: "200" },
  { check: "Sign in once", browser: "chromium", ok: true, note: "" },
  { check: "Sign in once", browser: "webkit", ok: false, note: "the nonce did not come back" },
  { check: "Sign-out", browser: "chromium", ok: null, note: "" },
];
const record = (more: Partial<RunRecord> = {}): RunRecord => ({
  id: "2026-11-05T11-00-00-000Z-3",
  unit: "3",
  command: "bun erga verify 3",
  from: "terminal",
  pid: 7,
  pidStart: "then",
  commit: "c".repeat(40),
  browsers: ["chromium", "webkit"],
  started: "2026-11-05T11:00:00.000Z",
  ended: "2026-11-05T11:10:00.000Z",
  steps: [
    { step: "deploy", started: "2026-11-05T11:00:00.000Z", seconds: 300, code: 0 },
    { step: "check", started: "2026-11-05T11:05:00.000Z", seconds: 200, code: 0 },
    { step: "remove", started: "2026-11-05T11:09:00.000Z", seconds: 65, code: 0 },
  ],
  rows: rows.filter((r) => r.ok !== false),
  left: [],
  ...more,
});

test("a run passes only when each step ended well, no row failed and nothing is left", () => {
  const alive = () => true;
  expect(resultOf(record(), alive)).toBe("passed");
  expect(resultOf(record({ rows }), alive)).toBe("failed");
  expect(resultOf(record({ left: ["Worker erga-verify-3"] }), alive)).toBe("failed");
  // Its deploy failed: no check ran.
  expect(resultOf(record({ steps: [record().steps[0], record().steps[2]] }), alive)).toBe("failed");
  expect(resultOf(record({ steps: record().steps.map((s) => (s.step == "remove" ? { ...s, code: 1 } : s)) }), alive)).toBe("failed");
  expect(resultOf(record({ ended: undefined }), alive)).toBe("running");
  expect(resultOf(record({ ended: undefined }), () => false)).toBe("stopped");
  expect(tally(rows)).toEqual([
    { browser: "requests", pass: 1, fail: 0, skipped: 0 },
    { browser: "chromium", pass: 1, fail: 0, skipped: 1 },
    { browser: "webkit", pass: 0, fail: 1, skipped: 0 },
  ]);
  const m = matrix(rows);
  expect(m.columns).toEqual(["requests", "chromium", "webkit"]);
  expect(m.checks.map((c) => `${c.check}: ${Object.keys(c.cells).join(" ")}`)).toEqual([
    "Health: requests",
    "Sign in once: chromium webkit",
    "Sign-out: chromium",
  ]);
});

test("a resource's name says which setting removes it", () => {
  expect(
    [
      "erga-verify-3",
      "erga-verify-gate-2",
      "erga-verify-idp-5",
      "erga-verify-3-files",
      "erga-verify-4-open",
      // On AWS a stack's name is its app's host (deploy/own/plan.ts, stackOf); the us-east-1 stack ends with -certs.
      "erga-verify-5-aws-verify-shell-example",
      "erga-verify-6-aws-verify-shell-example-certs",
      "erga-verify-celld-aws-verify-shell-example",
    ].map(unitOfName)
  ).toEqual(["3", "2", "5", "3", "4", "5", "6", "celld"]);
  // Another tool's Worker with the prefix: no setting removes it.
  expect(["erga-verify-safari-1", "erga-verify-9", "erga-verify"].map(unitOfName)).toEqual([null, null, null]);
});

const state = (f: Partial<Facts> = {}, more: Partial<State> = {}): State => ({
  at: "2026-11-05T11:30:00.000Z",
  prereqs: decide(facts(f)),
  left: [],
  unread: [],
  ...more,
});
const view = (v: Partial<VerifyFacts> = {}, unit = "") =>
  verifyHtml({ state: state(), runs: [], kept: {}, busy: "", error: "", ...v }, unit, NOW);
/** The words of one row of the page. */
const rowOf = (html: string, attr: string) =>
  (
    new RegExp(`<div class="[^"]*" data-${attr}>(.*?)(?=<div class="[uv]-row|</div><h3|</div><p|</div><div class="confirm)`).exec(
      html
    )?.[1] ?? ""
  ).replace(/<[^>]+>/g, " ");

test("the page says at a glance how much is set up and what passed", () => {
  expect(headline(null, {}, {})).toBe("The prerequisites are not checked yet.");
  // Thirteen prerequisites that a setting or a browser needs; two are optional (Safari's version, the preview).
  expect(headline(state(), { "3": "passed" }, {})).toBe("Setup: 13 of 13 done. Settings: 7 of 7 ready, 1 passed.");
  const s = state(
    { wrangler: "", safari: { version: "18.6", automation: "off", preview: false } },
    { left: [{ kind: "Worker", name: "erga-verify-3", unit: "3" }] }
  );
  expect(headline(s, {}, {})).toBe("Setup: 11 of 13 done. Settings: 2 of 7 ready, 0 passed. 1 left in the accounts.");
  const html = view({ state: s });
  expect(html).toContain("Setup: 11 of 13 done.");
  // A prerequisite that is not done says what to do; an address is a link.
  expect(rowOf(html, 'prereq="wrangler"')).toMatch(/Do:\s+Make the token again/);
  expect(rowOf(html, 'prereq="wrangler"')).toContain("to do");
  expect(rowOf(html, 'prereq="config"')).toContain("done");
  expect(rowOf(html, 'prereq="safari-preview"')).toContain("optional");
  expect(html).toContain('<a href="https://developer.apple.com/safari/technology-preview/" target="_blank" rel="noreferrer">');
  // The sidebar's entry: how much is set up, and what is left.
  expect(verifySide({ state: s, runs: [], kept: {}, busy: "", error: "" }, true).replace(/<[^>]+>/g, " ")).toMatch(
    /Verify suite\s+11 of 13 set up\s+1 left/
  );
  expect(verifySide({ state: null, runs: [], kept: {}, busy: "", error: "" }, false)).toContain("not checked");
  expect(view({ state: null })).toContain("The prerequisites are not checked yet.");
});

test("each setting shows its state, its last run by browser, and a Run button that is off when it can't run", () => {
  const runs = [{ ...record({ rows }), result: "failed" as const }];
  const html = view({ state: state({ wrangler: "" }), runs }, "3");
  const row = (id: string) => rowOf(html, `unit="${id}"`);
  const btn = (id: string) =>
    new RegExp(`<span class="tip"( title="[^"]*")?><button class="btn" type="button" data-verify="run" data-unit="${id}"[^>]*>`).exec(
      html
    )?.[0] ?? "";
  expect(row("3")).toContain("Blocked by: wrangler takes the suite&#39;s token");
  expect(btn("3")).toContain("disabled");
  // celld needs only AWS and the browsers: it is ready, and its question says the cost.
  expect(row("celld")).toContain("Ready");
  expect(btn("celld")).not.toContain("disabled");
  expect(btn("celld")).toContain("Expected cost: under $0.50");
  expect(row("6")).toContain("Ready");
  expect(btn("6")).toContain("Expected cost: under $0.50");
  // The last run of setting 3: failed, when, how long, and each browser's count.
  expect(row("3")).toMatch(/failed 1 hour ago · 9 min 25 s\s+requests 1\/1\s+chromium 1\/1\s+webkit 0\/1/);
  expect(row("1")).toContain("no run yet");
  // Its detail: each check in each browser, a failed check with its note, and the links to the log and the record.
  expect(html).toContain('<td class="bad" title="the nonce did not come back">FAIL</td>');
  expect(html).toContain("<b>webkit:</b> the nonce did not come back");
  expect(html).toContain('<td class="skip" title="">not run</td>');
  expect(html).toContain('href="/verify/log/2026-11-05T11-00-00-000Z-3"');
  expect(html).toContain('href="/verify/run/2026-11-05T11-00-00-000Z-3"');
  expect(html).toContain("deploy 5 min 0 s · check 3 min 20 s · remove 1 min 5 s");
  // While a run is on: its step, and no second run.
  const on = view({
    runs: [
      {
        ...record({ ended: undefined, steps: [{ step: "deploy", started: "2026-11-05T11:58:00.000Z" }], rows: [] }),
        result: "running" as const,
      },
    ],
  });
  expect(on).toContain("setting 3 runs: deploy, 2 min 0 s");
  expect(rowOf(on, 'unit="3"')).toContain("Running…");
  expect(/data-verify="run" data-unit="2"[^>]*>/.exec(on)?.[0]).toContain("disabled");
});

test("what a run left shows with a Remove button for its setting, and blocks the setting's next run", () => {
  const left = [
    { kind: "Worker", name: "erga-verify-3", unit: "3" },
    { kind: "D1 database", name: "erga-verify-3", unit: "3" },
    { kind: "Worker", name: "erga-verify-safari-1", unit: null },
  ];
  const html = view({ state: state({}, { left, unread: ["AWS: no sign-in: its stacks were not listed."] }) });
  expect(html.match(/data-verify="remove"/g)?.length).toBe(1);
  expect(html).toContain('data-verify="remove" data-unit="3"');
  expect(html).toContain("not the suite's");
  expect(html).toContain("its stacks were not listed");
  expect(rowOf(html, 'unit="3"')).toContain("Not removed yet: erga-verify-3");
  expect(/data-verify="run" data-unit="3"[^>]*>/.exec(html)?.[0]).toContain("disabled");
  expect(view()).toContain("Nothing of the suite is in the accounts.");
});

test("the page's server shows the suite at #verify, and its buttons run bun erga verify, one at a time", async () => {
  const { serveOpsPage } = await import("../deploy/cli/ops-page");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "erga-ops-verify-")));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  mkdirSync(join(dir, ".erga/verify/runs"), { recursive: true });
  writeFileSync(join(dir, ".erga/config.json"), JSON.stringify({ instances: [] }));
  // (The token may not edit Access: setting 4 can't run.)
  writeFileSync(join(dir, ".erga/verify/state.json"), JSON.stringify(state({ access: false })));
  writeFileSync(join(dir, ".erga/verify/runs", `${record().id}.json`), JSON.stringify(record()));
  writeFileSync(join(dir, ".erga/verify/runs", `${record().id}.log`), "the run's output\n");
  const ran: string[][] = [];
  let end = (_: { code: number; out: string }) => {};
  const page = serveOpsPage({
    dir: join(dir, ".erga"),
    cwd: dir,
    port: 0,
    fetch: async () => null,
    run: (args) => {
      ran.push(args);
      return { pid: 999_999, done: new Promise((done) => (end = done)) };
    },
  });
  const at = `http://127.0.0.1:${page.server.port}`;
  const post = (body: object, origin = at) =>
    fetch(`${at}/api/verify`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const html = async (hash = "verify") => (await fetch(`${at}/view?hash=${hash}`)).text();
  try {
    expect(await html()).toContain("Setup: 12 of 13 done. Settings: 6 of 7 ready, 1 passed.");
    expect(await html("verify/3")).toContain("passed");
    // The sidebar has the suite's entry on every page.
    expect(await html("")).toContain('href="#verify"');
    expect(await (await fetch(`${at}/verify/log/${record().id}`)).text()).toBe("the run's output\n");
    expect((await (await fetch(`${at}/verify/run/${record().id}`)).json()).unit).toBe("3");
    expect((await fetch(`${at}/verify/log/nothing`)).status).toBe(404);
    expect((await fetch(`${at}/verify/log/..%2F..%2Fconfig`)).status).toBe(404);
    // Another site starts nothing; a setting that a prerequisite blocks, or that no list has, does not run.
    expect((await post({ action: "run", unit: "3" }, "https://evil.example")).status).toBe(403);
    expect((await post({ action: "run", unit: "4" })).status).toBe(409);
    expect((await post({ action: "run", unit: "7; rm" })).status).toBe(400);
    expect((await post({ action: "deploy", unit: "3" })).status).toBe(400);
    expect(ran).toEqual([]);
    expect((await post({ action: "run", unit: "3" })).status).toBe(202);
    expect(ran).toEqual([["verify", "3", "--yes"]]);
    expect(await html()).toContain("<code>bun erga verify 3</code><span>runs · from this page</span>");
    // While it runs: no second command.
    const busy = await post({ action: "check" });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toContain("Another command runs: bun erga verify 3");
    // It stopped with no record: the page says the command's own words.
    end({ code: 1, out: "FAIL  No setting is ready." });
    for (let i = 0; i < 100 && !(await html()).includes("No setting is ready."); i++) await Bun.sleep(20);
    expect(await html()).toContain("bun erga verify 3 stopped: FAIL  No setting is ready.");
    expect((await post({ action: "remove", unit: "celld" })).status).toBe(202);
    expect(ran.at(-1)).toEqual(["verify", "remove", "celld"]);
    end({ code: 0, out: "" });
    for (let i = 0; i < 100 && (await html()).includes("runs · from this page"); i++) await Bun.sleep(20);
    expect((await post({ action: "check" })).status).toBe(202);
    expect(ran.at(-1)).toEqual(["verify", "check"]);
    end({ code: 0, out: "" });
    for (let i = 0; i < 100 && (await html()).includes("runs · from this page"); i++) await Bun.sleep(20);
    // A kept setting (bun erga verify 2 --keep): the page says so, Update runs its update, and it takes no new run.
    expect((await post({ action: "update", unit: "2" })).status).toBe(409);
    writeFileSync(
      join(dir, ".erga/verify/kept.json"),
      JSON.stringify({ "2": { since: "2026-11-05T10:00:00.000Z", hosts: ["s2.example"] } })
    );
    for (let i = 0; i < 400 && !(await html()).includes("Setting 2: kept since"); i++) await Bun.sleep(20);
    expect(await html()).toContain("<code>s2.example</code>");
    expect((await post({ action: "run", unit: "2" })).status).toBe(409);
    expect((await post({ action: "update", unit: "2" })).status).toBe(202);
    expect(ran.at(-1)).toEqual(["verify", "update", "2"]);
    expect(await html()).toContain("<code>bun erga verify update 2</code><span>runs · from this page</span>");
  } finally {
    page.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
