// A pretend GitHub registry (ghcr.io) with one release, for the tests of deploy/deployer/registry.ts and of the deploys
// that fetch a release: the token, the manifest by the commit, the bundle by its digest.

export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TYPE = "application/vnd.erga.release.v1+json";

const b64 = (text: string) => btoa(text);
/** A release's bundle, as the build packs it. */
export const bundleOf = (version = COMMIT.slice(0, 12)) =>
  new TextEncoder().encode(
    JSON.stringify({
      index: {
        version,
        built: "2026-11-19T22:30:03.116Z",
        worker: { name: "erga", compatibilityDate: "2026-11-01", env: {} },
        mainModule: "index.js",
        modules: ["index.js"],
        assets: ["page.js"],
        migrations: ["0001_erga.sql"],
      },
      files: {
        "bundle/index.js": b64("export default {}"),
        "assets/page.js": b64("console.log(1)"),
        "migrations/0001_erga.sql": b64("CREATE TABLE users (login TEXT);"),
      },
    })
  );
export const digestOf = async (bytes: Uint8Array) =>
  `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/** A pretend ghcr.io with one release. `over`: what it answers in place of its own answer, by the call. */
export async function registry(
  over: {
    bundle?: Uint8Array;
    served?: Uint8Array;
    manifest?: (m: { layers: { mediaType: string; digest: string; size: number }[] }) => unknown;
    token?: Response;
    tagged?: Response;
    blob?: Response;
    fail?: boolean;
    /** The commit whose release it has (default: COMMIT). */
    commit?: string;
  } = {}
) {
  const commit = over.commit ?? COMMIT;
  const bundle = over.bundle ?? bundleOf();
  const digest = await digestOf(bundle);
  const manifest = { schemaVersion: 2, artifactType: TYPE, layers: [{ mediaType: TYPE, digest, size: bundle.byteLength }] };
  const calls: { url: string; auth: string | null; accept: string | null }[] = [];
  const fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization"), accept: headers.get("accept") });
    if (over.fail) throw new Error("connection refused");
    const path = url.replace("https://ghcr.io", "");
    if (path.startsWith("/token?")) return over.token ?? Response.json({ token: "anonymous-token" });
    if (path.includes("/manifests/"))
      return (
        over.tagged ??
        (path.endsWith(`/manifests/${commit}`)
          ? Response.json(over.manifest ? over.manifest(manifest) : manifest)
          : Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 }))
      );
    if (path.endsWith(`/blobs/${digest}`)) return over.blob ?? new Response(new Uint8Array(over.served ?? bundle));
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls, digest };
}
