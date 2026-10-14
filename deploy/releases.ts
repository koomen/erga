// The release store: every release erga.dev publishes, on two channels, for
// anyone to read. The control Worker writes it (an R2 bucket, RELEASES in
// control/wrangler.jsonc) and serves it at https://ops.erga.dev/releases/,
// public, no sign-in:
//
//   /releases/edge.json, /releases/stable.json    a channel: its releases, newest first ({channel, latest, releases})
//   /releases/<version>/manifest.json             one release: its commit, when it was built and published, each file's
//                                                 SHA-256 and size
//   /releases/<version>/release.json              the release's table of contents (ReleaseIndex), and under it the files
//   /releases/<version>/bundle/..., assets/..., migrations/..., control/...
//                                                 as deploy/release.ts lays them out, so loadRelease reads a release from
//                                                 the store as it reads one from disk
//
// Channels: edge gets every release production deploys and finds healthy
// (each commit of main). stable is the newest release tag (vX.Y.Z on a
// commit of main: server/source/repo.ts): when a tag is cut and its commit's
// build is in the store, the deploys' object puts it on stable
// (deploy/branches.ts, tagged). Other installs follow stable.
//
// A release's version is its commit (12 hex digits), as ERGA_VERSION names
// it everywhere. The files are written first, the manifest last, and a
// channel lists only a version whose manifest is there: a reader never meets
// a half-written release. Each file's hash is in the manifest, and the
// store is on erga.dev's own host over HTTPS: a reader checks what it got.
// (No signature yet: a signed manifest comes with the first install that
// reads the store from another account's control Worker.)

import { DeployError, loadRelease, type Release, type ReleaseIndex } from "./pipeline";

export type Channel = "edge" | "stable";
export const CHANNELS: Channel[] = ["edge", "stable"];
export const isChannel = (s: string): s is Channel => s == "edge" || s == "stable";
/** How many releases a channel lists (the oldest fall off; their files stay). */
export const CHANNEL_KEEP = 50;

/** Where the files go: an R2 bucket (cloudflare/pipeline.ts), or a Map in the tests and local development. */
export interface ReleaseBlobs {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** One release in a channel's list. */
export interface ChannelEntry {
  version: string;
  commit: string;
  built: string;
  /** When it went on this channel (ms since the epoch), and by whom (the release's tagger); edge's come from the deploy. */
  at: number;
  by?: string;
  /** stable: the release tag (v1.2.0). */
  tag?: string;
}
export interface ChannelFile { channel: Channel; latest: string | null; releases: ChannelEntry[] }

/** One release's manifest. */
export interface Manifest {
  version: string;
  commit: string;
  built: string;
  published: number;
  files: Record<string, { sha256: string; size: number }>;
}

/** What GET /api/releases answers: both channels. */
export interface ReleasesView { edge: ChannelFile; stable: ChannelFile }

const text = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const VERSION = /^[0-9a-f]{12}$/;

export const channelKey = (c: Channel) => `channels/${c}.json`;
export const releaseKey = (version: string, path: string) => `releases/${version}/${path}`;

/** The media type a file in the store is served with. */
export const releaseType = (path: string) =>
  path.endsWith(".json") ? "application/json; charset=utf-8" : path.endsWith(".js") || path.endsWith(".mjs") ? "application/javascript; charset=utf-8"
  : path.endsWith(".css") ? "text/css; charset=utf-8" : path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".sql") ? "text/plain; charset=utf-8"
  : path.endsWith(".woff2") ? "font/woff2" : path.endsWith(".png") ? "image/png" : path.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";

export async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A release's files as the store lays them out (release.json included), by path. */
export function releaseFiles(release: Release): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(release.modules)) files[`bundle/${name}`] = bytes;
  for (const [path, bytes] of Object.entries(release.assets)) files[`assets/${path.replace(/^\//, "")}`] = bytes;
  for (const [name, sql] of Object.entries(release.migrations)) files[`migrations/${name}`] = text(sql);
  if (release.control) for (const [name, bytes] of Object.entries(release.control.modules)) files[`control/${name}`] = bytes;
  const index: ReleaseIndex = {
    version: release.version, built: release.built, worker: release.worker, mainModule: release.mainModule,
    modules: Object.keys(release.modules).sort(), assets: Object.keys(release.assets).map((p) => p.replace(/^\//, "")).sort(), migrations: Object.keys(release.migrations).sort(),
    ...(release.control ? { control: { config: release.control.config, mainModule: release.control.mainModule, modules: Object.keys(release.control.modules).sort() } } : {}),
  };
  files["release.json"] = json(index);
  return files;
}

/** The store, over its blobs. */
export class ReleaseStore {
  constructor(private blobs: ReleaseBlobs, private now: () => number = Date.now) {}

  async channel(c: Channel): Promise<ChannelFile> {
    const bytes = await this.blobs.get(channelKey(c));
    if (!bytes) return { channel: c, latest: null, releases: [] };
    try { return JSON.parse(new TextDecoder().decode(bytes)) as ChannelFile; } catch { return { channel: c, latest: null, releases: [] }; }
  }

  async view(): Promise<ReleasesView> {
    const [edge, stable] = await Promise.all([this.channel("edge"), this.channel("stable")]);
    return { edge, stable };
  }

  async manifest(version: string): Promise<Manifest | null> {
    if (!VERSION.test(version)) return null;
    const bytes = await this.blobs.get(releaseKey(version, "manifest.json"));
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as Manifest) : null;
  }

  /** A file of a release, for serving: its bytes and media type, or null. */
  async file(version: string, path: string): Promise<{ bytes: Uint8Array; type: string } | null> {
    if (!VERSION.test(version) || !path || path.includes("..") || path.startsWith("/")) return null;
    const bytes = await this.blobs.get(releaseKey(version, path));
    return bytes ? { bytes, type: releaseType(path) } : null;
  }

  /**
   * Publishes `release` (built from `commit`): every file, then the manifest. A release published before is written
   * again as it is (the same bytes: a build is a function of its commit). Returns the manifest.
   */
  async publish(release: Release, commit: string): Promise<Manifest> {
    if (!VERSION.test(release.version)) throw new DeployError(`Not a release version: ${release.version}`);
    const files = releaseFiles(release);
    const manifest: Manifest = { version: release.version, commit, built: release.built, published: this.now(), files: {} };
    for (const [path, bytes] of Object.entries(files)) {
      await this.blobs.put(releaseKey(release.version, path), bytes, releaseType(path));
      manifest.files[path] = { sha256: await sha256(bytes), size: bytes.byteLength };
    }
    await this.blobs.put(releaseKey(release.version, "manifest.json"), json(manifest), releaseType("manifest.json"));
    return manifest;
  }

  /** Puts a published release at the head of a channel (edge after a healthy production deploy; stable when a release tag is cut). */
  async addTo(c: Channel, version: string, by?: string, tag?: string): Promise<ChannelFile> {
    const m = await this.manifest(version);
    if (!m) throw new DeployError(`There's no release ${version} in the store${VERSION.test(version) ? ": it was never published (a healthy production deploy publishes its release)" : ""}.`);
    const file = await this.channel(c);
    const entry: ChannelEntry = { version, commit: m.commit, built: m.built, at: this.now(), ...(by ? { by } : {}), ...(tag ? { tag } : {}) };
    file.releases = [entry, ...file.releases.filter((r) => r.version != version)].slice(0, CHANNEL_KEEP);
    file.latest = version;
    await this.blobs.put(channelKey(c), json(file), releaseType("x.json"));
    return file;
  }

  /** Takes a release off a channel: the channel's latest is the newest that stays. The files stay (a rollback may want them). */
  async withdraw(c: Channel, version: string): Promise<ChannelFile> {
    const file = await this.channel(c);
    if (!file.releases.some((r) => r.version == version)) throw new DeployError(`${version} isn't on ${c}.`);
    file.releases = file.releases.filter((r) => r.version != version);
    file.latest = file.releases[0]?.version ?? null;
    await this.blobs.put(channelKey(c), json(file), releaseType("x.json"));
    return file;
  }

  /** A release read back from the store (an install, an upgrade), each file checked against the manifest. */
  async load(version: string): Promise<Release | null> {
    const m = await this.manifest(version);
    if (!m) return null;
    return loadRelease(async (path) => {
      const bytes = await this.blobs.get(releaseKey(version, path));
      if (!bytes) return null;
      const want = m.files[path];
      if (!want) throw new DeployError(`Release ${version} has a file its manifest doesn't list: ${path}.`);
      if (bytes.byteLength != want.size || (await sha256(bytes)) != want.sha256) throw new DeployError(`Release ${version}'s ${path} doesn't match its manifest: the store is damaged, or someone changed it.`);
      return bytes;
    });
  }
}

/**
 * Blobs read from another control Worker's store over HTTPS (an install
 * reading erga.dev's: deploy/fleet.ts): the channel files and each release's
 * files at /releases/..., as releasesDoor serves them. Read-only.
 */
export function httpBlobs(origin: string, net: (input: string, init?: RequestInit) => Promise<Response> = globalThis.fetch.bind(globalThis)): ReleaseBlobs {
  const base = origin.replace(/\/+$/, "");
  const urlOf = (key: string) => {
    const chan = /^channels\/([a-z]+)\.json$/.exec(key);
    if (chan) return `${base}/releases/${chan[1]}.json`;
    const rel = /^releases\/([0-9a-f]{12})\/(.+)$/.exec(key);
    if (rel) return `${base}/releases/${rel[1]}/${rel[2].split("/").map(encodeURIComponent).join("/")}`;
    throw new DeployError(`Not a key of the release store: ${key}`);
  };
  return {
    get: async (key) => {
      const r = await net(urlOf(key), { headers: { Accept: "application/octet-stream, application/json" } }).catch((e: Error) => { throw new DeployError(`Couldn't reach the release store at ${base}: ${e.message}`); });
      if (r.status == 404) return null;
      if (!r.ok) throw new DeployError(`The release store at ${base} answered ${r.status} for ${key}.`);
      return new Uint8Array(await r.arrayBuffer());
    },
    put: async () => { throw new DeployError("An upstream's release store is read-only here."); },
    delete: async () => { throw new DeployError("An upstream's release store is read-only here."); },
  };
}

/**
 * A release fetched from a store, in the builder's place (deploy/branches.ts
 * asks its builder for a commit; an install asks the store for a version):
 * every file checked against the manifest.
 */
export function storeBuilder(store: ReleaseStore): { build(o: { commit: string }, log: (line: string) => void, signal?: AbortSignal): Promise<Release> } {
  return {
    async build({ commit }, log, signal) {
      log(`fetching release ${commit} from the release store`);
      const release = await store.load(commit);
      signal?.throwIfAborted();
      if (!release) throw new DeployError(`The release store has no release ${commit}.`);
      log(`release ${commit}: ${Object.keys(release.modules).length} modules, ${Object.keys(release.assets).length} files, ${Object.keys(release.migrations).length} migrations${release.control ? ", the control Worker" : ""}; every file matches its manifest`);
      return release;
    },
  };
}

/** Blobs in memory: the tests, and local development (ERGA_DEPLOY_MOCK). */
export function memoryBlobs(map = new Map<string, { bytes: Uint8Array; type: string }>()): ReleaseBlobs & { map: Map<string, { bytes: Uint8Array; type: string }> } {
  return {
    map,
    get: async (k) => map.get(k)?.bytes ?? null,
    put: async (k, bytes, type) => { map.set(k, { bytes: new Uint8Array(bytes), type }); },
    delete: async (k) => { map.delete(k); },
  };
}

/** An R2 bucket binding, as much of it as the store uses (typed here: this file is built outside the Worker too). */
export interface Bucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** Blobs in an R2 bucket (the control Worker's RELEASES binding). */
export function r2Blobs(bucket: Bucket): ReleaseBlobs {
  return {
    get: async (k) => { const o = await bucket.get(k); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
    put: async (k, bytes, type) => { await bucket.put(k, bytes, { httpMetadata: { contentType: type } }); },
    delete: async (k) => { await bucket.delete(k); },
  };
}

/** The HTTP side: GET /releases/... for anyone (control/routes.ts), or null for a path that isn't one. */
export async function releasesDoor(store: ReleaseStore | null, path: string): Promise<Response | null> {
  if (path != "/releases" && !path.startsWith("/releases/")) return null;
  const noStore = { "Cache-Control": "no-cache" };
  if (!store) return Response.json({ error: "This server has no release store." }, { status: 404, headers: noStore });
  const rest = path.slice("/releases".length).replace(/^\//, "");
  if (!rest) return Response.json(await store.view(), { headers: noStore });
  const [, chan] = /^([a-z]+)\.json$/.exec(rest) ?? [];
  if (chan) return isChannel(chan) ? Response.json(await store.channel(chan), { headers: noStore }) : Response.json({ error: `No channel called ${chan}: edge or stable.` }, { status: 404, headers: noStore });
  const [, version, file] = /^([0-9a-f]{12})\/(.+)$/.exec(rest) ?? [];
  if (!version) return Response.json({ error: "Not found" }, { status: 404, headers: noStore });
  const f = await store.file(version, file);
  if (!f) return Response.json({ error: `Release ${version} has no ${file}.` }, { status: 404, headers: noStore });
  // A release's files never change once published; its manifest is written last and once.
  return new Response(f.bytes as BodyInit, { headers: { "Content-Type": f.type, "Cache-Control": file == "manifest.json" ? "public, max-age=60" : "public, max-age=31536000, immutable" } });
}
