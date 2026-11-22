// `bun erga setup`'s build (deploy/own/first.ts) against the mock Cloudflare (ERGA_DEPLOY_MOCK=1), from the answers to
// a healthy deploy of a new instance: its entry in .erga/config.json, the secrets set one time, and a database with no
// user and no rule. Then a second instance, by the same flow. Then the setup page's steps, which setup sees in the
// database through Cloudflare's D1 API: the deployer's token, and the admin. And an instance that runs already, with names that setup would not give: setup
// stops, and its entry stays. And an Erga that another clone set up: a clone with no entry for it takes it over.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudflareEntry, type Entry, readConfig, withEntry, writeConfig } from "../deploy/cli/config";
import type { MockState } from "../dev/mock-cloudflare";
import { writePass } from "./helpers/pass.ts";
import { Cloudflare } from "../deploy/deployer/cloudflare-api";
import { adminOn, adoptEntry, endStep, type First, firstDeploy, stepOn, writeEntry } from "../deploy/own/first";
import { specOn, sqlOf } from "../deploy/cli/instance";
import { instanceReader, jobsReader } from "../deploy/cli/running";
import { deployInstance } from "../deploy/cli/deploy";
import { liveOf, observe } from "../deploy/own/facts";
import { step } from "../deploy/own/flow";
import { noAnswers } from "../deploy/own/plan";
import { loadSecrets, namesAt } from "../deploy/own/store";
import { deployerStep, openToken, readStep, sealToken } from "../server/identity/setup-link";
import { targetFacts } from "../deploy/pipeline/pipeline";
import { ACCOUNT_ID, FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, fleet, next, prepareRelease, ROOT } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
const HOST = "erga.ada-example.com",
  SECOND = "erga-next.ada-example.com";
let dir = "";

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

test("the setup page's steps: setup sees the deployer's token and the admin in the database, through Cloudflare's API", async () => {
  const mock = mockCloudflare();
  await firstDeploy(first(mock, HOST));
  const cf = new Cloudflare("mock-machine-token", mock.fetch);
  const acc = `/accounts/${ACCOUNT_ID}`;
  // A new server has no admin; a Worker that is not there has none.
  expect(await adminOn(cf, acc, "erga-ada-example-com")).toBeNull();
  expect(await adminOn(cf, acc, "erga-nowhere")).toBeNull();
  const db = bindingsOf(mock.state, "erga-ada-example-com").DB.database_id;
  // The deployer's step: the page has no row yet. Then the user pastes the token: the server seals it with its
  // SESSION_SECRET, which this machine holds too, and writes the row (here, as the server writes it).
  expect(await stepOn(cf, acc, db)).toEqual({ text: null, step: { at: "open" } });
  const secret = loadSecrets(dir)[HOST].SESSION_SECRET;
  const waiting = deployerStep({ at: "open" }, { kind: "pasted", ...(await sealToken(secret, "token-of-the-user")) });
  await cf.call("POST", `${acc}/d1/database/${db}/query`, "the server's own write", {
    sql: "INSERT INTO setup (id, deployer) VALUES (1, ?1)",
    params: [JSON.stringify(waiting)],
  });
  const at = await stepOn(cf, acc, db);
  expect(at.step.at).toBe("waiting");
  // Only the server's own secret opens it, and the row never holds it in the clear.
  expect(at.step.at == "waiting" && [await openToken(secret, at.step), await openToken("another-secret", at.step)]).toEqual([
    "token-of-the-user",
    null,
  ]);
  expect(at.text).not.toContain("token-of-the-user");
  // Setup writes how the install ended, onto the row as it read it: the token is gone from the row.
  await endStep(cf, acc, db, at, { kind: "installed", unconfirmed: ["That the token may deploy."] });
  expect(await stepOn(cf, acc, db)).toMatchObject({ step: { at: "installed", unconfirmed: ["That the token may deploy."] } });
  expect(readStep("not a step")).toEqual({ at: "open" });
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
    // (An agent's shell has no terminal: the plan is the deployer's all the same, with the Worker's own name.)
    expect(p.stdout.toString().trim().split("\n")).toEqual([
      "PLAN  example.com runs already: it is the Erga of the Worker erga, in the Cloudflare account Erga. I will take it over as it is: its entry goes into this clone's .erga/config.json, as bun erga register writes it. Its Worker, its database and its documents stay.",
      "PASS  Signed in to Cloudflare",
      "PASS  The account Erga holds example.com",
      "PLAN  example.com runs. I will install its deployer:",
      "PLAN  • a deployer (the Worker erga-deployer) in your account: it deploys each new release by itself. It holds a token for the one Worker erga, which you make on Cloudflare and paste in your terminal",
      "DRY RUN  Nothing is made. Tell the user the plan, and ask: Shall I make it? On yes, run the same command without --dry-run.",
    ]);
    expect(existsSync(join(tmp, ".erga"))).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
