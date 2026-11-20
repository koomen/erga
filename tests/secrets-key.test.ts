// The key that encrypts the secrets that the server stores has the name SECRETS_KEY; it was FACTORY_KEY
// (deploy/deployer/secrets-key.ts). An instance from before keeps its key's value under the new name: Cloudflare
// renames the secret with the Worker's upload (the mock Cloudflare), the deploy copies the parameter on AWS (a
// pretend AWS CLI), and setup makes no other key. No call, log line or file of the client has the value. And the
// pages: the Sign-in page lists the key, the Agents and models page does not.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Aws } from "../deploy/aws/cli";
import { moveSecretsKey } from "../deploy/aws/deploy";
import { DEFAULT_REPO, writeConfig } from "../deploy/cli/config";
import { deployInstance } from "../deploy/cli/deploy";
import { specOn, sqlOf } from "../deploy/cli/instance";
import { Cloudflare } from "../deploy/deployer/cloudflare-api";
import type { Release } from "../deploy/deployer/release-format";
import { secretsFor } from "../deploy/own/first";
import type { Answers } from "../deploy/own/plan";
import { runPipeline, targetFacts } from "../deploy/pipeline/pipeline";
import { FLEET_ACCOUNT, mockCloudflare } from "../dev/mock-cloudflare";
import { server } from "./helpers/app";
import { deployTo, fleet, prepareRelease, quick, release, ROOT } from "./helpers/deploys.ts";
import { writePass } from "./helpers/pass.ts";
import { quietConsole } from "./helpers/quiet.ts";

quietConsole();

beforeAll(prepareRelease, 120_000);

type Mock = ReturnType<typeof mockCloudflare>;
const KEY = "fleet-secrets-key";
const OTHERS = { SESSION_SECRET: "fleet-session-secret", GITHUB_CLIENT_SECRET: "fleet-github-secret" };
/** The fleet's Worker with these secrets; `listed`: whether its settings list them (just after an upload, they do not). */
function holding(secrets: Record<string, string>, listed = true): Mock {
  const mock = mockCloudflare({ fleet: true });
  mock.state.secrets.erga = { ...OTHERS, ...secrets };
  const meta = mock.state.scripts.erga.metadata;
  meta.bindings = [
    ...meta.bindings.filter((b: { type: string }) => b.type != "secret_text"),
    ...(listed ? Object.keys(mock.state.secrets.erga).map((name) => ({ type: "secret_text", name, text: "(hidden)" })) : []),
  ];
  return mock;
}
/** The uploads of the fleet's Worker, as Cloudflare got them. */
const uploads = (mock: Mock) => mock.state.calls.filter((c) => /^PUT .*\/workers\/scripts\/erga(\?|$)/.test(c));
const PUT = `PUT /accounts/${FLEET_ACCOUNT}/workers/scripts/erga`;
/** A release from before the key had its new name: its build declares no SECRETS_KEY. */
const before = (): Release => {
  const { SECRETS_KEY: _, ...env } = release.worker.env;
  return { ...release, worker: { ...release.worker, env } };
};

describe("on Cloudflare, the Worker's upload gives the key its new name", () => {
  test("an instance from before: Cloudflare renames the secret with one upload, the value stays, and no request carries it", async () => {
    const mock = holding({ FACTORY_KEY: KEY });
    const sent: string[] = [];
    const net: typeof mock.fetch = async (input, init) => {
      const body = init?.body;
      if (body instanceof FormData) sent.push(String(body.get("metadata")));
      else if (typeof body == "string") sent.push(body);
      return mock.fetch(input, init);
    };
    const steps: string[] = [];
    await runPipeline(new Cloudflare("mock-deploy-token", net), release, fleet(), {
      ...quick,
      report: (id, status, detail) => steps.push(`${id}:${status}${detail ? ` ${detail}` : ""}`),
    });
    expect(mock.state.secrets.erga).toEqual({ ...OTHERS, SECRETS_KEY: KEY });
    expect(uploads(mock)).toEqual([`${PUT}?bindings_inherit=strict`]);
    expect(steps.join("\n")).toContain("its key FACTORY_KEY has the name SECRETS_KEY now");
    const metadata = sent.find((s) => s.includes("main_module"))!;
    expect(JSON.parse(metadata).bindings).toContainEqual({ type: "inherit", name: "SECRETS_KEY", old_name: "FACTORY_KEY" });
    expect([sent.join("\n"), steps.join("\n")].some((text) => text.includes(KEY))).toBe(false);

    // The deploy after: the upload as it always was, and the key stays.
    const next = await deployTo(fleet(), mock);
    expect(uploads(mock).slice(1)).toEqual([PUT]);
    expect(next.steps.join("\n")).not.toContain("FACTORY_KEY");
    expect(mock.state.secrets.erga).toEqual({ ...OTHERS, SECRETS_KEY: KEY });
  }, 60_000);

  test("Cloudflare says whether there is a key to rename, not the settings' list", async () => {
    // An instance from before, just after an upload: its settings list no secret. The key is renamed all the same.
    const old = holding({ FACTORY_KEY: KEY }, false);
    await deployTo(fleet(), old);
    expect([uploads(old), old.state.secrets.erga]).toEqual([[`${PUT}?bindings_inherit=strict`], { ...OTHERS, SECRETS_KEY: KEY }]);
    // An instance that has the new name, with no list: Cloudflare refuses the rename (10057), and the plain upload keeps the key.
    const moved = holding({ SECRETS_KEY: KEY }, false);
    await deployTo(fleet(), moved);
    expect([uploads(moved), moved.state.secrets.erga]).toEqual([[`${PUT}?bindings_inherit=strict`, PUT], { ...OTHERS, SECRETS_KEY: KEY }]);
    // A Worker with no key: the same two uploads, and it gets none.
    const none = holding({});
    await deployTo(fleet(), none);
    expect([uploads(none), none.state.secrets.erga]).toEqual([[`${PUT}?bindings_inherit=strict`, PUT], OTHERS]);
  }, 60_000);

  test("a release from before reads the old name: its deploy renames nothing; and another refusal is the deploy's, with no second upload", async () => {
    const mock = holding({ FACTORY_KEY: KEY });
    await deployTo(fleet(), mock, before());
    expect([uploads(mock), mock.state.secrets.erga]).toEqual([[PUT], { ...OTHERS, FACTORY_KEY: KEY }]);

    const refused = holding({ FACTORY_KEY: KEY });
    const run = runPipeline(new Cloudflare("mock-once-worker", refused.fetch), release, fleet(), { ...quick, report: () => {} });
    await expect(run).rejects.toThrow("The mock refuses this step once");
    expect([uploads(refused), refused.state.secrets.erga]).toEqual([[`${PUT}?bindings_inherit=strict`], { ...OTHERS, FACTORY_KEY: KEY }]);
  }, 60_000);
});

test("bun erga deploy of an instance from before: the key has its new name, and the instance's spec names it so", async () => {
  const mock = holding({ FACTORY_KEY: KEY });
  // (The fleet's bucket: a deploy of the code makes none.)
  mock.state.buckets!.push("erga-files");
  const dir = join(mkdtempSync(join(tmpdir(), "erga-secrets-key-")), ".erga");
  const entry = { host: "example.com", repo: DEFAULT_REPO, branch: "main", ...targetFacts(fleet()) };
  writeConfig(dir, { instances: [entry] });
  writePass(dir, Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim());
  const lines: string[] = [];
  process.env.ERGA_DEPLOY_MOCK = "1";
  try {
    await deployInstance({ dir, host: "example.com", commit: "HEAD", net: mock.fetch, print: (l) => lines.push(l) });
  } finally {
    delete process.env.ERGA_DEPLOY_MOCK;
  }
  expect(mock.state.secrets.erga).toEqual({ ...OTHERS, SECRETS_KEY: KEY });
  const spec = await specOn(await sqlOf(entry, { cf: new Cloudflare("mock-machine-token", mock.fetch) }));
  expect(spec!.secrets).toEqual(["GITHUB_CLIENT_SECRET", "SECRETS_KEY", "SESSION_SECRET"]);
  expect(lines.join("\n")).toContain("its key FACTORY_KEY has the name SECRETS_KEY now");
  expect(lines.join("\n")).not.toContain(KEY);
}, 60_000);

describe("setup keeps the key of an instance from before", () => {
  const HOST = "erga.example.com";
  const answers = { host: HOST } as Answers;
  const dirWith = (own: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "erga-secrets-key-"));
    writeFileSync(join(dir, "secrets.json"), JSON.stringify({ [HOST]: own }));
    return dir;
  };
  const file = (dir: string) => JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8"))[HOST];

  test("a server that holds the old name holds the key: setup makes and sends no other; the file's copy takes the new name", () => {
    const kept = dirWith({ SESSION_SECRET: "s", FACTORY_KEY: "k" });
    expect(secretsFor(kept, answers, ["SESSION_SECRET", "FACTORY_KEY"])).toEqual({});
    expect(file(kept)).toEqual({ SESSION_SECRET: "s", SECRETS_KEY: "k" });
    // No copy in the file: none is made, for the server has the key.
    const none = dirWith({});
    expect(secretsFor(none, answers, ["SESSION_SECRET", "FACTORY_KEY"])).toEqual({});
    expect(file(none)).toEqual({});
    // The file's copy goes to a server that holds neither name, under the new name.
    expect(secretsFor(dirWith({ SESSION_SECRET: "s", FACTORY_KEY: "k" }), answers, [])).toEqual({ SESSION_SECRET: "s", SECRETS_KEY: "k" });
  });

  test("a new server gets a SECRETS_KEY of its own, one time", () => {
    const dir = dirWith({});
    const first = secretsFor(dir, answers, []);
    expect(Object.keys(first).sort()).toEqual(["SECRETS_KEY", "SESSION_SECRET"]);
    expect(first.SECRETS_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(secretsFor(dir, answers, [])).toEqual(first);
  });
});

describe("on AWS, the deploy copies the key's parameter, and the deploy after deletes the old one", () => {
  const AT = "/erga/erga-example/";
  /** A pretend AWS CLI on a stack's parameters: the calls it got, never a value in them but the copy's own. */
  function parameters(has: Record<string, string>) {
    const params = new Map(Object.entries(has).map(([name, value]) => [`${AT}${name}`, value]));
    const calls: string[] = [];
    const aws = (async (...args: string[]) => {
      const opt = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)!;
      calls.push(`${args[1]} ${opt("--name") ?? opt("--path")}`);
      if (args[1] == "get-parameters-by-path") return { Parameters: [...params.keys()].map((Name) => ({ Name })) };
      if (args[1] == "get-parameter") return { Parameter: { Value: params.get(opt("--name")) } };
      if (args[1] == "put-parameter") {
        if (params.has(opt("--name"))) throw new Error("ParameterAlreadyExists");
        expect([opt("--type"), opt("--key-id")]).toEqual(["SecureString", "alias/erga-erga-example"]);
        return void params.set(opt("--name"), opt("--value"));
      }
      if (args[1] == "delete-parameter") return void params.delete(opt("--name"));
      throw new Error(`the pretend AWS CLI has no ${args.join(" ")}`);
    }) as Aws;
    return { aws, calls, has: () => Object.fromEntries([...params].map(([name, value]) => [name.slice(AT.length), value])) };
  }

  test("the old name only: a copy under the new name, with its value in no line; then the old one goes when the next release answers", async () => {
    const p = parameters({ SESSION_SECRET: "s", FACTORY_KEY: "the-key" });
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    await (await moveSecretsKey(p.aws, "erga-example", release, log))();
    expect(p.has()).toEqual({ SESSION_SECRET: "s", FACTORY_KEY: "the-key", SECRETS_KEY: "the-key" });
    expect(p.calls).toEqual([`get-parameters-by-path ${AT}`, `get-parameter ${AT}FACTORY_KEY`, `put-parameter ${AT}SECRETS_KEY`]);
    expect(lines).toEqual([
      `Parameter Store: the key FACTORY_KEY has a copy with its new name, ${AT}SECRETS_KEY. The next deploy deletes ${AT}FACTORY_KEY.`,
    ]);
    // The deploy after: nothing before its release answers, then the old parameter goes.
    const after = await moveSecretsKey(p.aws, "erga-example", release, log);
    expect(p.has()).toHaveProperty("FACTORY_KEY");
    await after();
    expect(p.has()).toEqual({ SESSION_SECRET: "s", SECRETS_KEY: "the-key" });
    expect(lines.join("\n")).not.toContain("the-key");
  });

  test("a release from before, or a stack with no old name: nothing moves", async () => {
    const old = parameters({ FACTORY_KEY: "the-key" });
    await (await moveSecretsKey(old.aws, "erga-example", before(), () => {}))();
    expect([old.calls, old.has()]).toEqual([[], { FACTORY_KEY: "the-key" }]);
    const moved = parameters({ SECRETS_KEY: "the-key" });
    await (await moveSecretsKey(moved.aws, "erga-example", release, () => {}))();
    expect([moved.calls, moved.has()]).toEqual([[`get-parameters-by-path ${AT}`], { SECRETS_KEY: "the-key" }]);
  });
});

test("the Sign-in page lists SECRETS_KEY; the Agents and models page lists no secret of the deploy", async () => {
  const s = server();
  const signIn = await (await s.fetch("/admin/auth")).text();
  expect(signIn).toContain(
    `data-env="SECRETS_KEY"><div class="about"><code class="key">SECRETS_KEY</code><p class="desc">Encrypts the secrets that this server stores.</p></div>`
  );
  expect(signIn).not.toContain("FACTORY_KEY");
  const agents = await (await s.fetch("/admin/agents")).text();
  expect(agents).toContain("Agents and models");
  expect(agents).not.toContain("deploy-secret");
});
