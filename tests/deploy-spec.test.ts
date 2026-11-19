// An instance's spec (deploy/deployer/spec.ts): the shapes of today's entries in .erga/config.json read as specs, and
// what the schema refuses: an unknown key, a secret's value, and each name that could change an API path, the script on
// AWS's machine or the release's address.

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { decodeSpec } from "../deploy/deployer/spec";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SECRETS = ["SESSION_SECRET", "FACTORY_KEY", "GITHUB_CLIENT_SECRET"];

/** Today's entries, as specs: an entry's facts are the target, its vars are the settings. */
const production = {
  repo: "github.com/example/erga",
  branch: "main",
  target: {
    kind: "cloudflare",
    account: ACCOUNT,
    worker: "erga",
    database: "erga",
    app: { kind: "domain", zoneName: "example.com", hostname: "example.com" },
    pages: { kind: "zone", zoneName: "example-pages.com", domain: "example-pages.com" },
  },
  settings: { GITHUB_CLIENT_ID: "Ov23liExample00000001" },
  secrets: SECRETS,
};
const shared = {
  repo: "github.com/Example-Org/erga.fork",
  branch: "release/2026-11",
  target: {
    kind: "cloudflare",
    account: ACCOUNT,
    worker: "erga-example-org",
    database: "erga_example_org",
    subdomain: "example-org",
    app: { kind: "domain", zoneName: "example.org", hostname: "erga.example.org" },
    pages: { kind: "shared" },
    domains: ["docs.example.org"],
  },
  settings: { GITHUB_CLIENT_ID: "", SERVER_CONFIG: '{"public_sharing":false}', SERVER_DEFAULTS: "{}" },
  secrets: SECRETS,
};
const workersDev = {
  ...shared,
  target: {
    kind: "cloudflare",
    account: ACCOUNT,
    worker: "erga",
    database: "erga",
    subdomain: "example",
    app: { kind: "workers.dev" },
    pages: { kind: "shared" },
  },
};
const aws = {
  repo: "github.com/example/erga",
  branch: "staging",
  target: {
    kind: "aws",
    account: "123456789012",
    region: "us-west-2",
    stack: "erga-example-com",
    bucket: "erga-example-com-bucket-1a2b3c4d5e6f",
    machine: "i-0123456789abcdef0",
    app: "erga.example.com",
    pages: { kind: "domain", domain: "pages.example.com" },
  },
  settings: { PROXY_SIGN_IN: '{"team":"example"}', SERVER_DEFAULTS: "{}" },
  secrets: ["SESSION_SECRET", "FACTORY_KEY"],
};
const awsShared = {
  ...aws,
  target: { ...aws.target, app: "d111111abcdef8.cloudfront.net", pages: { kind: "shared", host: "d222222abcdef8.cloudfront.net" } },
};

const decode = (value: unknown) => Effect.runSync(decodeSpec(value));
/** Why the schema refuses `value`. A value that it reads fails the test. */
const refused = (value: unknown) => Effect.runSync(Effect.flip(decodeSpec(value))).message;
const onCloudflare = (over: object) => ({ ...production, target: { ...production.target, ...over } });
const onAws = (over: object) => ({ ...aws, target: { ...aws.target, ...over } });

describe("an instance's spec", () => {
  test("each shape of today's entries is a spec, also after a trip through JSON", () => {
    for (const spec of [production, shared, workersDev, aws, awsShared]) {
      expect(decode(spec)).toEqual(spec as never);
      expect(decode(JSON.parse(JSON.stringify(spec)))).toEqual(spec as never);
    }
  });

  test("an unknown key is an error, never left out silently", () => {
    expect(refused({ ...production, host: "example.com" })).toContain('["host"]');
    expect(refused({ ...production, upstream: { repo: "github.com/example/erga", branch: "main" } })).toContain('["upstream"]');
    expect(refused(onCloudflare({ vars: {} }))).toContain('["target"]["vars"]');
    expect(refused(onCloudflare({ app: { ...production.target.app, zoneId: "0".repeat(32) } }))).toContain('["zoneId"]');
    expect(refused(onAws({ profile: "example" }))).toContain('["target"]["profile"]');
  });

  test("the secrets are names only: a value has no place", () => {
    expect(refused({ ...production, secrets: { SESSION_SECRET: "0".repeat(64) } })).toContain('["secrets"]');
    expect(refused({ ...production, secrets: ["SESSION_SECRET=abc"] })).toContain('["secrets"][0]');
    expect(refused({ ...production, secrets: ["SESSION_SECRET", "SESSION_SECRET"] })).toContain("unique");
    expect(refused({ ...production, secrets: ["GITHUB_CLIENT_ID"] })).toContain("a setting or a secret, not both: GITHUB_CLIENT_ID");
  });

  test("the settings: names as the server reads them, text values, never one of the deploy's own names", () => {
    for (const name of ["lower", "ERGA_VERSION", "ERGA_DEPLOY", "ERGA_GITHUB_ORIGIN", "PAGES_HOST", "PAGES_DOMAIN", "__proto__", "A B", ""])
      expect(refused({ ...production, settings: JSON.parse(`{${JSON.stringify(name)}:"x"}`) })).toContain(
        `["settings"][${JSON.stringify(name)}]`
      );
    expect(refused({ ...production, settings: { SERVER_DEFAULTS: {} } })).toContain('["settings"]["SERVER_DEFAULTS"]');
    expect(refused({ ...production, secrets: ["ERGA_LINK_SECRET"] })).toContain('["secrets"][0]');
  });

  test("the repository is one on GitHub, and the branch is a plain name", () => {
    for (const repo of [
      "https://github.com/example/erga",
      "git@github.com:example/erga",
      "gitlab.com/example/erga",
      "github.com/example",
      "github.com/example/erga/extra",
      "github.com/example/..",
      "github.com/../erga",
      "github.com/example/erga?ref=x",
      "github.com/example/er ga",
      "/home/example/erga",
    ])
      expect(refused({ ...production, repo })).toContain('["repo"]');
    for (const branch of ["", "-main", "--upload-pack=x", "a..b", "main branch", "main;id", "refs/heads/$(id)", "x".repeat(201)])
      expect(refused({ ...production, branch })).toContain('["branch"]');
  });

  test("a target's names fit their place: an API path on Cloudflare, a script on AWS", () => {
    const cloudflare: [string, object][] = [
      ["account", { account: "acc" }],
      ["account", { account: `${ACCOUNT}/workers` }],
      ["worker", { worker: "erga/settings" }],
      ["worker", { worker: "Erga" }],
      ["worker", { worker: "x".repeat(64) }],
      ["database", { database: "erga?per_page=1" }],
      ["subdomain", { subdomain: "example.workers.dev" }],
      ["hostname", { app: { kind: "domain", zoneName: "example.com", hostname: "example.com/path" } }],
      ["hostname", { app: { kind: "domain", zoneName: "example.com", hostname: "Example.com" } }],
      ["zoneName", { app: { kind: "domain", zoneName: "localhost", hostname: "example.com" } }],
      ["domain", { pages: { kind: "zone", zoneName: "example.com", domain: "*.example.com" } }],
      ["domains", { domains: ["docs.example.com", "docs.example.com"] }],
      ["domains", { domains: ["https://docs.example.com"] }],
      ["app", { app: { kind: "route" } }],
    ];
    for (const [key, over] of cloudflare) expect(refused(onCloudflare(over))).toContain(`["${key}"]`);
    const onAmazon: [string, object][] = [
      ["account", { account: ACCOUNT }],
      ["region", { region: "us-west-2; id" }],
      ["region", { region: "US-WEST-2" }],
      ["stack", { stack: "erga $(id)" }],
      ["stack", { stack: "-erga" }],
      ["bucket", { bucket: "erga/../other" }],
      ["bucket", { bucket: "erga' x" }],
      ["machine", { machine: "erga-machine" }],
      ["machine", { machine: "i-0123456789abcdef0 i-0" }],
      ["app", { app: "erga.example.com:8080" }],
      ["host", { pages: { kind: "shared", host: "localhost" } }],
      ["domain", { pages: { kind: "domain" } }],
    ];
    for (const [key, over] of onAmazon) expect(refused(onAws(over))).toContain(`["${key}"]`);
    // With a gate in front: the secret that holds the gate's key, by its ARN.
    const gate = "arn:aws:secretsmanager:us-west-2:123456789012:secret:erga-example-com-GateKey-AbCdEf";
    expect(decode(onAws({ gate }))).toMatchObject({ target: { gate } });
    for (const bad of ["GateKey", `${gate} x`, `${gate}'; id`, gate.replace("secretsmanager", "ssm")])
      expect(refused(onAws({ gate: bad }))).toContain('["gate"]');
    expect(refused({ ...production, target: { ...production.target, kind: "local" } })).toContain('["target"]');
  });

  test("a workers.dev app and shared pages need the account's subdomain", () => {
    const { subdomain: _, ...none } = shared.target;
    expect(refused({ ...shared, target: none })).toContain("need the subdomain");
    expect(refused({ ...workersDev, target: { ...none, app: { kind: "workers.dev" } } })).toContain("need the subdomain");
  });

  test("the error names each wrong part, and repeats no value", () => {
    const value = "a-value-that-is-in-no-log";
    const why = refused({ ...aws, repo: "example/erga", branch: "a..b", secrets: [value] });
    for (const part of ['["repo"]', '["branch"]', '["secrets"][0]']) expect(why).toContain(part);
    expect(why).not.toContain(value);
    expect(refused({ ...aws, secrets: { SESSION_SECRET: value } })).not.toContain(value);
    // A text over its length stops there: the pattern never runs on it.
    const long = refused(onAws({ app: `${"a-".repeat(50_000)}.example.com` }));
    expect(long).toContain("length");
    expect(long).not.toContain("RegExp");
    expect(() => decode(null)).toThrow();
    expect(() => decode("{}")).toThrow();
  });
});
