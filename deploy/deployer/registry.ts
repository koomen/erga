// A commit's release, as GitHub built it one time (.github/workflows/release.yml) and keeps it in its registry:
//
//   ghcr.io/<owner>/<repository>:<the commit's full SHA>            each commit of main
//   ghcr.io/<owner>/<repository>-verify:<the commit's full SHA>     each commit of verify
//
// An OCI image manifest with one layer, the release's bundle (release-format.ts, unpackRelease). The package is
// public: the registry gives a token to read it with no login. Three calls: the token, the manifest by its tag, the
// layer by its digest. The layer's bytes are checked against that digest (SHA-256) and against the size that the
// manifest names, and the release must say that it is the commit that was asked for.
//
// releaseState says the same of a commit from its manifest alone, with no bundle: the deployer's look asks it for each
// new commit of the branch.
//
// Trap: only "GitHub has no release of this commit" is null (the commit's build is not done, or failed): its caller
// may then build. No answer is TryLater, and every other answer is a refusal: a caller never builds, or deploys,
// around a release that GitHub has but that this code could not check.

import * as Effect from "effect/Effect";
import { Hex } from "effect/encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DeployError, type Fetch } from "./cloudflare-api";
import { TryLater } from "./github";
import { type Release, unpackRelease } from "./release-format";
import type { Spec } from "./spec";

const REGISTRY = "https://ghcr.io";
/** The bundle's media type (the workflow's RELEASE_TYPE). */
const RELEASE_TYPE = "application/vnd.erga.release.v1+json";
/** The most bytes that a release's bundle may have. (A bundle of 2026-11 has 8 MB.) */
const MAX_BYTES = 100_000_000;

const Token = Schema.Struct({ token: Schema.String });
const Manifest = Schema.Struct({
  layers: Schema.Array(
    Schema.Struct({
      mediaType: Schema.String,
      digest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
      size: Schema.Number,
    })
  ),
});

/** The package that holds the releases of the spec's branch: the repository's name in lower case; verify's commits have a package of their own. */
const packageOf = (spec: Pick<Spec, "repo" | "branch">) =>
  `${spec.repo.slice("github.com/".length).toLowerCase()}${spec.branch == "verify" ? "-verify" : ""}`;

/** Where the release of `commit` is, for the log. */
export const releaseAddress = (spec: Pick<Spec, "repo" | "branch">, commit: string) => `ghcr.io/${packageOf(spec)}:${commit}`;

/** What GitHub's registry has for a commit: a release, none (its build is not done, or failed), or something that is no release. */
export type ReleaseState = "released" | "none" | "refused";

/** The registry's calls for one release, and what its manifest says: with a release, the one layer that is its bundle. */
const manifestOf = (fetch: Fetch, spec: Pick<Spec, "repo" | "branch">, commit: string) =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{40}$/.test(commit))
      return yield* new DeployError({ message: `"${commit}" is not a commit's full name (40 hex characters).` });
    const name = packageOf(spec);
    const at = releaseAddress(spec, commit);
    const later = (why: string) =>
      new TryLater({ message: `GitHub's registry did not give the release ${at}: ${why}. Try again in a moment.` });
    /** One GET of the registry: its answer when it is 200 or 404; no answer, a limit or a fault of its own is TryLater. */
    const get = (path: string, headers: Record<string, string>) =>
      Effect.gen(function* () {
        const r = yield* Effect.tryPromise({
          try: () => fetch(`${REGISTRY}${path}`, { headers: { "User-Agent": "erga-deployer", ...headers } }),
          catch: (e) => later(e instanceof Error ? e.message : String(e)),
        });
        if (r.status == 429 || r.status >= 500) return yield* later(`it answered ${r.status}`);
        if (r.status == 401 || r.status == 403)
          return yield* new DeployError({
            message: `GitHub's registry refused to give ${at} with no login (it answered ${r.status}): the package ghcr.io/${name} must be public.`,
            status: r.status,
          });
        if (r.status != 200 && r.status != 404)
          return yield* new DeployError({ message: `GitHub's registry answered ${r.status} for ${at}.`, status: r.status });
        return r;
      });
    const json = (r: Response, what: string) => Effect.tryPromise({ try: () => r.json(), catch: () => later(`its ${what} stopped`) });
    const none = { state: "none" as const, at };

    const asked = yield* get(`/token?service=ghcr.io&scope=repository:${name}:pull`, {});
    // No such package: no release of any commit.
    if (asked.status == 404) return none;
    const { token } = yield* Effect.flatMap(json(asked, "token"), (value) =>
      Effect.mapError(
        Schema.decodeUnknownEffect(Token)(value),
        (e) => new DeployError({ message: `GitHub's registry gave a token for ${at} that Erga doesn't understand: ${e.message}` })
      )
    );
    const auth = { Authorization: `Bearer ${token}` };
    const tagged = yield* get(`/v2/${name}/manifests/${commit}`, { ...auth, Accept: "application/vnd.oci.image.manifest.v1+json" });
    if (tagged.status == 404) return none;
    // A release is one layer, the bundle: its type, a SHA-256 digest, and a size that a bundle can have.
    const layers = Option.getOrNull(Schema.decodeUnknownOption(Manifest)(yield* json(tagged, "manifest")))?.layers ?? [];
    const [layer, ...more] = layers;
    if (!layer || more.length || layer.mediaType != RELEASE_TYPE || !(layer.size > 0 && layer.size <= MAX_BYTES))
      return { state: "refused" as const, at };
    return { state: "released" as const, at, layer, later, bundle: get(`/v2/${name}/blobs/${layer.digest}`, auth) };
  });

/**
 * Whether GitHub has the release of `commit` (its full name), from the release's manifest alone: nothing is fetched,
 * and nothing is checked against a digest. "refused": what is there is not one release's bundle; no deploy takes it.
 */
export const releaseState = (fetch: Fetch, spec: Pick<Spec, "repo" | "branch">, commit: string): Effect.Effect<ReleaseState, DeployError> =>
  Effect.map(manifestOf(fetch, spec, commit), (found) => found.state);

/**
 * The release of `commit` (its full name), fetched and checked. null: GitHub has no release of that commit.
 */
export const fetchRelease = (
  fetch: Fetch,
  spec: Pick<Spec, "repo" | "branch">,
  commit: string
): Effect.Effect<Release | null, DeployError> =>
  Effect.gen(function* () {
    const found = yield* manifestOf(fetch, spec, commit);
    if (found.state == "none") return null;
    const at = found.at;
    if (found.state == "refused")
      return yield* new DeployError({
        message: `${at} is not a release: one bundle of at most ${MAX_BYTES} bytes, of the type ${RELEASE_TYPE}.`,
      });
    const { layer, later } = found;
    const blob = yield* found.bundle;
    if (blob.status == 404)
      return yield* new DeployError({ message: `GitHub's registry has the release ${at}, but not its bundle (${layer.digest}).` });
    const bytes = new Uint8Array(yield* Effect.tryPromise({ try: () => blob.arrayBuffer(), catch: () => later("its bundle stopped") }));
    const digest = `sha256:${Hex.encode(new Uint8Array(yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes))))}`;
    if (bytes.byteLength != layer.size || digest != layer.digest)
      return yield* new DeployError({
        message: `The bundle of ${at} is not the one that its manifest names: ${bytes.byteLength} bytes with the digest ${digest}, not ${layer.size} bytes with ${layer.digest}. It is not deployed.`,
      });
    const release = yield* Effect.tryPromise({
      try: () => unpackRelease(bytes),
      catch: (e) => (e instanceof DeployError ? e : new DeployError({ message: e instanceof Error ? e.message : String(e) })),
    });
    if (release.version.length < 12 || !commit.startsWith(release.version))
      return yield* new DeployError({
        message: `The release at ${at} says that it is ${release.version}, not that commit. It is not deployed.`,
      });
    return release;
  });
