// The deployer on Cloudflare, end to end: the module that setup uploads runs in the Workers runtime on this machine
// (workerd, by Miniflare), with its real bindings: a D1 database, its own Durable Object, its secret. All that it
// reaches outside comes to this test: Cloudflare's API (the mock), GitHub and its registry (the pretend one), and the
// instance's own /api/health. Nothing real is touched.
//
// One journey: a person's token comes over the instance's binding; a new release goes on the instance; a release that
// is not healthy goes back; after a healthy deploy the deployer uploads the release's deployer code as its own; and
// the runtime then runs that upload, as Cloudflare does: the next look is the new code's.
//
// The module's waits are its own (5 seconds between two asks of the health), on a clock that runs 1000 times as fast:
// FAST, a module around the deployer's, which is the uploaded text with no change.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { convertV4MiniflareOptions, Miniflare, Response as RuntimeResponse } from "miniflare";
import { Cloudflare, type Fetch } from "../deploy/deployer/cloudflare-api";
import { readControl } from "../deploy/deployer/control";
import type { D1 } from "../deploy/deployer/d1-binding";
import { readJobs, readLog } from "../deploy/deployer/instance";
import { DEPLOYER_MODULE } from "../deploy/deployer/worker-form";
import { deployerModule, installDeployer } from "../deploy/pipeline/deployer";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { instanceOn } from "./helpers/binding.ts";
import { bindingsOf, bootstrap, prepareRelease, SHA1, SHA2, SHA3 } from "./helpers/deploys.ts";
import { builtBundle } from "./helpers/github.ts";

beforeAll(prepareRelease, 120_000);

const run = Effect.runPromise;
const short = (sha: string) => sha.slice(0, 12);
const NAME = "erga-next-deployer";
const FAST = `import worker, { DeployerState } from "./worker.js";
const wait = globalThis.setTimeout;
globalThis.setTimeout = (work, ms, ...more) => wait(work, ms / 1000, ...more);
export { DeployerState };
export default worker;`;

/** Where the runtime keeps the database and the deployer's store: a second runtime, with the new code, has them too. */
const KEPT = mkdtempSync(join(tmpdir(), "erga-deployer-"));
let runtime: Miniflare;
afterAll(async () => {
  await runtime?.dispose();
  rmSync(KEPT, { recursive: true, force: true });
});

test("a token from the instance, a deploy, a rollback of an unhealthy release, and the deployer's own update: the next look runs the new code", async () => {
  const mock = mockCloudflare({ fleet: true });
  await bootstrap(mock);
  /** Each upload of the deployer's Worker, as Cloudflare got it: its module's text, and its metadata. */
  const uploads: { code: string; meta: { keep_bindings?: string[] } }[] = [];
  let out: Awaited<ReturnType<typeof instanceOn>>["fetch"] = (url, init) => mock.fetch(url, init);
  const net: Fetch = async (input, init) => {
    const url = String(input);
    if (init?.method == "PUT" && url.endsWith(`/workers/scripts/${NAME}`)) {
      const sent = init.body instanceof FormData ? init.body : await new Response(init.body, { headers: init.headers }).formData();
      const form = new FormData();
      for (const [k, v] of sent) form.append(k, v);
      uploads.push({ code: await (sent.get("worker.js") as File).text(), meta: JSON.parse(String(sent.get("metadata"))) });
      init = { ...init, body: form, headers: [...new Headers(init.headers)].filter(([k]) => k != "content-type" && k != "content-length") };
    }
    return out(url, init);
  };
  // Setup's install: the deployer is in the account, with a secret of its own and no token.
  await installDeployer(new Cloudflare("mock-setup-token", net), { account: FLEET_ACCOUNT, worker: "erga-next" });
  expect(uploads).toHaveLength(1);

  /** The runtime's options for the deployer as Cloudflare has it now: its last upload, and the bindings of its metadata. */
  const options = () => {
    const text = (name: string) => bindingsOf(mock.state, NAME)[name].text as string;
    return convertV4MiniflareOptions({
      modules: [
        { type: "ESModule", path: "fast.js", contents: FAST },
        { type: "ESModule", path: "worker.js", contents: uploads.at(-1)!.code },
      ],
      compatibilityDate: "2026-09-01",
      resourcePersistencePath: KEPT,
      d1Databases: ["DB"],
      durableObjects: { STATE: "DeployerState" },
      serviceBindings: { INSTANCE: async () => new RuntimeResponse("not asked", { status: 500 }) },
      bindings: { ACCOUNT: text("ACCOUNT"), WORKER: text("WORKER"), DATABASE: text("DATABASE"), KEY: mock.state.secrets[NAME].KEY },
      outboundService: async (request: Request) => {
        const body = request.method == "GET" || request.method == "HEAD" ? undefined : await request.arrayBuffer();
        const answer = await net(request.url, { method: request.method, headers: [...request.headers], body });
        return new RuntimeResponse(await answer.arrayBuffer(), { status: answer.status, headers: [...answer.headers] });
      },
    });
  };
  runtime = new Miniflare(options());
  /** The instance's database, in the runtime that runs now. */
  let db = (await runtime.getD1Database("DB")) as unknown as D1;
  const { sql, hub, fetch, state, calls } = await instanceOn({ prepare: (text) => db.prepare(text), batch: (all) => db.batch(all) }, mock);
  out = fetch;
  await run(sql("INSERT INTO deploy_control (id, auto) VALUES (1, 1)", []));
  /** One minute of the schedule: one run. */
  const minute = async () => {
    const worker = (await runtime.getWorker()) as unknown as { scheduled(event: { cron: string }): Promise<{ outcome: string }> };
    expect(await worker.scheduled({ cron: "* * * * *" })).toMatchObject({ outcome: "ok" });
  };
  /** The instance's side of its binding DEPLOYER (cloudflare/platform.ts): a token as a POST's text, else a question. */
  const says = async (token?: string) =>
    (await runtime.dispatchFetch("https://deployer/", token == null ? {} : { method: "POST", body: token })).json();
  const runs = () => bindingsOf(mock.state, "erga-next").ERGA_VERSION.text as string;
  const jobs = async () => (await run(readJobs(sql))).map((j) => `${j.kind} ${short(j.sha ?? "")} ${j.state.at}`);
  const logOf = async (id: number) => new TextDecoder().decode(await run(readLog(sql, id, 0)));

  // With no token, a run looks at GitHub and deploys nothing. The deployer says which code it is: this checkout's.
  const first = { ok: true, ready: false, head: null, version: expect.stringMatching(/^[0-9a-f]{12}$/), renewed: null };
  expect(await says()).toEqual(first);
  await minute();
  expect(await run(readControl(sql))).toMatchObject({ auto: true, head: SHA2 });
  expect([runs(), await jobs()]).toEqual([short(SHA1), []]);

  // The token: one that can do more is refused, and the deployer keeps none. The right one is kept.
  expect(await says("mock-deployer-token")).toMatchObject({ ok: false, why: expect.stringContaining("D1") });
  expect(await says()).toMatchObject({ ready: false });
  expect(await says("mock-pair-erga-next")).toEqual({ ...first, ready: true, head: SHA2 });

  // The head's release is not healthy: it goes on the instance, the instance says so for 30 seconds of the deployer's
  // clock, and the version before runs again.
  mock.state.unhealthy = [short(SHA2)];
  await minute();
  expect([runs(), await jobs()]).toEqual([short(SHA1), [`deploy ${short(SHA2)} failed`]]);
  expect(state.asked).toEqual(Array(7).fill("public"));
  expect(uploads).toHaveLength(1);

  // A new commit, with a healthy release that carries newer deployer code: it goes on the instance, and stays.
  const newer = await deployerModule(short(SHA3));
  expect(newer).not.toBe(uploads[0].code);
  const bundle = JSON.parse(new TextDecoder().decode(builtBundle(SHA3))) as { files: Record<string, string> };
  bundle.files[DEPLOYER_MODULE] = btoa(newer);
  hub.state.commits.unshift({ sha: SHA3, title: "Commit 3", at: Date.parse("2026-11-19T10:05:00Z") });
  hub.state.releases.set(SHA3, new TextEncoder().encode(JSON.stringify(bundle)));
  await minute();
  expect([runs(), await jobs()]).toEqual([short(SHA3), [`deploy ${short(SHA3)} done`, `deploy ${short(SHA2)} failed`]]);
  const log = await logOf((await run(readJobs(sql)))[0].id);
  expect(log).toContain(`Wait for its health: done, release ${short(SHA3)}, healthy`);
  // Then its own code: the release's, uploaded with the secret that it has.
  expect(log.split("\n").at(-2)).toBe(`Update the deployer: done, ${NAME} has this release's code`);
  expect(uploads).toHaveLength(2);
  expect([uploads[1].code, uploads[1].meta.keep_bindings]).toEqual([newer, ["secret_text"]]);

  // Cloudflare runs the upload from now on: the deployer says that it is the release's code, and how it got it. It
  // holds the token that the code before it kept, and the next look is its own.
  await runtime.dispose();
  runtime = new Miniflare(options());
  db = (await runtime.getD1Database("DB")) as unknown as D1;
  const renewed = { at: expect.any(Number), version: short(SHA3), why: null };
  expect(await says()).toEqual({ ok: true, ready: true, head: SHA3, version: short(SHA3), renewed });
  const before = (await run(sql("SELECT looked FROM deploy_control WHERE id = 1", [])))[0];
  await minute();
  expect(Number((await run(sql("SELECT looked FROM deploy_control WHERE id = 1", [])))[0])).toBeGreaterThan(Number(before));
  expect([runs(), (await jobs()).length, uploads.length]).toEqual([short(SHA3), 2, 2]);
  // At Cloudflare, all of it reached two Workers only: the instance's and its own. (The other calls are the token's
  // check: whether Cloudflare knows it, and that it can't read the databases or another Worker.)
  expect([...new Set(calls().filter((c) => !c.includes("/workers/scripts/erga-next")))]).toEqual([
    `GET /accounts/${FLEET_ACCOUNT}/tokens/verify`,
    `GET /accounts/${FLEET_ACCOUNT}/d1/database?per_page=1`,
    `GET /accounts/${FLEET_ACCOUNT}/workers/scripts`,
  ]);
}, 60_000);
