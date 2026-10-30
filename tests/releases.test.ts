// The release store (control/deploys/releases.ts): a release published, its files and
// manifest; the channels (edge after a healthy production deploy, stable when
// a tag put on it, withdrawn); a release read back and checked; and the control
// Worker's routes: the store for anyone, the channels for admins.
import { describe, expect, test } from "bun:test";
import { controlRoutes, type Control } from "../control/routes";
import { CHANNEL_KEEP, memoryBlobs, releaseFiles, ReleaseStore, releasesRoutes } from "../control/deploys/releases";
import { sha256Hex } from "../shared/bytes";
import { DeployError } from "../control/deploys/cloudflare-api";
import type { Release } from "../control/deploys/release-format";
import type { Platform } from "../server/platform";
import type { Session } from "../server/platform";

const enc = (s: string) => new TextEncoder().encode(s);
const V1 = "111111111111", V2 = "222222222222", C1 = "1".repeat(40), C2 = "2".repeat(40);

/** A small release, as the builder would hand one back. */
function release(version: string): Release {
  return {
    version, built: "2026-10-13T10:00:00.000Z", mainModule: "index.js",
    worker: { name: "erga", compatibilityDate: "2026-09-30", env: {} },
    modules: { "index.js": enc(`export default { fetch: () => new Response("${version}") }`) },
    assets: { "/page.js": enc("page"), "/fonts/inter.css": enc("@font-face{}") },
    migrations: { "0001_erga.sql": "CREATE TABLE IF NOT EXISTS users (login TEXT);" },
    control: { config: { name: "erga-control", compatibilityDate: "2026-09-30", compatibilityFlags: [], containers: [], durableObjects: [], d1: [], artifacts: [], r2: [], versionMetadata: null, vars: {}, observability: { enabled: true, logs: { enabled: true, invocationLogs: true } } }, mainModule: "index.js", modules: { "index.js": enc("export default {}") } },
  };
}

function store() {
  let t = 1_700_000_000_000;
  const blobs = memoryBlobs();
  return { blobs, store: new ReleaseStore(blobs, () => (t += 1000)) };
}

describe("the store", () => {
  test("a published release: every file under releases/<version>/, release.json, and the manifest last with each file's hash", async () => {
    const { blobs, store: s } = store();
    const m = await s.publish(release(V1), C1);
    expect(m).toMatchObject({ version: V1, commit: C1, built: "2026-10-13T10:00:00.000Z" });
    expect(Object.keys(m.files).sort()).toEqual(["assets/fonts/inter.css", "assets/page.js", "bundle/index.js", "control/index.js", "migrations/0001_erga.sql", "release.json"]);
    expect(m.files["assets/page.js"]).toEqual({ sha256: await sha256Hex(enc("page")), size: 4 });
    expect([...blobs.map.keys()].sort()).toEqual([...Object.keys(m.files).map((p) => `releases/${V1}/${p}`), `releases/${V1}/manifest.json`].sort());
    expect(blobs.map.get(`releases/${V1}/bundle/index.js`)!.type).toBe("application/javascript; charset=utf-8");
    expect(blobs.map.get(`releases/${V1}/assets/fonts/inter.css`)!.type).toBe("text/css; charset=utf-8");
    // Nothing on a channel yet: publishing isn't releasing.
    expect(await s.view()).toEqual({ edge: { channel: "edge", latest: null, releases: [] }, stable: { channel: "stable", latest: null, releases: [] } });
  });

  test("the store refuses a version that isn't a commit", async () => {
    const { store: s } = store();
    await expect(s.publish(release("dev"), C1)).rejects.toThrow(DeployError);
  });

  test("edge, stable, promote and withdraw: newest first, latest kept, only a published release goes on a channel", async () => {
    const { store: s } = store();
    await s.publish(release(V1), C1);
    await s.publish(release(V2), C2);
    await s.addTo("edge", V1);
    const edge = await s.addTo("edge", V2);
    expect(edge.latest).toBe(V2);
    expect(edge.releases.map((r) => r.version)).toEqual([V2, V1]);
    expect(edge.releases[0]).toMatchObject({ version: V2, commit: C2, built: "2026-10-13T10:00:00.000Z" });
    expect(edge.releases[0].by).toBeUndefined();
    // Promoted: stable, with who did it; edge unchanged.
    const stable = await s.addTo("stable", V1, "ada");
    expect(stable).toMatchObject({ channel: "stable", latest: V1 });
    expect(stable.releases[0]).toMatchObject({ version: V1, by: "ada" });
    expect((await s.channel("edge")).latest).toBe(V2);
    // A version never published can't go on a channel; neither can a non-version.
    await expect(s.addTo("stable", "333333333333", "ada")).rejects.toThrow(/never published/);
    await expect(s.addTo("stable", "nope", "ada")).rejects.toThrow(/no release nope/);
    // Promoted again: moved to the head, listed once.
    await s.addTo("stable", V2, "ada");
    await s.addTo("stable", V1, "bo");
    expect((await s.channel("stable")).releases.map((r) => `${r.version}:${r.by}`)).toEqual([`${V1}:bo`, `${V2}:ada`]);
    // Withdrawn: off the channel, latest is the newest that stays; the files stay.
    const after = await s.withdraw("stable", V1);
    expect(after.latest).toBe(V2);
    expect(after.releases.map((r) => r.version)).toEqual([V2]);
    await expect(s.withdraw("stable", V1)).rejects.toThrow(/isn't on stable/);
    expect(await s.manifest(V1)).not.toBeNull();
    expect((await s.withdraw("stable", V2)).latest).toBeNull();
  });

  test("a channel lists at most CHANNEL_KEEP releases", async () => {
    const { store: s } = store();
    for (let i = 0; i < CHANNEL_KEEP + 3; i++) {
      const v = i.toString(16).padStart(12, "0");
      await s.publish(release(v), v.repeat(4).slice(0, 40));
      await s.addTo("edge", v);
    }
    const edge = await s.channel("edge");
    expect(edge.releases.length).toBe(CHANNEL_KEEP);
    expect(edge.latest).toBe((CHANNEL_KEEP + 2).toString(16).padStart(12, "0"));
  });

  test("a release read back is the release published; a changed file is refused", async () => {
    const { blobs, store: s } = store();
    const r = release(V1);
    await s.publish(r, C1);
    const back = (await s.load(V1))!;
    expect(back.version).toBe(V1);
    expect(new TextDecoder().decode(back.modules["index.js"])).toBe(new TextDecoder().decode(r.modules["index.js"]));
    expect(Object.keys(back.assets).sort()).toEqual(["/fonts/inter.css", "/page.js"]);
    expect(back.migrations).toEqual(r.migrations);
    expect(new TextDecoder().decode(back.control!.modules["index.js"])).toBe("export default {}");
    expect(await s.load(V2)).toBeNull();
    // The files of a release are its own: the same release published again writes the same bytes.
    expect(Object.keys(releaseFiles(r)).sort()).toEqual(Object.keys((await s.manifest(V1))!.files).sort());
    blobs.map.set(`releases/${V1}/assets/page.js`, { bytes: enc("PAGE"), type: "text/plain" });
    await expect(s.load(V1)).rejects.toThrow(/doesn't match its manifest/);
  });
});

describe("the routes", () => {
  test("the store is read by anyone: the channels, a release's manifest and files, each with its media type", async () => {
    const { store: s } = store();
    await s.publish(release(V1), C1);
    await s.addTo("edge", V1);
    const get = async (path: string) => (await releasesRoutes(s, path))!;
    expect(await releasesRoutes(s, "/install")).toBeNull();
    const all = await get("/releases");
    expect(all.status).toBe(200);
    expect(((await all.json()) as { edge: { latest: string } }).edge.latest).toBe(V1);
    expect(((await (await get("/releases/edge.json")).json()) as { releases: unknown[] }).releases.length).toBe(1);
    expect((await get("/releases/stable.json")).headers.get("cache-control")).toBe("no-cache");
    expect((await get("/releases/beta.json")).status).toBe(404);
    const manifest = await get(`/releases/${V1}/manifest.json`);
    expect(manifest.headers.get("cache-control")).toBe("public, max-age=60");
    expect(((await manifest.json()) as { commit: string }).commit).toBe(C1);
    const js = await get(`/releases/${V1}/bundle/index.js`);
    expect(js.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await js.text()).toContain(V1);
    expect((await get(`/releases/${V1}/bundle/nope.js`)).status).toBe(404);
    expect((await get(`/releases/${V2}/manifest.json`)).status).toBe(404);
    expect((await get(`/releases/${V1}/../x`)).status).toBe(404);
    expect((await releasesRoutes(null, "/releases"))!.status).toBe(404);
  });

  test("the channels on the control Worker: admins read list_releases; the store is for anyone; a tag rides on stable", async () => {
    const { store: s } = store();
    await s.publish(release(V1), C1);
    await s.addTo("edge", V1);
    await s.addTo("stable", V1, "ada", "v0.1.0");
    expect((await s.channel("stable")).releases[0]).toMatchObject({ version: V1, by: "ada", tag: "v0.1.0" });
    const ORIGIN = "https://ops.erga.test";
    let who: Session | null = { login: "ada", name: "Ada" } as unknown as Session;
    const platform = {
      sessionOf: async () => who,
      directory: { users: { isAdmin: async () => true, actsAsAdmin: async () => true } },
      deploys: { releases: () => s.view() },
    } as unknown as Platform;
    const c: Control = {
      platform,
      github: null,
      deploys: { releases: () => s.view() } as never,
      releases: s,
      app: "https://erga.test",
      version: "v1",
      layout: (o) => new Response(o.body),
      oauth: { clientId: "", accountId: "", worker: "erga-control", net: fetch },
    };
    const go = (path: string) => controlRoutes(new Request(`${ORIGIN}${path}`, { headers: { accept: "application/json" } }), c);
    // The Ops page's call: POST /api/tools/list_releases, from its own origin.
    const channels = (on: Control) =>
      controlRoutes(
        new Request(`${ORIGIN}/api/tools/list_releases`, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": "application/json" },
          body: "{}",
        }),
        on
      );
    who = null;
    expect((await go("/releases/stable.json")).status).toBe(200);
    expect((await channels(c)).status).toBe(401);
    who = { login: "ada", name: "Ada" } as unknown as Session;
    expect(
      ((await (await channels(c)).json()) as { result: { stable: { latest: string | null; releases: { tag?: string }[] } } }).result.stable
    ).toMatchObject({ latest: V1, releases: [{ tag: "v0.1.0" }] });
    const none: Control = { ...c, releases: null, platform: { ...platform, deploys: { releases: async () => null } } as never };
    expect((await channels(none)).status).toBe(404);
  });
});
