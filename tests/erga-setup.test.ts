// `bun erga setup`'s build (deploy/own/first.ts) against the mock Cloudflare (ERGA_DEPLOY_MOCK=1), from the answers to
// a healthy deploy of a new instance: its entry in .erga/config.json, the secrets set one time, the access rule in its
// database, and no admin's row. Then a second instance, by the same flow. Then the admin, whom setup sees in the
// database through Cloudflare's D1 API. And an instance that runs already, with names that setup would not give: setup
// stops, and its entry stays.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudflareEntry, type Entry, readConfig, withEntry, writeConfig } from "../deploy/cli/config";
import type { MockState } from "../dev/mock-cloudflare";
import { writePass } from "./helpers/pass.ts";
import { Cloudflare } from "../deploy/pipeline/cloudflare-api";
import { adminOn, type First, firstDeploy, writeEntry } from "../deploy/own/first";
import { noAnswers } from "../deploy/own/plan";
import { loadSecrets, namesAt, putSecret } from "../deploy/own/store";
import { deployFacts } from "../deploy/pipeline/account";
import { ACCOUNT_ID, FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, fleet, prepareRelease, ROOT } from "./helpers/deploys.ts";
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
  answers: { ...noAnswers(host), where: "cloudflare", account: ACCOUNT_ID, signIn: "organization", organization: "acme-inc", ...more },
  seen: {
    zones: mock.state.zones.map((z) => z.name),
    subdomain: mock.state.subdomain,
    held: Object.keys(mock.state.secrets[namesAt(host, dir).worker] ?? {}),
  },
  github: "Iv1.ada",
  net: mock.fetch,
  token: "mock-machine-token",
  // The mock deploys this checkout's commit; a real setup takes the head of the branch that the entry tracks.
  print: () => {},
});
const rowsOf = (state: MockState, worker: string) =>
  state.databases.find((d) => d.uuid == bindingsOf(state, worker).DB.database_id)?.rows ?? [];

test("from the answers to a healthy deploy: the entry, the secrets one time, the access rule, and no admin; then a second instance", async () => {
  const mock = mockCloudflare();
  // The GitHub App's secret, as setup's GitHub page keeps it.
  putSecret(HOST, "GITHUB_CLIENT_SECRET", "github-app-secret", dir);
  expect(await firstDeploy(first(mock, HOST))).toBe(HEAD);

  // The entry: written from the answers. It holds no token.
  expect(readConfig(dir).instances.map((e) => [e.host, (e as CloudflareEntry).worker, "token" in e])).toEqual([
    [HOST, "erga-ada-example-com", false],
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
  // The database: the organization's rule, and no user at all. The user who claims the server becomes its admin.
  const rows = rowsOf(mock.state, "erga-ada-example-com");
  expect(rows).toContainEqual(
    expect.stringMatching(/^INSERT INTO access_rules \(kind, value, access, created\) VALUES \('github_org', 'acme-inc', 'write', \d+\)/)
  );
  expect(rows.join("\n")).not.toContain("INSERT INTO users");
  // The job is the setup's. Its entry tracks the default repository's main: no deploy moves a branch.
  const [job] = jobs();
  expect(job[0]).toMatchObject({ command: `bun erga setup ${HOST}`, host: HOST });
  expect(job).toContainEqual({ commit: HEAD, secrets: ["SESSION_SECRET", "FACTORY_KEY", "GITHUB_CLIENT_SECRET"] });
  expect(job.some((x: object) => "main" in x)).toBe(false);
  expect(readConfig(dir).instances.map((e) => [e.repo, e.branch])).toEqual([["github.com/koomen/erga", "main"]]);

  // A run again: the Worker holds its secrets, so none goes out.
  const held = { ...mock.state.secrets["erga-ada-example-com"] };
  expect(await firstDeploy(first(mock, HOST))).toBe(HEAD);
  expect(mock.state.secrets["erga-ada-example-com"]).toEqual(held);
  expect(jobs().at(-1)).toContainEqual({ commit: HEAD });
  // (The rule's statement says ON CONFLICT: written again before there is an admin, it changes nothing.)

  // A second instance, set up later with a branch of its own: the same path, its own names, secrets, database and
  // rule. Nothing of the first one goes to it.
  putSecret(SECOND, "GITHUB_CLIENT_SECRET", "second-app-secret", dir);
  expect(await firstDeploy({ ...first(mock, SECOND, { branch: "staging" }), github: "Iv1.second" })).toBe(HEAD);
  expect(readConfig(dir).instances.map((e) => [e.host, e.branch])).toEqual([
    [HOST, "main"],
    [SECOND, "staging"],
  ]);
  const second = mock.state.secrets["erga-next-ada-example-com"];
  expect(Object.keys(second).sort()).toEqual(["FACTORY_KEY", "GITHUB_CLIENT_SECRET", "SESSION_SECRET"]);
  expect(second.GITHUB_CLIENT_SECRET).toBe("second-app-secret");
  expect(second.SESSION_SECRET).not.toBe(held.SESSION_SECRET);
  expect(bindingsOf(mock.state, "erga-next-ada-example-com").GITHUB_CLIENT_ID.text).toBe("Iv1.second");
  expect(bindingsOf(mock.state, "erga-next-ada-example-com").SNAPSHOT_FROM).toBeUndefined();
  expect(mock.state.databases.find((d) => d.uuid == bindingsOf(mock.state, "erga-next-ada-example-com").DB.database_id)?.name).toBe(
    "erga-next-ada-example-com"
  );
  expect(rowsOf(mock.state, "erga-next-ada-example-com").join("\n")).toContain("INSERT INTO access_rules");
}, 120_000);

test("the setup ends with the admin: setup sees the user's row in the database, through Cloudflare's API", async () => {
  const mock = mockCloudflare();
  putSecret(HOST, "GITHUB_CLIENT_SECRET", "github-app-secret", dir);
  await firstDeploy(first(mock, HOST));
  const cf = new Cloudflare("mock-machine-token", mock.fetch);
  const acc = `/accounts/${ACCOUNT_ID}`;
  // A new server has no admin; a Worker that is not there has none.
  expect(await adminOn(cf, acc, "erga-ada-example-com")).toBeNull();
  expect(await adminOn(cf, acc, "erga-nowhere")).toBeNull();
  // The user's own sign-in, from the one-time link, makes the row (server/identity/claim.ts): here, as the server writes it.
  const db = bindingsOf(mock.state, "erga-ada-example-com").DB.database_id;
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
    const entries: Entry[] = [{ host: "example.com", repo: "example.com/team/erga", branch: "main", ...deployFacts(fleet()) }];
    writeConfig(own, { instances: entries });
    const calls = mock.state.calls.length;
    // The answers would give other names (erga-example-com): setup makes no second Worker beside the one that runs.
    expect(() =>
      writeEntry({
        ...first(mock, "example.com", { account: FLEET_ACCOUNT }),
        dir: own,
        seen: { zones: ["example.com"], subdomain: "erga", held: ["SESSION_SECRET", "FACTORY_KEY"] },
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
