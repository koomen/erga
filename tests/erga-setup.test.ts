// `bun erga setup`'s build (deploy/own/first.ts) against the mock Cloudflare (ERGA_DEPLOY_MOCK=1), from the answers to
// a healthy deploy of a new instance: its entry in .erga/config.json, the secrets set one time, the access rule in its
// database, and no admin's row. Then a staging instance of it, by the same flow. Then the ops token, from a fake
// server's device flow. And an instance that runs already, with names that setup would not give: its entry stays.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudflareEntry, type Entry, readConfig, withEntry, writeConfig } from "../deploy/cli/config";
import type { MockState } from "../dev/mock-cloudflare";
import { writePass } from "./helpers/pass.ts";
import { type First, firstDeploy, register } from "../deploy/own/first";
import { noAnswers } from "../deploy/own/plan";
import { loadSecrets, namesAt, putSecret } from "../deploy/own/store";
import { deployFacts } from "../deploy/pipeline/account";
import { ACCOUNT_ID, FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, prepareRelease, primary, ROOT } from "./helpers/deploys.ts";
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

/** What the build takes from the flow, for `host`: the answers, and what the command saw in the mock account. */
const first = (mock: { state: MockState; fetch: First["net"] }, host: string, more: Partial<First["answers"]> = {}): First => ({
  dir,
  answers: { ...noAnswers(host), where: "cloudflare", account: ACCOUNT_ID, signIn: "company", company: "acme-inc", ...more },
  seen: {
    zones: mock.state.zones.map((z) => z.name),
    subdomain: mock.state.subdomain,
    held: Object.keys(mock.state.secrets[namesAt(host, dir).worker] ?? {}),
  },
  github: "Iv1.ada",
  net: mock.fetch,
  token: "mock-machine-token",
  print: () => {},
  // This branch's commit; setup takes origin/main by default.
  commit: "HEAD",
});
const rowsOf = (state: MockState, worker: string) =>
  state.databases.find((d) => d.uuid == bindingsOf(state, worker).DB.database_id)?.rows ?? [];

test("from the answers to a healthy deploy: the entry, the secrets one time, the access rule, and no admin; then its staging instance", async () => {
  const mock = mockCloudflare();
  // The GitHub App's secret, as the setup page keeps it.
  putSecret(HOST, "GITHUB_CLIENT_SECRET", "github-app-secret", dir);
  expect(await firstDeploy(first(mock, HOST))).toBe(HEAD);

  // The entry: written from the answers, with no token yet.
  expect(readConfig(dir).instances.map((e) => [e.host, e.stagingOf ?? null, (e as CloudflareEntry).worker, e.token])).toEqual([
    [HOST, null, "erga-ada-example-com", ""],
  ]);
  // The secrets: made one time, kept in .erga/secrets.json, sent with this deploy.
  const file = loadSecrets(dir);
  expect(mock.state.secrets["erga-ada-example-com"]).toEqual({
    SESSION_SECRET: file[HOST].SESSION_SECRET,
    FACTORY_KEY: file[HOST].FACTORY_KEY,
    GITHUB_CLIENT_SECRET: "github-app-secret",
  });
  expect(file[HOST].SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
  expect(bindingsOf(mock.state, "erga-ada-example-com").GITHUB_CLIENT_ID.text).toBe("Iv1.ada");
  expect(JSON.parse(bindingsOf(mock.state, "erga-ada-example-com").SERVER_DEFAULTS.text)).toEqual({
    public_sharing: false,
    delete_docs_after_hours: null,
  });
  expect(await (await mock.fetch(`https://${HOST}/api/health`)).json()).toMatchObject({ ok: true, version: HEAD.slice(0, 12) });
  // The database: the company's rule, and no user at all. The person who claims the server becomes its admin.
  const rows = rowsOf(mock.state, "erga-ada-example-com");
  expect(rows).toContainEqual(
    expect.stringMatching(/^INSERT INTO access_rules \(kind, value, access, created\) VALUES \('github_org', 'acme-inc', 'write', \d+\)/)
  );
  expect(rows.join("\n")).not.toContain("INSERT INTO users");
  // The job is the setup's, and main never moves to a commit that --commit names.
  const [job] = jobs();
  expect(job[0]).toMatchObject({ command: `bun erga setup ${HOST} --commit HEAD`, host: HOST });
  expect(job).toContainEqual({ commit: HEAD, secrets: ["SESSION_SECRET", "FACTORY_KEY", "GITHUB_CLIENT_SECRET"] });
  expect(job).toContainEqual({ main: "kept: --commit" });

  // A run again: the Worker holds its secrets, so none goes out.
  const held = { ...mock.state.secrets["erga-ada-example-com"] };
  expect(await firstDeploy(first(mock, HOST))).toBe(HEAD);
  expect(mock.state.secrets["erga-ada-example-com"]).toEqual(held);
  expect(jobs().at(-1)).toContainEqual({ commit: HEAD });
  // (The rule's statement says ON CONFLICT: written again before there is an admin, it changes nothing.)

  // Its staging instance, set up later: the primary gets the secret they share, and the new instance a copy of its data.
  writeConfig(dir, withEntry(readConfig(dir), { ...readConfig(dir).instances[0], token: "erga_ops_primary" }));
  putSecret(STAGING, "GITHUB_CLIENT_SECRET", "staging-app-secret", dir);
  expect(await firstDeploy({ ...first(mock, STAGING, { stagingOf: HOST }), github: "Iv1.staging" })).toBe(HEAD);
  expect(readConfig(dir).instances.map((e) => [e.host, e.stagingOf ?? null])).toEqual([
    [HOST, null],
    [STAGING, HOST],
  ]);
  const shared = loadSecrets(dir)[HOST].SNAPSHOT_TOKEN;
  expect(shared).toMatch(/^[0-9a-f]{64}$/);
  expect(mock.state.secrets["erga-ada-example-com"].SNAPSHOT_TOKEN).toBe(shared);
  expect(mock.state.secrets["erga-staging-ada-example-com"]).toMatchObject({
    SNAPSHOT_TOKEN: shared,
    GITHUB_CLIENT_SECRET: "staging-app-secret",
  });
  expect(mock.state.secrets["erga-staging-ada-example-com"].SESSION_SECRET).not.toBe(held.SESSION_SECRET);
  expect(bindingsOf(mock.state, "erga-staging-ada-example-com").SNAPSHOT_FROM.text).toBe(`https://${HOST}`);
  expect(bindingsOf(mock.state, "erga-staging-ada-example-com").GITHUB_CLIENT_ID.text).toBe("Iv1.staging");
  // The settings' defaults are its primary's, and its database is a copy: the rule came with it.
  expect(bindingsOf(mock.state, "erga-staging-ada-example-com").SERVER_DEFAULTS.text).toBe(
    bindingsOf(mock.state, "erga-ada-example-com").SERVER_DEFAULTS.text
  );
  expect(
    mock.state.databases.find((d) => d.uuid == bindingsOf(mock.state, "erga-staging-ada-example-com").DB.database_id)?.name
  ).toStartWith("erga-staging-ada-example-com-");
}, 120_000);

test("the setup ends with the ops token: the page gets the request's code, the person approves, and the entry gets the token", async () => {
  const asked: string[] = [];
  const server = Bun.serve({
    // (Its own address: with all addresses, a test server of the browser tests can take the same port on 127.0.0.1.)
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      asked.push(path);
      if (path == "/api/auth/request")
        return Response.json({
          code: "c0de",
          approve_url: `${new URL(req.url).origin}/tokens/approve?code=ABCD-EFGH`,
          interval: 0,
          expires_in: 60,
        });
      if (path == "/api/auth/poll") return Response.json({ status: "approved", token: "erga_ops_new", login: "ada" });
      if (path == "/api/ops") return Response.json({ version: HEAD.slice(0, 12), host: "x", deploy: null });
      return new Response("no", { status: 404 });
    },
  });
  try {
    const host = `127.0.0.1:${server.port}`;
    const entry = { ...readConfig(dir).instances[0], host, token: "" };
    writeConfig(dir, withEntry(readConfig(dir), entry));
    const codes: string[] = [];
    expect(await register(dir, host, { asked: (code) => codes.push(code) })).toBe("ada");
    // Only the code that the person's link carries goes to the page: the code that collects the token stays here.
    expect(codes).toEqual(["ABCD-EFGH"]);
    expect(asked).toEqual(["/api/auth/request", "/api/auth/poll", "/api/ops"]);
    expect(readConfig(dir).instances.find((e) => e.host == host)).toEqual({ ...entry, token: "erga_ops_new" });
  } finally {
    server.stop(true);
  }
});

test("an instance that runs already, with names of its own: setup keeps its entry, and deploys it by the same path", async () => {
  const mock = mockCloudflare({ fleet: true });
  await bootstrap(mock);
  const own = join(mkdtempSync(join(tmpdir(), "erga-setup-")), ".erga");
  try {
    writePass(own, HEAD);
    // A registered entry, as `bun erga register` writes it: the Worker "erga", which no address gives.
    const entries: Entry[] = [{ host: "example.com", ...deployFacts(primary()), token: "erga_ops_primary" }];
    writeConfig(own, { instances: entries });
    const rows = JSON.stringify(mock.state.databases.map((d) => d.rows));
    expect(
      await firstDeploy({
        ...first(mock, "example.com", { account: FLEET_ACCOUNT }),
        dir: own,
        seen: { zones: ["example.com"], subdomain: "erga", held: ["SESSION_SECRET", "FACTORY_KEY"] },
        github: "Ov23primary",
      })
    ).toBe(HEAD);
    // The entry stays as it was: the answers would give other names (example-com), and other pages.
    expect(readConfig(own).instances).toEqual(entries);
    expect(namesAt("example.com", own)).toMatchObject({ worker: "erga", database: "erga", bucket: "erga-files" });
    expect(Object.keys(mock.state.scripts)).toContain("erga");
    expect(bindingsOf(mock.state, "erga").ERGA_VERSION.text).toBe(HEAD.slice(0, 12));
    // It has an admin already: setup writes no row.
    expect(JSON.stringify(mock.state.databases.map((d) => d.rows))).toBe(rows);
  } finally {
    rmSync(join(own, ".."), { recursive: true, force: true });
  }
}, 120_000);
