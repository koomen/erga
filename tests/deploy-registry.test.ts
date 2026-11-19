// A commit's release from GitHub's registry (deploy/deployer/registry.ts), against a pretend registry: the three
// calls with no login, the bundle checked against the manifest's digest and size, the release's own commit, and what
// each other answer is: no release (null), try later, or a refusal.

import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { TryLater } from "../deploy/deployer/github";
import { fetchRelease, releaseAddress, releaseState } from "../deploy/deployer/registry";
import { bundleOf, COMMIT, registry } from "./helpers/registry.ts";

const SPEC = { repo: "github.com/Example-Org/Erga", branch: "staging" };

const run = Effect.runPromise;
const refused = async (fetch: Parameters<typeof fetchRelease>[0], commit = COMMIT) => run(Effect.flip(fetchRelease(fetch, SPEC, commit)));

describe("a commit's release from GitHub's registry", () => {
  test("three calls with no login: the token, the manifest by the commit, the bundle by its digest; the release is the bundle's", async () => {
    const { fetch, calls, digest } = await registry();
    const release = await run(fetchRelease(fetch, SPEC, COMMIT));
    expect(release).toMatchObject({
      version: COMMIT.slice(0, 12),
      mainModule: "index.js",
      migrations: { "0001_erga.sql": "CREATE TABLE users (login TEXT);" },
    });
    expect(new TextDecoder().decode(release!.modules["index.js"])).toBe("export default {}");
    expect(Object.keys(release!.assets)).toEqual(["/page.js"]);
    // The package is the repository's name in lower case. Only the registry's own calls carry the token.
    expect(calls).toEqual([
      { url: "https://ghcr.io/token?service=ghcr.io&scope=repository:example-org/erga:pull", auth: null, accept: null },
      {
        url: `https://ghcr.io/v2/example-org/erga/manifests/${COMMIT}`,
        auth: "Bearer anonymous-token",
        accept: "application/vnd.oci.image.manifest.v1+json",
      },
      { url: `https://ghcr.io/v2/example-org/erga/blobs/${digest}`, auth: "Bearer anonymous-token", accept: null },
    ]);
    expect(releaseAddress(SPEC, COMMIT)).toBe(`ghcr.io/example-org/erga:${COMMIT}`);
  });

  test("the branch verify has a package of its own", async () => {
    const { fetch, calls } = await registry();
    expect(await run(fetchRelease(fetch, { ...SPEC, branch: "verify" }, COMMIT))).not.toBeNull();
    expect(calls[1].url).toBe(`https://ghcr.io/v2/example-org/erga-verify/manifests/${COMMIT}`);
    expect(releaseAddress({ ...SPEC, branch: "verify" }, COMMIT)).toBe(`ghcr.io/example-org/erga-verify:${COMMIT}`);
  });

  test("GitHub has no release of the commit, or no such package: null, and nothing more is asked", async () => {
    const other = "f".repeat(40);
    const { fetch, calls } = await registry();
    expect(await run(fetchRelease(fetch, SPEC, other))).toBeNull();
    expect(calls.length).toBe(2);
    const none = await registry({ token: new Response("{}", { status: 404 }) });
    expect(await run(fetchRelease(none.fetch, SPEC, COMMIT))).toBeNull();
    expect(none.calls.length).toBe(1);
  });

  test("a bundle that is not the one that the manifest names is never a release", async () => {
    const tampered = bundleOf();
    tampered[tampered.length - 2] ^= 1;
    expect((await refused((await registry({ served: tampered })).fetch)).message).toContain("is not the one that its manifest names");
    const short = bundleOf().slice(0, -1);
    expect((await refused((await registry({ served: short })).fetch)).message).toContain("is not the one that its manifest names");
    // A manifest that names another size than its bundle has.
    const sized = await registry({ manifest: (m) => ({ layers: [{ ...m.layers[0], size: m.layers[0].size + 1 }] }) });
    expect((await refused(sized.fetch)).message).toContain("is not the one that its manifest names");
  });

  test("the release must be the commit that was asked for, and a manifest must be one release", async () => {
    const other = await registry({ bundle: bundleOf("f".repeat(12)) });
    expect((await refused(other.fetch)).message).toBe(
      `The release at ghcr.io/example-org/erga:${COMMIT} says that it is ffffffffffff, not that commit. It is not deployed.`
    );
    const short = await registry({ bundle: bundleOf(COMMIT.slice(0, 7)) });
    expect((await refused(short.fetch)).message).toContain("says that it is 0123456");
    for (const manifest of [
      (m: { layers: object[] }) => ({ layers: [...m.layers, ...m.layers] }),
      () => ({ layers: [] }),
      (m: { layers: object[] }) => ({ layers: [{ ...m.layers[0], mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" }] }),
      (m: { layers: object[] }) => ({ layers: [{ ...m.layers[0], size: 100_000_001 }] }),
    ]) {
      const r = await registry({ manifest: manifest as never });
      expect((await refused(r.fetch)).message).toContain("is not a release: one bundle");
      // The bundle is not asked for.
      expect(r.calls.length).toBe(2);
    }
    const odd = await registry({ manifest: (m) => ({ layers: [{ ...m.layers[0], digest: "sha256:../../x" }] }) });
    expect((await refused(odd.fetch)).message).toContain("is not a release: one bundle");
    expect(odd.calls.length).toBe(2);
    const junk = await registry({ bundle: new TextEncoder().encode("not a bundle") });
    expect((await refused(junk.fetch)).message).toContain("isn't readable");
  });

  test("releaseState: released, none or refused, from the manifest alone: no bundle is asked for", async () => {
    const state = (fetch: Parameters<typeof releaseState>[0], commit = COMMIT) => run(releaseState(fetch, SPEC, commit));
    const there = await registry();
    expect(await state(there.fetch)).toBe("released");
    expect(await state(there.fetch, "f".repeat(40))).toBe("none");
    expect(there.calls.filter((c) => c.url.includes("/blobs/"))).toEqual([]);
    expect(await state((await registry({ token: new Response("{}", { status: 404 }) })).fetch)).toBe("none");
    for (const manifest of [
      (m: { layers: object[] }) => ({ layers: [...m.layers, ...m.layers] }),
      (m: { layers: object[] }) => ({ layers: [{ ...m.layers[0], mediaType: "text/plain" }] }),
      (m: { layers: object[] }) => ({ layers: [{ ...m.layers[0], digest: "sha256:x" }] }),
      () => ({ schemaVersion: 2 }),
    ])
      expect(await state((await registry({ manifest: manifest as never })).fetch)).toBe("refused");
    // No answer is no state: the look asks again.
    expect(await run(Effect.flip(releaseState((await registry({ fail: true })).fetch, SPEC, COMMIT)))).toBeInstanceOf(TryLater);
    expect((await run(Effect.flip(releaseState(there.fetch, SPEC, "staging")))).message).toContain("is not a commit's full name");
  });

  test("a name that is not a commit's full name asks nothing", async () => {
    const { fetch, calls } = await registry();
    for (const name of ["staging", COMMIT.slice(0, 12), `${COMMIT}/../x`, COMMIT.toUpperCase()])
      expect((await refused(fetch, name)).message).toContain("is not a commit's full name");
    expect(calls).toEqual([]);
  });

  test("no answer, a limit or a fault of the registry is TryLater; a package that is not public is a refusal", async () => {
    for (const over of [
      { fail: true },
      { token: new Response("", { status: 503 }) },
      { tagged: new Response("", { status: 429 }) },
      { blob: new Response("", { status: 502 }) },
    ]) {
      const e = await refused((await registry(over)).fetch);
      expect(e).toBeInstanceOf(TryLater);
      expect(e.message).toContain("GitHub's registry did not give the release");
    }
    for (const status of [401, 403]) {
      const e = await refused((await registry({ tagged: new Response("{}", { status }) })).fetch);
      expect(e).not.toBeInstanceOf(TryLater);
      expect(e.message).toContain("the package ghcr.io/example-org/erga must be public");
    }
    expect((await refused((await registry({ blob: new Response("", { status: 404 }) })).fetch)).message).toContain("but not its bundle");
    expect((await refused((await registry({ tagged: new Response("", { status: 418 }) })).fetch)).message).toContain("answered 418");
  });
});
