// `bun erga setup` (deploy/own/first.ts) against the mock Cloudflare (ERGA_DEPLOY_MOCK=1), from the answers to a healthy
// deploy of a new instance and its staging instance: the entries in .erga/config.json, the secrets set one time, the first
// admin's row and feedback_repository in each database. Then register's ops token, from a fake server's device flow.
// And an instance that runs already, with names that setup would not give: the same path, on its entry.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudflareEntry, type Entry, readConfig, withEntry, writeConfig } from "../deploy/cli/config";
import { writePass } from "./helpers/pass.ts";
import { firstDeploy, registerSetup, type Setup } from "../deploy/own/first";
import { defaultAnswers } from "../deploy/own/plan";
import { loadSecrets, namesAt, putSecret } from "../deploy/own/store";
import { deployFacts } from "../deploy/pipeline/account";
import { ACCOUNT_ID, FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, prepareRelease, primary, primaryOf, ROOT, staging } from "./helpers/deploys.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

const HEAD = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
const HOST = "erga.ada-example.com",
  STAGING = "erga-staging.ada-example.com";
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

const jobs = () =>
  readdirSync(join(dir, "jobs"))
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) =>
      readFileSync(join(dir, "jobs", f), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    );

test("from the answers to a healthy deploy: the entries, the secrets one time, the first admin and feedback's repository", async () => {
  const mock = mockCloudflare();
  const answers = { ...defaultAnswers("ada"), host: HOST, staging: STAGING, feedback: "ada/erga" };
  const o: Setup = {
    dir,
    answers,
    account: ACCOUNT_ID,
    zones: mock.state.zones.map((z) => z.name),
    subdomain: mock.state.subdomain,
    ids: { github: "Iv1.ada" },
    net: mock.fetch,
    token: "mock-machine-token",
    print: () => {},
    // This branch's commit; setup takes origin/main by default.
    commit: "HEAD",
  };
  // The GitHub app's secret, as the checklist page keeps it.
  putSecret(HOST, "GITHUB_CLIENT_SECRET", "github-app-secret", dir);
  expect(await firstDeploy(o, "primary")).toBe(HEAD);
  expect(await firstDeploy(o, "staging")).toBe(HEAD);

  // The entries: written from the answers, the staging one with its primary, no token yet.
  expect(readConfig(dir).instances.map((e) => [e.host, e.stagingOf ?? null, (e as CloudflareEntry).worker, e.token])).toEqual([
    [HOST, null, "erga-ada-example-com", ""],
    [STAGING, HOST, "erga-staging-ada-example-com", ""],
  ]);

  // The secrets: each server its own, the app's and SNAPSHOT_TOKEN shared, all kept in .erga/secrets.json.
  const file = loadSecrets(dir);
  const p = mock.state.secrets["erga-ada-example-com"],
    s = mock.state.secrets["erga-staging-ada-example-com"];
  expect(p).toEqual({
    SESSION_SECRET: file[HOST].SESSION_SECRET,
    FACTORY_KEY: file[HOST].FACTORY_KEY,
    GITHUB_CLIENT_SECRET: "github-app-secret",
    SNAPSHOT_TOKEN: file[HOST].SNAPSHOT_TOKEN,
  });
  expect(s).toEqual({
    SESSION_SECRET: file[STAGING].SESSION_SECRET,
    FACTORY_KEY: file[STAGING].FACTORY_KEY,
    GITHUB_CLIENT_SECRET: "github-app-secret",
    SNAPSHOT_TOKEN: file[HOST].SNAPSHOT_TOKEN,
  });
  expect(s.SESSION_SECRET).not.toBe(p.SESSION_SECRET);
  expect(p.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);

  // The plain settings: the entry's, and the staging instance's one more: its primary's address.
  expect(bindingsOf(mock.state, "erga-ada-example-com").GITHUB_CLIENT_ID.text).toBe("Iv1.ada");
  expect(bindingsOf(mock.state, "erga-ada-example-com").SNAPSHOT_FROM.text).toBe("");
  expect(bindingsOf(mock.state, "erga-staging-ada-example-com").DEPLOY_TARGET).toBeUndefined();
  expect(bindingsOf(mock.state, "erga-staging-ada-example-com").SNAPSHOT_FROM.text).toBe(`https://${HOST}`);

  // The new servers answer, healthy.
  for (const host of [HOST, STAGING])
    expect(await (await mock.fetch(`https://${host}/api/health`)).json()).toMatchObject({ ok: true, version: HEAD.slice(0, 12) });

  // Each Worker's database: the first admin's row, and the setting. Staging's is a copy of its primary's, which has them.
  const rows = () => Object.fromEntries(mock.state.databases.map((d) => [d.uuid, [...(d.rows ?? [])]]));
  const now = rows();
  const primaryDb = bindingsOf(mock.state, "erga-ada-example-com").DB.database_id,
    stagingDb = bindingsOf(mock.state, "erga-staging-ada-example-com").DB.database_id;
  expect(mock.state.databases.find((d) => d.uuid == stagingDb)?.name).toStartWith("erga-staging-ada-example-com-");
  for (const name of [primaryDb, stagingDb]) {
    expect(now[name]).toContainEqual(
      expect.stringMatching(/^INSERT INTO users \(login, name, role, created\) VALUES \('ada', 'ada', 'admin', \d+\);$/)
    );
    expect(now[name]).toContainEqual(
      expect.stringMatching(
        /^INSERT INTO server_config \(key, value, updated, updated_by\) VALUES \('feedback_repository', '"ada\/erga"', \d+, 'ada'\);$/
      )
    );
  }
  const [first] = jobs();
  expect(first[0]).toMatchObject({ command: `bun erga setup ${HOST}`, host: HOST });
  expect(first).toContainEqual({ commit: HEAD, secrets: ["SESSION_SECRET", "FACTORY_KEY", "GITHUB_CLIENT_SECRET", "SNAPSHOT_TOKEN"] });

  // A run again: the Worker holds its secrets, so none goes out; the database has its admin, so nothing is written.
  const held = { ...mock.state.secrets["erga-ada-example-com"] };
  expect(await firstDeploy(o, "primary")).toBe(HEAD);
  expect(mock.state.secrets["erga-ada-example-com"]).toEqual(held);
  expect(jobs().at(-1)).toContainEqual({ commit: HEAD });
  expect(jobs().at(-1)?.at(-1).result).toBe("ok");
  expect(rows()).toEqual(now);
}, 120_000);

test("setup ends with register's token: the admin approves it, and the entry gets it", async () => {
  const asked: string[] = [];
  const server = Bun.serve({
    // (Its own address: with all addresses, a test server of the browser tests can take the same port on 127.0.0.1.)
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      asked.push(path);
      if (path == "/api/auth/request")
        return Response.json({ code: "c0de", approve_url: `${new URL(req.url).origin}/approve/c0de`, interval: 0, expires_in: 60 });
      if (path == "/api/auth/poll") return Response.json({ status: "approved", token: "erga_ops_new", login: "ada" });
      if (path == "/api/ops") return Response.json({ version: HEAD.slice(0, 12), host: "x", deploy: null });
      return new Response("no", { status: 404 });
    },
  });
  try {
    const host = `127.0.0.1:${server.port}`;
    const entry = { ...readConfig(dir).instances[0], host };
    writeConfig(dir, withEntry(readConfig(dir), entry));
    const lines: string[] = [];
    expect(await registerSetup(dir, host, { say: (l) => lines.push(l) })).toBe("ada");
    expect(lines[0]).toBe(`Open http://${host}/approve/c0de as an admin, and approve it.`);
    expect(asked).toEqual(["/api/auth/request", "/api/auth/poll", "/api/ops"]);
    expect(readConfig(dir).instances.find((e) => e.host == host)).toEqual({ ...entry, token: "erga_ops_new" });
  } finally {
    server.stop(true);
  }
});

test("setup --home: the instance serves the homepage on that domain; its staging instance never does", async () => {
  const mock = mockCloudflare();
  mock.state.zones.push({ id: "zone00000000000000000000000ada01", name: "ada-example.org", status: "active" });
  const answers = { ...defaultAnswers("ada"), host: "erga.ada-example.com", staging: "erga-staging.ada-example.com" };
  const o: Setup = {
    dir,
    answers,
    account: ACCOUNT_ID,
    zones: mock.state.zones.map((z) => z.name),
    subdomain: mock.state.subdomain,
    ids: { github: "Iv1.ada" },
    net: mock.fetch,
    token: "mock-machine-token",
    print: () => {},
    commit: "HEAD",
    home: "ada-example.org",
  };
  await firstDeploy(o, "primary");
  await firstDeploy(o, "staging");
  expect(JSON.parse(bindingsOf(mock.state, "erga-ada-example-com").ERGA_DEPLOY.text).home).toBe("ada-example.org");
  expect(JSON.parse(bindingsOf(mock.state, "erga-staging-ada-example-com").ERGA_DEPLOY.text).home).toBeUndefined();
  expect(mock.state.domains).toContainEqual(expect.objectContaining({ hostname: "ada-example.org", service: "erga-ada-example-com" }));
}, 120_000);

test("an instance that runs already, with names of its own: setup keeps its entries, and deploys them by the same path", async () => {
  const mock = mockCloudflare({ fleet: true });
  await bootstrap(mock);
  const own = join(mkdtempSync(join(tmpdir(), "erga-setup-")), ".erga");
  try {
    writePass(own, HEAD);
    // Registered entries, as `bun erga register` writes them: the Worker "erga", which no address gives.
    const entries: Entry[] = [
      { host: "example.com", ...deployFacts(primary()), token: "erga_ops_primary" },
      { host: "staging.example.com", stagingOf: "example.com", ...deployFacts(staging()), token: "erga_ops_staging" },
    ];
    writeConfig(own, { instances: entries });
    const o: Setup = {
      dir: own,
      answers: { ...defaultAnswers("ada"), host: "example.com", staging: "staging.example.com" },
      account: FLEET_ACCOUNT,
      zones: mock.state.zones.map((z) => z.name),
      subdomain: mock.state.subdomain,
      ids: { github: "Ov23primary" },
      net: mock.fetch,
      token: "mock-machine-token",
      print: () => {},
      commit: "HEAD",
    };
    const stagingDb = bindingsOf(mock.state, "erga-staging").DB.database_id;
    const rows = JSON.stringify(mock.state.databases.map((d) => d.rows));
    expect(await firstDeploy(o, "primary")).toBe(HEAD);
    expect(await firstDeploy(o, "staging")).toBe(HEAD);

    // The entries stay as they were: the answers would give other names (example-com), and other pages.
    expect(readConfig(own).instances).toEqual(entries);
    expect(namesAt("example.com", own)).toMatchObject({ worker: "erga", database: "erga", bucket: "erga-files" });
    expect(Object.keys(mock.state.scripts).sort()).toEqual(["erga", "erga-staging"]);
    // The same deploy as any instance's: this commit on its Worker, its database kept, its staging instance's copy kept.
    expect(bindingsOf(mock.state, "erga").ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    expect(bindingsOf(mock.state, "erga-staging").ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    expect(bindingsOf(mock.state, "erga-staging").DB.database_id).toBe(stagingDb);
    expect(bindingsOf(mock.state, "erga-staging").SNAPSHOT_FROM.text).toBe("https://example.com");
    expect(JSON.parse(primaryOf(mock.state)).db.uuid).toBe(bindingsOf(mock.state, "erga").DB.database_id);
    // It has an admin already: setup writes no row.
    expect(JSON.stringify(mock.state.databases.map((d) => d.rows))).toBe(rows);
  } finally {
    rmSync(join(own, ".."), { recursive: true, force: true });
  }
}, 120_000);
