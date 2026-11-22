// `bun erga setup`'s build (deploy/own/first.ts) against the mock Cloudflare (ERGA_DEPLOY_MOCK=1), from the answers to
// a healthy deploy of a new instance: its entry in .erga/config.json, the secrets set one time, and a database with no
// user and no rule. Then a second instance, by the same flow. Then its deployer, installed with no token, which the
// instance's Worker binds at its next deploy. Then the admin, whom setup sees in the database through Cloudflare's D1
// API. And an instance that runs already, with names that setup would not give: setup
// stops, and its entry stays. And an Erga that another clone set up: a clone with no entry for it takes it over.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudflareEntry, type Entry, readConfig, withEntry, writeConfig } from "../deploy/cli/config";
import type { MockState } from "../dev/mock-cloudflare";
import { writePass } from "./helpers/pass.ts";
import { Cloudflare } from "../deploy/deployer/cloudflare-api";
import * as Effect from "effect/Effect";
import { d1Sql } from "../deploy/deployer/cloudflare";
import { readControl, writeAuto } from "../deploy/deployer/control";
import { adminOn, adoptEntry, type First, firstDeploy, setDeployer, writeEntry } from "../deploy/own/first";
import { specOn, sqlOf } from "../deploy/cli/instance";
import { instanceReader, jobsReader } from "../deploy/cli/running";
import { deployInstance } from "../deploy/cli/deploy";
import { liveOf, observe } from "../deploy/own/facts";
import { step } from "../deploy/own/flow";
import { noAnswers } from "../deploy/own/plan";
import { loadSecrets, namesAt, putSecret } from "../deploy/own/store";
import { installDeployer, removeDeployer } from "../deploy/pipeline/deployer";
import { targetFacts } from "../deploy/pipeline/pipeline";
import { ACCOUNT_ID, FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { HOST as RUNS, MARK } from "./helpers/cloudflare-setup.ts";
import { bindingsOf, bootstrap, fleet, next, prepareRelease, ROOT } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
const HOST = "erga.ada-example.com",
  SECOND = "erga-next.ada-example.com";
let dir = "";
/** The plan's words for an instance that runs: setup changes no auto-deploy mode that the user did not choose. */
const KEEPS =
  "it deploys by itself what the server's auto-deploy mode says. I do not change that mode (a server with no mode yet gets releases: each new release); --auto-deploy off|releases|commits sets another";

beforeAll(async () => {
  process.env.ERGA_DEPLOY_MOCK = "1";
  await prepareRelease();
  dir = join(mkdtempSync(join(tmpdir(), "erga-setup-")), ".erga");
  writePass(dir, HEAD);
}, 120_000);
afterAll(() => {
  delete process.env.ERGA_DEPLOY_MOCK;
  if (dir) rmSync(join(dir, ".."), { recursive: true, force: true });
});

/** An instance's jobs, as its own database has them in the mock Cloudflare: the newest first. */
const jobsOn = async (mock: { fetch: First["net"] }, host: string) =>
  (await jobsReader({ net: mock.fetch })(readConfig(dir).instances.find((e) => e.host == host)!)).jobs;

/** What the build takes from the flow, for `host`: the answers, and what the command saw in the mock account. */
const first = (mock: { state: MockState; fetch: First["net"] }, host: string, more: Partial<First["answers"]> = {}): First => ({
  dir,
  answers: { ...noAnswers(host), where: "cloudflare", account: ACCOUNT_ID, ...more },
  seen: {
    zones: mock.state.zones.map((z) => z.name),
    subdomain: mock.state.subdomain,
    held: Object.keys(mock.state.secrets[namesAt(host, dir).worker] ?? {}),
  },
  net: mock.fetch,
  token: "mock-machine-token",
  // The mock deploys this checkout's commit; a real setup takes the head of the branch that the entry tracks.
  print: () => {},
});
const rowsOf = (state: MockState, worker: string) =>
  state.databases.find((d) => d.uuid == bindingsOf(state, worker).DB.database_id)?.rows ?? [];

test("from the answers to a healthy deploy: the entry, the secrets one time, no sign-in app, no rule and no admin; then a second instance", async () => {
  const mock = mockCloudflare();
  expect(await firstDeploy(first(mock, HOST))).toBe(HEAD);

  // The entry: written from the answers. It holds no token.
  expect(readConfig(dir).instances.map((e) => [e.host, (e as CloudflareEntry).worker, "token" in e])).toEqual([
    [HOST, "erga-ada-example-com", false],
  ]);
  // The secrets: made one time, kept in .erga/secrets.json, sent with this deploy.
  const file = loadSecrets(dir);
  expect(mock.state.secrets["erga-ada-example-com"]).toEqual({
    SESSION_SECRET: file[HOST].SESSION_SECRET,
    SECRETS_KEY: file[HOST].SECRETS_KEY,
  });
  expect(file[HOST].SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
  // No sign-in app goes with the deploy: the user makes it on the server's setup page.
  expect(bindingsOf(mock.state, "erga-ada-example-com").GITHUB_CLIENT_ID.text).toBe("");
  expect(JSON.parse(bindingsOf(mock.state, "erga-ada-example-com").SERVER_DEFAULTS.text)).toEqual({
    anyone_access: "public",
    public_sharing: true,
    delete_docs_after_hours: null,
  });
  // Its commit and its health, as Cloudflare shows them: the deploy asked the server nothing, and set its Cron Trigger.
  expect(await instanceReader({ net: mock.fetch })(readConfig(dir).instances[0])).toEqual({ version: HEAD.slice(0, 12), healthy: true });
  expect(mock.state.schedules["erga-ada-example-com"]).toEqual(["* * * * *"]);
  // What setup's next look sees of it: healthy, with the sign-in that its entry names; with an app that the entry
  // names and the release lacks (an instance from before the setup page), not.
  const cf = new Cloudflare("mock-machine-token", mock.fetch);
  const answers = first(mock, HOST).answers;
  expect(await liveOf(cf, ACCOUNT_ID, "erga-ada-example-com", answers, undefined)).toEqual({
    version: HEAD.slice(0, 12),
    healthy: true,
    signIn: "ok",
  });
  expect((await liveOf(cf, ACCOUNT_ID, "erga-ada-example-com", answers, "Iv1.new"))?.signIn).toEqual({
    bad: "it signs in with the app (none), not yours (Iv1.new): deploy again",
  });
  expect(await liveOf(cf, ACCOUNT_ID, "erga-nowhere", answers, undefined)).toEqual({ version: null, healthy: false, signIn: null });
  // The database: no rule and no user at all. The user who finishes the setup page becomes its admin.
  const rows = rowsOf(mock.state, "erga-ada-example-com");
  expect(rows.join("\n")).not.toMatch(/INSERT INTO (users|access_rules)/);
  // The job is the setup's, in the new instance's own database: the database had no table when the job started, so
  // the job's row came with its end. Its entry tracks the default repository's main: no deploy moves a branch.
  const [job, ...more] = await jobsOn(mock, HOST);
  expect(more).toEqual([]);
  expect(job).toMatchObject({ kind: "deploy", command: `bun erga setup ${HOST}`, host: HOST, commit: HEAD, phase: "ok" });
  expect(job.out).toContainEqual(expect.stringContaining("the secrets sent: SESSION_SECRET, SECRETS_KEY"));
  expect(readConfig(dir).instances.map((e) => [e.repo, e.branch])).toEqual([["github.com/koomen/erga", "main"]]);
  // The instance holds its spec: what the entry says, and the names of the secrets that the Worker holds. No value.
  const spec = await specOn(await sqlOf(readConfig(dir).instances[0], { cf }));
  expect(spec).toMatchObject({
    repo: "github.com/koomen/erga",
    branch: "main",
    target: { kind: "cloudflare", worker: "erga-ada-example-com" },
    secrets: ["SECRETS_KEY", "SESSION_SECRET"],
  });
  expect(JSON.stringify(spec)).not.toContain(file[HOST].SESSION_SECRET);

  // A run again: the Worker holds its secrets, so none goes out.
  const held = { ...mock.state.secrets["erga-ada-example-com"] };
  expect(await firstDeploy(first(mock, HOST))).toBe(HEAD);
  expect(mock.state.secrets["erga-ada-example-com"]).toEqual(held);
  expect((await jobsOn(mock, HOST)).map((j) => [j.commit, j.phase])).toEqual([
    [HEAD, "ok"],
    [HEAD, "ok"],
  ]);

  // A second instance, set up later with a branch of its own: the same path, its own names, secrets and database.
  // Nothing of the first one goes to it. (A deploy that has a GitHub app of its own names it: the verify suite's.)
  expect(await firstDeploy({ ...first(mock, SECOND, { branch: "staging" }), github: "Iv1.second" })).toBe(HEAD);
  expect(readConfig(dir).instances.map((e) => [e.host, e.branch])).toEqual([
    [HOST, "main"],
    [SECOND, "staging"],
  ]);
  const second = mock.state.secrets["erga-next-ada-example-com"];
  expect(Object.keys(second).sort()).toEqual(["SECRETS_KEY", "SESSION_SECRET"]);
  expect(second.SESSION_SECRET).not.toBe(held.SESSION_SECRET);
  expect(bindingsOf(mock.state, "erga-next-ada-example-com").GITHUB_CLIENT_ID.text).toBe("Iv1.second");
  expect(bindingsOf(mock.state, "erga-next-ada-example-com").SNAPSHOT_FROM).toBeUndefined();
  expect(mock.state.databases.find((d) => d.uuid == bindingsOf(mock.state, "erga-next-ada-example-com").DB.database_id)?.name).toBe(
    "erga-next-ada-example-com"
  );
}, 120_000);

test("the deployer, installed with no token: the instance's next deploy binds it on its Worker, and its removal's next deploy does not", async () => {
  const mock = mockCloudflare();
  await firstDeploy(first(mock, HOST));
  const cf = new Cloudflare("mock-machine-token", mock.fetch);
  const connect = async () => ({ cf, net: mock.fetch, token: "mock-machine-token" });
  const a = { ...first(mock, HOST).answers, deploys: "cloud" as const };
  const target = { account: ACCOUNT_ID, worker: "erga-ada-example-com" };
  const deploy = () => deployInstance({ dir, host: HOST, commit: HEAD.slice(0, 12), noTests: true, net: mock.fetch, print: () => {} });
  // A new instance has no deployer, and binds none: the flow's next step is the install.
  expect(bindingsOf(mock.state, target.worker).DEPLOYER).toBeUndefined();
  expect(step(a, await observe(a, dir, connect)).state).toEqual({ at: "deployer", do: "install" });
  // The install alone leaves the instance's Worker as it is: the deployer is not whole yet.
  expect(await installDeployer(cf, target)).toEqual({ name: "erga-ada-example-com-deployer", kept: false, replaced: false });
  expect(await observe(a, dir, connect)).toMatchObject({ deployer: true, bound: false });
  expect(step(a, await observe(a, dir, connect)).state).toEqual({ at: "deployer", do: "install" });
  // A deploy of the release that runs: the Worker binds its deployer, and the flow goes on to the setup page.
  await deploy();
  expect(bindingsOf(mock.state, target.worker).DEPLOYER).toMatchObject({ type: "service", service: "erga-ada-example-com-deployer" });
  expect(await observe(a, dir, connect)).toMatchObject({ deployer: true, bound: true });
  expect(step(a, await observe(a, dir, connect)).state).toEqual({ at: "page" });
  // The command's own step does both, for an instance with no deployer too. A new instance has no auto-deploy mode
  // yet: it gets releases. With a mode, it keeps that one, unless the user chose another.
  const sql = d1Sql(cf, target);
  const set = (to: "install" | "remove", auto?: "off" | "releases" | "commits") =>
    setDeployer({
      dir,
      host: HOST,
      target,
      to,
      auto,
      commit: HEAD.slice(0, 12),
      command: "bun erga setup",
      cf,
      net: mock.fetch,
      token: "mock-machine-token",
      print: () => {},
    });
  await removeDeployer(cf, target);
  expect((await Effect.runPromise(readControl(sql)))?.autoMode).toBeUndefined();
  expect(await set("install")).toEqual({ replaced: false, auto: "releases" });
  expect(await observe(a, dir, connect)).toMatchObject({ deployer: true, bound: true });
  await Effect.runPromise(writeAuto(sql, "commits"));
  expect(await set("remove")).toBeNull();
  expect(await observe(a, dir, connect)).toMatchObject({ deployer: false, bound: false });
  expect(await set("install")).toEqual({ replaced: false, auto: "commits" });
  expect(await set("install", "off")).toEqual({ replaced: false, auto: "off" });
  expect((await Effect.runPromise(readControl(sql)))?.autoMode).toBe("off");
  // No token went anywhere: the deployer's one secret is its own.
  expect(Object.keys(mock.state.secrets["erga-ada-example-com-deployer"])).toEqual(["KEY"]);
  // The other answer: the deployer goes, and a deploy again binds none.
  const local = { ...a, deploys: "local" as const };
  expect(step(local, await observe(local, dir, connect)).state).toEqual({ at: "deployer", do: "remove" });
  await removeDeployer(cf, target);
  expect(step(local, await observe(local, dir, connect)).state).toEqual({ at: "deployer", do: "remove" });
  await deploy();
  expect(bindingsOf(mock.state, target.worker).DEPLOYER).toBeUndefined();
  expect(step(local, await observe(local, dir, connect)).state).toEqual({ at: "page" });
}, 120_000);

test("single sign-on on Cloudflare: the gate's setting and the client's secret go with the first deploy, the documents get a domain of their own, and the next step is the setup page", async () => {
  const mock = mockCloudflare();
  const SSO = "sso.ada-example.com",
    WORKER = "sso-ada-example-com",
    ISSUER = "https://idp.example.com";
  const token = "mock-machine-token";
  const endpoints = { authorize: `${ISSUER}/authorize`, token: `${ISSUER}/token` };
  // The account, and beside it the organization's issuer, which publishes its endpoints.
  const net: First["net"] = (input, init) =>
    String(input).startsWith(ISSUER)
      ? Promise.resolve(Response.json({ issuer: ISSUER, authorization_endpoint: endpoints.authorize, token_endpoint: endpoints.token }))
      : mock.fetch(input, init);
  const connect = async () => ({ cf: new Cloudflare(token, net), net, token });
  const answers = {
    ...noAnswers(SSO),
    where: "cloudflare" as const,
    account: ACCOUNT_ID,
    signIn: "sso" as const,
    issuer: ISSUER,
    client: "erga-client",
    pages: "ada-pages.net",
    deploys: "local" as const,
  };
  // The client's secret is the user's step, on setup's page: the build waits for it.
  let seen = await observe(answers, dir, connect);
  expect([seen.oidc, step(answers, seen).state]).toEqual([endpoints, { at: "app", kind: "oidc" }]);
  putSecret(SSO, "SSO_CLIENT_SECRET", "the-client-secret", dir);
  seen = await observe(answers, dir, connect);
  expect(step(answers, seen).state).toEqual({ at: "build" });
  expect(await firstDeploy({ dir, answers, seen, net: mock.fetch, token, print: () => {} })).toBe(HEAD);
  // The Worker has the gate's setting, with the issuer's endpoints, and the client's secret; no GitHub App, and no
  // setting from before the gate.
  const bound = bindingsOf(mock.state, WORKER);
  expect(JSON.parse(bound.SSO.text!)).toEqual({ oidc: { issuer: ISSUER, ...endpoints, client: "erga-client" } });
  expect([bound.GITHUB_CLIENT_ID.text, bound.PROXY_SIGN_IN, bound.GATE_KEY]).toEqual(["", undefined, undefined]);
  expect(Object.keys(mock.state.secrets[WORKER]).sort()).toEqual(["SECRETS_KEY", "SESSION_SECRET", "SSO_CLIENT_SECRET"]);
  expect(mock.state.secrets[WORKER].SSO_CLIENT_SECRET).toBe("the-client-secret");
  // Its own address, and every name of the documents' domain: no shared pages Worker, which the gate could not guard.
  expect(mock.state.domains.map((d) => [d.hostname, d.service])).toEqual([[SSO, WORKER]]);
  expect(JSON.stringify(mock.state.routes)).toContain("*.ada-pages.net/*");
  expect(Object.keys(mock.state.scripts)).toEqual([WORKER]);
  // Anyone whom the organization's sign-in lets through may write.
  expect(rowsOf(mock.state, WORKER).join("\n")).toContain("anyone_access");
  // The release runs with the answers' sign-in: the next step is the setup page.
  seen = await observe(answers, dir, connect);
  expect([seen.live?.signIn, seen.app]).toEqual(["ok", true]);
  // With Cloudflare Access in front instead (a run again with other answers): the setting changes, and setup deploys again.
  const access = { ...answers, issuer: "", client: "", team: "acme", aud: "f".repeat(64) };
  seen = await observe(access, dir, connect);
  expect(seen.live?.signIn).toEqual({ bad: "the deployed single sign-on (SSO) is not the one that the answers name: deploy again" });
  await firstDeploy({ dir, answers: access, seen, net: mock.fetch, token, print: () => {} });
  expect(JSON.parse(bindingsOf(mock.state, WORKER).SSO.text!)).toEqual({ access: { team: "acme", aud: "f".repeat(64) } });
  expect((await observe(access, dir, connect)).live?.signIn).toBe("ok");
}, 120_000);

test("the setup ends with the admin: setup sees the user's row in the database, through Cloudflare's API", async () => {
  const mock = mockCloudflare();
  await firstDeploy(first(mock, HOST));
  const cf = new Cloudflare("mock-machine-token", mock.fetch);
  const acc = `/accounts/${ACCOUNT_ID}`;
  // A new server has no admin; a Worker that is not there has none.
  expect(await adminOn(cf, acc, "erga-ada-example-com")).toBeNull();
  expect(await adminOn(cf, acc, "erga-nowhere")).toBeNull();
  const db = bindingsOf(mock.state, "erga-ada-example-com").DB.database_id;
  // The user's own sign-in, at the page's last step, makes the row (server/identity/setup.ts): here, as the server writes it.
  const calls = mock.state.calls.length;
  await cf.call("POST", `${acc}/d1/database/${db}/query`, "the server's own write", {
    sql: "INSERT INTO users (login, name, role, created) VALUES (?1, ?2, ?3, ?4)",
    params: ["ada", "Ada", "admin", 1],
  });
  expect(await adminOn(cf, acc, "erga-ada-example-com")).toBe("ada");
  // Setup read the Worker's settings and its database: it asked the server nothing.
  expect(mock.state.calls.slice(calls + 1)).toEqual([
    `GET ${acc}/workers/scripts/erga-ada-example-com/settings`,
    `POST ${acc}/d1/database/${db}/query`,
  ]);
});

test("an instance that runs already, with names of its own: setup stops, and its entry stays", async () => {
  const mock = mockCloudflare({ fleet: true });
  await bootstrap(mock);
  const own = join(mkdtempSync(join(tmpdir(), "erga-setup-")), ".erga");
  try {
    writePass(own, HEAD);
    // An entry as `bun erga register` writes it: the Worker "erga", which no address gives.
    const entries: Entry[] = [{ host: "example.com", repo: "example.com/team/erga", branch: "main", ...targetFacts(fleet()) }];
    writeConfig(own, { instances: entries });
    const calls = mock.state.calls.length;
    // The answers would give other names (erga-example-com): setup makes no second Worker beside the one that runs.
    expect(() =>
      writeEntry({
        ...first(mock, "example.com", { account: FLEET_ACCOUNT }),
        dir: own,
        seen: { zones: ["example.com"], subdomain: "erga", held: ["SESSION_SECRET", "SECRETS_KEY"] },
      })
    ).toThrow(
      "example.com has an entry already, with the Worker erga and the database erga: setup would name them example-com and example-com."
    );
    expect(readConfig(own).instances).toEqual(entries);
    expect(namesAt("example.com", own)).toMatchObject({ worker: "erga", database: "erga", bucket: "erga-files" });
    expect(mock.state.calls.length).toBe(calls);
  } finally {
    rmSync(join(own, ".."), { recursive: true, force: true });
  }
}, 120_000);

test("an Erga that runs at the address, set up from another clone: setup takes it over, with its own names; a Worker that isn't Erga stops it", async () => {
  const mock = mockCloudflare({ fleet: true });
  await bootstrap(mock);
  const HERE = "next.example.com";
  const token = "mock-machine-token";
  const cf = new Cloudflare(token, mock.fetch);
  const connect = async () => ({ cf, net: mock.fetch, token });
  const clone = () => {
    const d = join(mkdtempSync(join(tmpdir(), "erga-setup-")), ".erga");
    writePass(d, HEAD);
    return d;
  };
  // The first clone: the instance runs as the Worker erga-next (no address gives that name), tracks staging, and has an admin.
  const [first, second] = [clone(), clone()];
  try {
    const entry: Entry = { host: HERE, repo: "github.com/koomen/erga", branch: "staging", ...targetFacts(next()) };
    writeConfig(first, { instances: [entry] });
    await deployInstance({ dir: first, host: HERE, commit: "HEAD", net: mock.fetch, print: () => {} });
    const db = bindingsOf(mock.state, "erga-next").DB.database_id;
    await cf.call("POST", `/accounts/${FLEET_ACCOUNT}/d1/database/${db}/query`, "the admin", {
      sql: "INSERT INTO users (login, name, role, created) VALUES (?1, ?2, ?3, ?4)",
      params: ["ada", "Ada", "admin", 1],
    });
    // A new clone, with no entry and no secret, and the README's command: the default branch.
    const a = {
      ...noAnswers(HERE),
      where: "cloudflare" as const,
      account: FLEET_ACCOUNT,
      deploys: "local" as const,
    };
    const workers = Object.keys(mock.state.scripts).sort();
    const calls = mock.state.calls.length;
    const seen = await observe(a, second, connect);
    // What it sees is that Worker's: its secrets, its admin. The address is not "in use".
    expect(seen).toMatchObject({
      adopt: "erga-next",
      taken: null,
      admin: true,
      held: ["GITHUB_CLIENT_SECRET", "SESSION_SECRET", "SECRETS_KEY"],
    });
    expect(step(a, seen).state).toEqual({ at: "adopt", worker: "erga-next" });
    // The step: the entry, as the first clone has it. It tracks what the instance tracks, not the command's default.
    expect(await adoptEntry({ dir: second, answers: a, net: mock.fetch, token })).toEqual(entry);
    expect(readConfig(second).instances).toEqual([entry]);
    expect(namesAt(HERE, second)).toMatchObject({ worker: "erga-next", database: "erga-next" });
    // Setup only read Cloudflare (a D1 query reads the admin and the spec), and made no Worker with the address's name.
    expect(mock.state.calls.slice(calls).filter((c) => !c.startsWith("GET ") && !/^POST \S+\/d1\/database\/[^/]+\/query$/.test(c))).toEqual(
      []
    );
    expect(Object.keys(mock.state.scripts).sort()).toEqual(workers);
    // The next look: the instance is this clone's, and it is done.
    const after = await observe(a, second, connect);
    expect([after.adopt, after.taken, step(a, after).state]).toEqual([null, null, { at: "done" }]);

    // A Worker that isn't Erga at the address, in a clone with no entry: setup stops, and reads nothing of that Worker.
    Object.assign(mock.state.scripts["erga-next"], { tags: [], namespaces: [] });
    const third = clone();
    try {
      const mark = mock.state.calls.length;
      const other = await observe(a, third, connect);
      expect(other).toMatchObject({ adopt: null, taken: "it is the address of the Worker erga-next", admin: false, held: [] });
      expect(step(a, other).state).toEqual({
        at: "stop",
        why: `${HERE} is in use: it is the address of the Worker erga-next. Free it, or choose another address.`,
      });
      expect(mock.state.calls.slice(mark).filter((c) => c.includes("erga-next"))).toEqual([]);
      expect(readConfig(third).instances).toEqual([]);
    } finally {
      rmSync(join(third, ".."), { recursive: true, force: true });
    }
  } finally {
    for (const d of [first, second]) rmSync(join(d, ".."), { recursive: true, force: true });
  }
}, 120_000);

test("the dry run in a new clone, as the user's agent runs it: the plan is the take-over and the instance's next step, and nothing is made", () => {
  const tmp = mkdtempSync(join(tmpdir(), "erga-setup-"));
  try {
    // The command's .erga folder is beside its clone's .git: a new clone. The mock's example.com runs as the Worker erga, with an admin.
    Bun.spawnSync(["git", "init", "-q", tmp]);
    const args = ["example.com", "--host", "cloudflare", "--deploys", "cloud", "--remote", "--dry-run"];
    const p = Bun.spawnSync([process.execPath, join(ROOT, "deploy/cli/main.ts"), "setup", ...args], {
      env: { ...process.env, GIT_DIR: join(tmp, ".git"), SSH_CONNECTION: undefined },
      stdin: "ignore",
    });
    expect([p.exitCode, p.stderr.toString()]).toEqual([0, ""]);
    // (An agent's shell has no terminal: the deployer's install needs none. The plan names the Worker's own name.)
    expect(p.stdout.toString().trim().split("\n")).toEqual([
      "PLAN  example.com runs already: it is the Erga of the Worker erga, in the Cloudflare account Erga. I will take it over as it is: its entry goes into this clone's .erga/config.json, as bun erga register writes it. Its Worker, its database and its documents stay.",
      "PASS  Signed in to Cloudflare",
      "PASS  The account Erga holds example.com",
      "PLAN  example.com runs. I will install its deployer, with no token, and deploy example.com again, so that its Worker binds the deployer:",
      `PLAN  • a deployer (the Worker erga-deployer) in your account: ${KEEPS}. It needs a token for the one Worker erga, which you make on Cloudflare and paste on the server: on its Deploy page (/admin/deploy)`,
      "DRY RUN  Nothing is made. Tell the user the plan, and ask: Shall I make it? On yes, run the same command without --dry-run.",
    ]);
    expect(existsSync(join(tmp, ".erga"))).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the command itself, on an instance that runs with no deployer: it installs the deployer and binds it, and keeps the instance's auto-deploy mode; an old deployer's token is not kept", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "erga-setup-"));
  try {
    Bun.spawnSync(["git", "init", "-q", tmp]);
    const runs = [
      ["--deploys", "cloud", "--dry-run"],
      ["--deploys", "cloud"],
      ["--deploys", "cloud"],
      ["--deploys", "cloud", "--auto-deploy", "off"],
      ["--deploys", "local"],
      ["old-deployer"],
      ["--deploys", "cloud", "--dry-run"],
      ["--deploys", "cloud"],
    ];
    const p = Bun.spawn([process.execPath, join(ROOT, "tests/helpers/cloudflare-setup.ts"), JSON.stringify(runs)], {
      env: { ...process.env, GIT_DIR: join(tmp, ".git"), SSH_CONNECTION: undefined },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    // A run that failed says why in its lines.
    expect([code, err, code ? out : ""]).toEqual([0, "", ""]);
    /** Each run: its lines (without a deploy's own), and what the account has after it. */
    const ran: { out: string[]; deployer: boolean; bound: string | null; auto: string | null }[] = [];
    let lines: string[] = [];
    for (const line of out.split("\n")) {
      if (line.startsWith(MARK)) {
        ran.push({ out: lines, ...JSON.parse(line.slice(MARK.length)) });
        lines = [];
      } else if (!line.startsWith("  ")) lines.push(line);
    }
    const [dry, install, again, off, local, dryOld, old] = ran;
    const facts = (r: (typeof ran)[number]) => [r.deployer, r.bound, r.auto];
    const PAGE = `https://${RUNS}/admin/deploy`;

    // The dry run: the plan says that the mode stays. Nothing is made. (A machine's auto-deploy set the mode: commits.)
    expect(dry.out.filter((l) => l.startsWith("PLAN"))).toEqual([
      `PLAN  ${RUNS} runs. I will install its deployer, with no token, and deploy ${RUNS} again, so that its Worker binds the deployer:`,
      `PLAN  • a deployer (the Worker erga-next-deployer) in your account: ${KEEPS}. It needs a token for the one Worker erga-next, which you make on Cloudflare and paste on the server: on its Deploy page (/admin/deploy)`,
    ]);
    expect(facts(dry)).toEqual([false, null, "commits"]);

    // The run: the deployer is there, the instance's Worker binds it, and the mode is the instance's own still.
    expect(install.out).toEqual([
      `PASS  The deployer of ${RUNS} is installed, with no token yet. The user pastes its token on the server: ${PAGE}. With a token, it deploys each new commit of main by itself.`,
      expect.stringContaining(
        "its deployer, in their own account, deploys each new commit of that branch by itself, while it holds its token"
      ),
    ]);
    expect(install.out.at(-1)).toStartWith(`DONE  Tell the user: Erga is live at https://${RUNS}`);
    expect(facts(install)).toEqual([true, "erga-next-deployer", "commits"]);

    // Again: the deployer's code follows, and nothing else changes. The last line names no mode: the run read none.
    expect(again.out[0]).toBe(`PASS  The deployer of ${RUNS} has this code now. It holds what it held. Auto-deploy stays as it is.`);
    expect(again.out.at(-1)).toContain("deploys that branch by itself, as the server's auto-deploy mode says");
    expect(facts(again)).toEqual([true, "erga-next-deployer", "commits"]);

    // Only the user's choice changes the mode.
    expect(off.out.slice(0, 2)).toEqual([
      `PASS  The deployer of ${RUNS} has this code now. It holds what it held.`,
      `PASS  Auto-deploy of ${RUNS} is set, as the user chose: its deployer deploys only when an admin asks, on the server's Deploy page (auto-deploy is off).`,
    ]);
    expect(facts(off)).toEqual([true, "erga-next-deployer", "off"]);
    expect(facts(local)).toEqual([false, null, "off"]);

    // A deployer from before the deployer kept its own token: the plan, the step and the last line say that its token goes.
    const OLD = `The old deployer's token is not kept: the new deployer holds no token, and nothing deploys by itself until the user pastes a token on ${PAGE}.`;
    expect(dryOld.out.filter((l) => l.startsWith("PLAN")).at(-1)).toBe(
      `PLAN  Its deployer is from before the deployer kept its own token: I will replace it with a new one. ${OLD}`
    );
    expect(old.out[0]).toBe(
      `PASS  The deployer of ${RUNS} was from before the deployer kept its own token: it is replaced by a new one. ${OLD}`
    );
    expect(old.out.at(-1)).toStartWith(
      `DONE  Tell the user: Erga is live at https://${RUNS}, and it has its admin. The deployer of ${RUNS} was from before`
    );
    expect(old.out.at(-1)).toContain(OLD);
    expect(facts(old)).toEqual([true, "erga-next-deployer", "off"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 120_000);
