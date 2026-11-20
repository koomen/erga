// The deployer on Cloudflare, as setup installs it (deploy/pipeline/deployer.ts): on the mock Cloudflare, what the
// install uploads; and in the Workers runtime on this machine (Miniflare), that the uploaded module runs: its schedule
// deploys a release, with the mock Cloudflare and a pretend GitHub as all that it can reach. Nothing real is touched.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { convertV4MiniflareOptions, Miniflare, Response as RuntimeResponse } from "miniflare";
import { Cloudflare } from "../deploy/deployer/cloudflare-api";
import type { D1 } from "../deploy/deployer/d1-binding";
import { readControl } from "../deploy/deployer/control";
import { readJobs, readLog } from "../deploy/deployer/instance";
import { DEPLOYER_TAG, deployerModule, installDeployer } from "../deploy/pipeline/deployer";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { instanceOn } from "./helpers/binding.ts";
import { bindingsOf, bootstrap, databaseOf, prepareRelease, SHA1, SHA2 } from "./helpers/deploys.ts";

beforeAll(prepareRelease, 120_000);

const run = Effect.runPromise;
const short = (sha: string) => sha.slice(0, 12);
const TARGET = { account: FLEET_ACCOUNT, worker: "erga-next" };

describe("the install", () => {
  test("puts the deployer beside the instance's Worker: its database, its token as a secret, a schedule, no address", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const cf = new Cloudflare("mock-setup-token", mock.fetch);
    const from = mock.state.calls.length;
    expect(await installDeployer(cf, TARGET, "the-deployer-token-0123456789")).toBe("erga-next-deployer");
    const script = mock.state.scripts["erga-next-deployer"];
    const bindings = bindingsOf(mock.state, "erga-next-deployer");
    expect(Object.keys(bindings).sort()).toEqual(["ACCOUNT", "CLOUDFLARE_API_TOKEN", "DATABASE", "DB", "INSTANCE", "STATE", "WORKER"]);
    expect(bindings.DB).toMatchObject({ type: "d1", database_id: databaseOf(mock.state, "erga-next").uuid });
    expect(bindings.DATABASE.text).toBe(databaseOf(mock.state, "erga-next").uuid);
    // Its own store, a Durable Object of its own class; and the instance's Worker, for the health check.
    expect(bindings.STATE).toMatchObject({ type: "durable_object_namespace", class_name: "DeployerState" });
    expect(script.metadata.exports).toEqual({ DeployerState: { type: "durable-object", storage: "sqlite" } });
    expect(bindings.INSTANCE).toMatchObject({ type: "service", service: "erga-next" });
    expect(bindings.ACCOUNT.text).toBe(FLEET_ACCOUNT);
    expect(bindings.WORKER.text).toBe("erga-next");
    // The token is a secret of the Worker: Cloudflare gives it back to nobody.
    expect(bindings.CLOUDFLARE_API_TOKEN.type).toBe("secret_text");
    expect(JSON.stringify(script.metadata)).not.toContain("the-deployer-token");
    expect(mock.state.secrets["erga-next-deployer"]).toEqual({ CLOUDFLARE_API_TOKEN: "the-deployer-token-0123456789" });
    expect(script.modules).toEqual(["worker.js"]);
    expect(script.tags).toEqual([DEPLOYER_TAG]);
    expect(script.workersDev).toBe(false);
    expect(mock.state.schedules["erga-next-deployer"]).toEqual(["* * * * *"]);
    // It made no route, no domain and no database, and it did not touch the instance's Worker.
    const acc = `/accounts/${FLEET_ACCOUNT}`;
    expect(mock.state.calls.slice(from)).toEqual([
      `GET ${acc}/workers/scripts/erga-next/settings`,
      `GET ${acc}/workers/scripts`,
      `PUT ${acc}/workers/scripts/erga-next-deployer`,
      `POST ${acc}/workers/scripts/erga-next-deployer/subdomain`,
      `PUT ${acc}/workers/scripts/erga-next-deployer/schedules`,
    ]);
    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(short(SHA1));

    // A second install (a new token) replaces the first one's.
    await installDeployer(cf, TARGET, "another-token-0123456789");
    expect(mock.state.secrets["erga-next-deployer"]).toEqual({ CLOUDFLARE_API_TOKEN: "another-token-0123456789" });
  });

  test("never replaces a Worker that Erga did not make, and needs the instance's Worker and database", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const cf = new Cloudflare("mock-setup-token", mock.fetch);
    // A Worker of the deployer's name that is the person's own.
    const form = new FormData();
    form.set("metadata", JSON.stringify({ main_module: "index.js", compatibility_date: "2026-01-01", bindings: [] }));
    form.append("index.js", new File(["export default {}"], "index.js", { type: "application/javascript+module" }));
    await cf.call("PUT", `/accounts/${FLEET_ACCOUNT}/workers/scripts/erga-next-deployer`, "upload a Worker of the person's own", form);
    const from = mock.state.calls.length;
    await expect(installDeployer(cf, TARGET, "the-deployer-token-0123456789")).rejects.toThrow(
      "Your account has a Worker erga-next-deployer that Erga did not make. Erga does not replace it"
    );
    expect(mock.state.calls.slice(from).filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(mock.state.scripts["erga-next-deployer"].modules).toEqual(["index.js"]);

    await expect(installDeployer(cf, { account: FLEET_ACCOUNT, worker: "no-such-worker" }, "t")).rejects.toThrow(
      "The Worker no-such-worker is not there, or it has no database. Deploy the instance first"
    );
    await expect(installDeployer(cf, { account: FLEET_ACCOUNT, worker: "w".repeat(60) }, "t")).rejects.toThrow(
      "has more than 63 characters"
    );
  });
});

describe("the installed Worker, in the Workers runtime", () => {
  let runtime: Miniflare;
  afterAll(() => runtime?.dispose());

  test("its schedule deploys the head's release: the module that the install uploads runs, and reaches only what a Worker can", async () => {
    // All that the Worker reaches outside itself comes here: Cloudflare's API (the mock) and GitHub (the pretend one).
    let out: Awaited<ReturnType<typeof instanceOn>>["fetch"] = async () => new Response("the test is not ready", { status: 503 });
    const made = mockCloudflare({ fleet: true });
    await bootstrap(made);
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: [{ type: "ESModule", path: "worker.js", contents: await deployerModule() }],
        compatibilityDate: "2026-09-01",
        d1Databases: ["DB"],
        durableObjects: { STATE: "DeployerState" },
        // The instance's Worker: not asked here, because the public address gives the server's own report.
        serviceBindings: { INSTANCE: async () => new RuntimeResponse("not asked", { status: 500 }) },
        bindings: {
          ACCOUNT: FLEET_ACCOUNT,
          WORKER: "erga-next",
          DATABASE: databaseOf(made.state, "erga-next").uuid,
          CLOUDFLARE_API_TOKEN: "mock-only-erga-next",
        },
        outboundService: async (request: Request) => {
          const body = request.method == "GET" || request.method == "HEAD" ? undefined : await request.arrayBuffer();
          const answer = await out(request.url, { method: request.method, headers: [...request.headers], body });
          return new RuntimeResponse(await answer.arrayBuffer(), { status: answer.status, headers: [...answer.headers] });
        },
      })
    );
    const { mock, sql, fetch, calls } = await instanceOn((await runtime.getD1Database("DB")) as unknown as D1, made);
    out = fetch;
    await run(sql("INSERT INTO deploy_control (id, auto) VALUES (1, 1)", []));
    const worker = (await runtime.getWorker()) as unknown as { scheduled(event: { cron: string }): Promise<{ outcome: string }> };
    expect(await worker.scheduled({ cron: "* * * * *" })).toMatchObject({ outcome: "ok" });

    expect(bindingsOf(mock.state, "erga-next").ERGA_VERSION.text).toBe(short(SHA2));
    const [job] = await run(readJobs(sql));
    expect(job).toMatchObject({ kind: "deploy", source: "auto-deploy", sha: SHA2, state: { at: "done" } });
    expect(new TextDecoder().decode(await run(readLog(sql, job.id, 0)))).toContain(
      `Wait for its health: done, release ${short(SHA2)}, healthy`
    );
    expect(await run(readControl(sql))).toMatchObject({ auto: true, head: SHA2 });
    // At Cloudflare, the instance's Worker only.
    expect(calls().filter((c) => !c.includes("/workers/scripts/erga-next"))).toEqual([]);
    // The Worker answers no request: it has no fetch handler.
    const answer = await runtime.dispatchFetch("https://deployer.example.com/");
    expect(answer.status).toBe(500);
  }, 60_000);
});
