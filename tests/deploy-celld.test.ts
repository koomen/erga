// A release as the machine on AWS loads it (deploy/deployer/celld.ts): the celld project of the release that this
// checkout builds, and its pack, which the system's own tar reads. No AWS, no Bun.build at the deploy: the release
// carries the Worker as one module (deploy/release.ts).

import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { gateHash } from "../deploy/aws/gate";
import { AwsFacts } from "../deploy/cli/config";
import { awsVars } from "../deploy/deployer/aws";
import { celldProject, celldTgz, tar } from "../deploy/deployer/celld";
import type { AwsTarget } from "../deploy/deployer/spec";
import { prepareRelease, release, ROOT } from "./helpers/deploys.ts";

beforeAll(prepareRelease, 120_000);

const target: AwsTarget = {
  kind: "aws",
  account: "123456789012",
  region: "us-east-1",
  stack: "erga-example",
  bucket: "erga-example-bucket",
  machine: "i-0123456789abcdef0",
  gate: "arn:aws:secretsmanager:us-east-1:123456789012:secret:GateKey-AbCdEf",
  app: "erga.example.com",
  pages: { kind: "shared", host: "d111111abcdef8.cloudfront.net" },
};

/** Every file under `dir`, by its path. */
const filesIn = (dir: string): Record<string, Uint8Array> =>
  Object.fromEntries(
    (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
      .filter((e) => e.isFile())
      .map((e) => [join(e.parentPath, e.name).slice(dir.length + 1), new Uint8Array(readFileSync(join(e.parentPath, e.name)))])
  );

test("the release carries the Worker as one module, and its gate's hash: the same on every machine", () => {
  expect(release.celld?.length).toBeGreaterThan(100_000);
  // One module: it imports only what celld gives (cloudflare:, node:), and no other file of the build.
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(new TextDecoder().decode(release.celld)).map((i) => i.path);
  expect(imports.filter((i) => !/^(cloudflare|node):/.test(i))).toEqual([]);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports).not.toContain("node:os");
  expect(release.gate).toBe(gateHash());
  expect(release.gate).toMatch(/^[0-9a-f]{64}$/);
  // The hash is of the source: another file, or another text in one, is another gate.
  const dir = mkdtempSync(join(tmpdir(), "erga-gate-"));
  try {
    writeFileSync(join(dir, "core.ts"), "export const a = 1;\n");
    const one = gateHash(dir);
    expect(gateHash(dir)).toBe(one);
    writeFileSync(join(dir, "core.ts"), "export const a = 2;\n");
    const two = gateHash(dir);
    writeFileSync(join(dir, "more.ts"), "");
    expect(new Set([one, two, gateHash(dir)]).size).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the celld project: the one module, the files, the migrations, and the deploy's settings over the release's own", () => {
  const vars = awsVars(target, { GITHUB_CLIENT_ID: "Ov23aws" }, release.version);
  const files = Effect.runSync(celldProject(release, vars));
  expect(files["index.js"]).toBe(release.celld!);
  for (const [path, bytes] of Object.entries(release.assets)) expect(files[`assets${path}`]).toBe(bytes);
  expect(Object.keys(files).filter((p) => p.startsWith("migrations/"))).toEqual(
    Object.keys(release.migrations).map((n) => `migrations/${n}`)
  );
  const config = JSON.parse(new TextDecoder().decode(files["wrangler.json"]));
  expect(config).toMatchObject({ main: "index.js", no_bundle: true, triggers: { crons: ["* * * * *"] } });
  expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "erga", database_id: "erga", migrations_dir: "migrations" }]);
  expect(config.vars).toMatchObject({
    GITHUB_CLIENT_ID: "Ov23aws",
    ERGA_VERSION: release.version,
    PAGES_HOST: "d111111abcdef8.cloudfront.net",
    ERGA_CHROME: "http://127.0.0.1:9222",
  });
  // The deploy facts are an entry's facts (bun erga register reads them back): the target's names, never its kind.
  const facts = Schema.decodeUnknownSync(AwsFacts, { onExcessProperty: "error" })(JSON.parse(config.vars.ERGA_DEPLOY));
  expect(facts).toEqual({ aws: { ...target, kind: undefined } as never, vars: { GITHUB_CLIENT_ID: "Ov23aws" } });
  // No secret's name or value is in the project: the machine adds the secrets at its deploy.
  expect(Object.keys(config.vars).filter((k) => /SECRET|KEY/.test(k))).toEqual([]);
});

test("a release from before it carried the one module is refused: no deploy bundles", () => {
  const { celld: _, ...old } = release;
  const failed = Effect.runSync(Effect.flip(celldProject(old, {})));
  expect(failed.message).toContain(`Release ${release.version} does not carry the Worker as one module`);
});

test("the pack is a .tgz that tar reads: each file whole, a long path too, under ./ as the machine's scripts ask", async () => {
  const long = `assets/${"folder-with-a-long-name/".repeat(6)}a-file-with-a-long-name-0123456789.js`;
  expect(long.length).toBeGreaterThan(100);
  const files: Record<string, Uint8Array> = {
    "wrangler.json": new TextEncoder().encode('{"vars":{}}'),
    "index.js": crypto.getRandomValues(new Uint8Array(70_000)),
    "assets/empty.txt": new Uint8Array(),
    "assets/one-block.bin": new Uint8Array(512).fill(7),
    [long]: new TextEncoder().encode("long"),
  };
  const dir = mkdtempSync(join(tmpdir(), "erga-tgz-"));
  try {
    // (A time in the past: GNU tar warns of a file from the future.)
    const bytes = tar(files, 1_700_000_000);
    expect(bytes.length % 512).toBe(0);
    writeFileSync(join(dir, "plain.tar"), bytes);
    const names = Bun.spawnSync(["tar", "-tf", join(dir, "plain.tar")]);
    expect(names.stdout.toString().trim().split("\n")).toEqual(Object.keys(files).map((p) => `./${p}`));
    // The release, packed: what comes out is the project.
    const project = Effect.runSync(celldProject(release, { ERGA_VERSION: release.version }));
    writeFileSync(join(dir, "release.tgz"), await Effect.runPromise(celldTgz(release, { ERGA_VERSION: release.version })));
    const out = join(dir, "out");
    for (const [archive, to] of [
      ["plain.tar", join(dir, "plain")],
      ["release.tgz", out],
    ]) {
      const r = Bun.spawnSync(["sh", "-c", `mkdir "${to}" && tar -xf "${join(dir, archive)}" -C "${to}"`]);
      expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
    }
    expect(filesIn(join(dir, "plain"))).toEqual(files);
    expect(filesIn(out)).toEqual(project);
    // As the machine reads one file of it (deploy/aws/machine.ts, factsScript).
    const one = Bun.spawnSync(["tar", "-xzOf", join(dir, "release.tgz"), "./wrangler.json"]);
    expect(JSON.parse(one.stdout.toString()).vars.ERGA_VERSION).toBe(release.version);
    expect(existsSync(join(ROOT, "deploy/aws/project.ts"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A path that no header holds is refused.
  expect(() => tar({ [`${"x".repeat(120)}/${"y".repeat(120)}`]: new Uint8Array() }, 0)).toThrow("too long to pack");
});
