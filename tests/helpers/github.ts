// A pretend GitHub for the deployers' tests: the repository example/erga with the branch main, as the deployer's look
// reads it (deploy/deployer/github.ts: git's list of the refs, the branch's feed of commits), and its registry with the
// releases (deploy/deployer/registry.ts: the token, the manifest, the bundle).

import { join } from "node:path";
import type { Fetch } from "../../deploy/deployer/cloudflare-api";
import { packRelease } from "../../deploy/pipeline/build";
import { ROOT, SHA1, SHA2 } from "./deploys.ts";

const TYPE = "application/vnd.erga.release.v1+json";
const short = (sha: string) => sha.slice(0, 12);
const SHA4 = "4444444444444444444444444444444444444444";

/** A small release's bundle, as the build packs it. */
export const bundleOf = (sha: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      index: {
        version: short(sha),
        built: "2026-11-19T22:30:03.116Z",
        worker: { name: "erga", compatibilityDate: "2026-11-01", env: {} },
        mainModule: "index.js",
        modules: ["index.js"],
        assets: [],
        migrations: [],
      },
      files: { "bundle/index.js": btoa("export default {}") },
    })
  );
/** The release that the deploy tests share, as GitHub's build of `sha` packs it. */
export function builtBundle(sha: string) {
  const bundle = JSON.parse(new TextDecoder().decode(packRelease(join(ROOT, ".build/release"))));
  bundle.index.version = short(sha);
  return new TextEncoder().encode(JSON.stringify(bundle));
}
export const digestOf = async (bytes: Uint8Array) =>
  `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

export const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;

/**
 * A pretend GitHub with the repository example/erga: the branch main (`commits`, newest first: its head is the first)
 * and the registry's releases, by commit. `calls`: each call, as one short word and what it asked for.
 */
export function github(shas: string[] = [SHA2, SHA1]) {
  const state = {
    commits: shas.map((sha, i) => ({ sha, title: `Commit ${short(sha)}`, at: Date.parse("2026-11-19T10:00:00Z") - i * 60_000 })),
    /** The feed's commits, when it is behind the refs. */
    feed: null as null | { sha: string; title: string; at: number }[],
    /** Each commit's release: its bundle, or a manifest that is no release. */
    releases: new Map<string, Uint8Array | "not a release">(),
    /** What the bundle's bytes are when the registry serves them, if not the bundle. */
    served: null as Uint8Array | null,
    /** Release tags advertised in git refs (lightweight or annotated). */
    tags: [] as { name: string; sha: string; annotated?: boolean }[],
    /** GitHub's answer in place of its own (not the registry's). */
    down: null as number | null,
    calls: [] as string[],
  };
  const fetch: Fetch = async (input) => {
    const url = String(input);
    const said = (word: string) => void state.calls.push(word);
    // GitHub's API refuses an address with no credential that a cloud's machines share: no deployer asks it.
    if (url.startsWith("https://api.github.com/")) {
      said(`api ${url.slice("https://api.github.com".length)}`);
      return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
    }
    if (url.startsWith("https://github.com/")) {
      const refs = url == "https://github.com/example/erga.git/info/refs?service=git-upload-pack";
      const feed = url == "https://github.com/example/erga/commits/main.atom";
      said(refs ? "refs" : feed ? "feed" : url);
      if (state.down) return new Response("no", { status: state.down });
      const head = state.commits[0].sha;
      if (refs) {
        const tagLines = state.tags
          .map((t) =>
            t.annotated
              ? `${pkt(`${"9".repeat(40)} refs/tags/${t.name}\n`)}${pkt(`${t.sha} refs/tags/${t.name}^{}\n`)}`
              : pkt(`${t.sha} refs/tags/${t.name}\n`)
          )
          .join("");
        return new Response(
          `${pkt("# service=git-upload-pack\n")}0000${pkt(`${head} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/github\n`)}${pkt(`${SHA4} refs/heads/a/main\n`)}${pkt(`${head} refs/heads/main\n`)}${pkt(`${SHA4} refs/heads/main-2\n`)}${pkt(`${SHA4} refs/tags/main\n`)}${tagLines}0000`
        );
      }
      if (feed)
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n  <id>tag:github.com,2008:/example/erga/commits/main</id>\n  <title>Recent Commits to erga:main</title>\n${(
            state.feed ?? state.commits
          )
            .map(
              (c) =>
                `  <entry>\n    <id>tag:github.com,2008:Grit::Commit/${c.sha}</id>\n    <link type="text/html" rel="alternate" href="https://github.com/example/erga/commit/${c.sha}"/>\n    <title>\n        ${c.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "&#39;")}\n    </title>\n    <updated>${new Date(c.at).toISOString()}</updated>\n    <author>\n      <name>someone</name>\n    </author>\n    <content type="html">\n      &lt;pre&gt;more&lt;/pre&gt;\n    </content>\n  </entry>\n`
            )
            .join("")}</feed>\n`
        );
      return new Response("not found", { status: 404 });
    }
    const path = url.replace("https://ghcr.io", "");
    if (path == "/token?service=ghcr.io&scope=repository:example/erga:pull") return Response.json({ token: "anonymous-token" });
    const tagged = /^\/v2\/example\/erga\/manifests\/([0-9a-f]{40})$/.exec(path)?.[1];
    if (tagged) {
      said(`manifest ${short(tagged)}`);
      const release = state.releases.get(tagged);
      if (!release) return Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 });
      // (Not `release == "not a release"`: JavaScript would first write the bundle's 14 million bytes as text.)
      if (typeof release == "string")
        return Response.json({
          schemaVersion: 2,
          layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: `sha256:${"0".repeat(64)}`, size: 5 }],
        });
      return Response.json({
        schemaVersion: 2,
        artifactType: TYPE,
        layers: [{ mediaType: TYPE, digest: await digestOf(release), size: release.byteLength }],
      });
    }
    const blob = /^\/v2\/example\/erga\/blobs\/(sha256:[0-9a-f]{64})$/.exec(path)?.[1];
    for (const [sha, release] of state.releases)
      if (blob && typeof release != "string" && (await digestOf(release)) == blob) {
        said(`bundle ${short(sha)}`);
        return new Response(new Uint8Array(state.served ?? release));
      }
    return new Response("not found", { status: 404 });
  };
  return { state, fetch };
}
