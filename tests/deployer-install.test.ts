// The deployer on Cloudflare, as setup installs it (deploy/pipeline/deployer.ts): on the mock Cloudflare, what the
// install uploads. (That the uploaded module runs, in the Workers runtime: tests/deployer-e2e.test.ts.)

import { beforeAll, describe, expect, test } from "bun:test";
import { Cloudflare } from "../deploy/deployer/cloudflare-api";
import { DEPLOYER_TAG, installDeployer, keepsToken } from "../deploy/pipeline/deployer";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { bindingsOf, bootstrap, databaseOf, prepareRelease, SHA1 } from "./helpers/deploys.ts";

beforeAll(prepareRelease, 120_000);

const short = (sha: string) => sha.slice(0, 12);
const TARGET = { account: FLEET_ACCOUNT, worker: "erga-next" };

describe("the install", () => {
  test("puts the deployer beside the instance's Worker: its database, a secret of its own, a schedule, no address, and no token", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const cf = new Cloudflare("mock-setup-token", mock.fetch);
    const from = mock.state.calls.length;
    expect(await installDeployer(cf, TARGET)).toEqual({ name: "erga-next-deployer", kept: false, replaced: false });
    const script = mock.state.scripts["erga-next-deployer"];
    const bindings = bindingsOf(mock.state, "erga-next-deployer");
    expect(Object.keys(bindings).sort()).toEqual(["ACCOUNT", "DATABASE", "DB", "INSTANCE", "KEY", "STATE", "WORKER"]);
    expect(bindings.DB).toMatchObject({ type: "d1", database_id: databaseOf(mock.state, "erga-next").uuid });
    expect(bindings.DATABASE.text).toBe(databaseOf(mock.state, "erga-next").uuid);
    // Its own store, a Durable Object of its own class; and the instance's Worker, for the health check.
    expect(bindings.STATE).toMatchObject({ type: "durable_object_namespace", class_name: "DeployerState" });
    expect(script.metadata.exports).toEqual({ DeployerState: { type: "durable-object", storage: "sqlite" } });
    expect(bindings.INSTANCE).toMatchObject({ type: "service", service: "erga-next" });
    expect(bindings.ACCOUNT.text).toBe(FLEET_ACCOUNT);
    expect(bindings.WORKER.text).toBe("erga-next");
    // Its only secret is its own, new: what seals the token that comes later. No token goes with the install.
    expect(bindings.KEY.type).toBe("secret_text");
    const key = mock.state.secrets["erga-next-deployer"].KEY;
    expect(mock.state.secrets["erga-next-deployer"]).toEqual({ KEY: expect.stringMatching(/^[0-9a-f]{64}$/) });
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

    // A second install: the deployer gets this code again, and keeps its secret (and so the token in its store).
    const uploads = () => mock.state.calls.filter((c) => c == `PUT ${acc}/workers/scripts/erga-next-deployer`).length;
    const before = uploads();
    expect(await installDeployer(cf, TARGET)).toEqual({ name: "erga-next-deployer", kept: true, replaced: false });
    expect(uploads()).toBe(before + 1);
    expect(mock.state.secrets["erga-next-deployer"]).toEqual({ KEY: key });
    expect(JSON.stringify(mock.state.scripts["erga-next-deployer"].metadata)).not.toContain(key);
    // The Worker has the same bindings as before, its secret among them.
    expect(Object.keys(bindingsOf(mock.state, "erga-next-deployer")).sort()).toEqual([
      "ACCOUNT",
      "DATABASE",
      "DB",
      "INSTANCE",
      "KEY",
      "STATE",
      "WORKER",
    ]);
  });

  test("a deployer from before it kept its own token (its token was a secret of the Worker) is replaced by a new one", async () => {
    const mock = mockCloudflare({ fleet: true });
    await bootstrap(mock);
    const cf = new Cloudflare("mock-setup-token", mock.fetch);
    const acc = `/accounts/${FLEET_ACCOUNT}`;
    const form = new FormData();
    form.set(
      "metadata",
      JSON.stringify({
        main_module: "worker.js",
        compatibility_date: "2026-09-01",
        bindings: [{ type: "secret_text", name: "CLOUDFLARE_API_TOKEN", text: "a-token-from-before" }],
        tags: [DEPLOYER_TAG],
      })
    );
    form.append("worker.js", new File(["export default {}"], "worker.js", { type: "application/javascript+module" }));
    await cf.call("PUT", `${acc}/workers/scripts/erga-next-deployer`, "upload a deployer from before", form);
    // Setup's dry run says so before: this deployer does not keep what it holds.
    expect(await keepsToken(cf, TARGET)).toBe(false);
    const from = mock.state.calls.length;
    expect(await installDeployer(cf, TARGET)).toEqual({ name: "erga-next-deployer", kept: false, replaced: true });
    expect(await keepsToken(cf, TARGET)).toBe(true);
    // The old Worker went, with its secret: the new one holds only its own.
    expect(mock.state.calls.slice(from)).toContain(`DELETE ${acc}/workers/scripts/erga-next-deployer?force=true`);
    expect(Object.keys(mock.state.secrets["erga-next-deployer"])).toEqual(["KEY"]);
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
    await expect(installDeployer(cf, TARGET)).rejects.toThrow(
      "Your account has a Worker erga-next-deployer that Erga did not make. Erga does not replace it"
    );
    expect(mock.state.calls.slice(from).filter((c) => !c.startsWith("GET "))).toEqual([]);
    expect(mock.state.scripts["erga-next-deployer"].modules).toEqual(["index.js"]);

    await expect(installDeployer(cf, { account: FLEET_ACCOUNT, worker: "no-such-worker" })).rejects.toThrow(
      "The Worker no-such-worker is not there, or it has no database. Deploy the instance first"
    );
    await expect(installDeployer(cf, { account: FLEET_ACCOUNT, worker: "w".repeat(60) })).rejects.toThrow("has more than 63 characters");
  });
});
