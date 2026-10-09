// Publishing a document to a domain in the person's own Cloudflare account (site-publish.ts), against the pretend
// Cloudflare (deploy/mock.ts, ERGA_DEPLOY_MOCK=1, a "mock-" token): connect on /settings, publish at a hostname, the
// site following a new published version, and the take-down. The pieces alone: tests/sites.test.ts.
import { expect, servers, test } from "../../fixtures";
import { cut, intoHeading, person, someone } from "./versions";

const TOKEN = "mock-" + "e".repeat(36) + "Ab12";
const site = () => servers.of("site", { env: {
  ERGA_DEPLOY_MOCK: "1", ERGA_SITE_DELAY_MS: "1500", ERGA_WRITE_DELAY_MS: "50", ERGA_VERSION_IDLE_MS: "1000", ERGA_VERSION_MAX_MS: "8000",
} });

interface SiteState { connection: { connected: boolean; last4: string | null }; site: { hostname: string } | null; deploy: { state: string; version: number | null; error: string | null }; zones?: { name: string }[]; error?: string }

test("connect a token, publish at a hostname, the site follows the next version, and Remove takes it down", async () => {
  const server = await site();
  const ada = await person(server, someone("site"));
  const { id } = await ada.newDoc();
  const room = await ada.join(id);
  try {
    await cut(ada, id, room, intoHeading(" first"));
    const api = (path = "", init: RequestInit = {}) => ada.get(`/api/docs/${id}/site${path}`, { ...init, headers: { Origin: server.root, "Content-Type": "application/json", ...(init.headers as Record<string, string>) } });
    const state = async (q = "") => (await (await api(q)).json()) as SiteState;
    expect((await state()).connection.connected).toBe(false);

    // A token that isn't one is refused on the page; a good one is kept, shown by its last four characters only.
    const connect = (token: string) => ada.get("/settings/cloudflare", { method: "POST", body: new URLSearchParams({ token }), headers: { Origin: server.root } });
    expect(await (await connect("not a token")).text()).toContain("doesn't look like a Cloudflare API token");
    expect((await connect(TOKEN)).headers.get("location")).toContain("connected=cloudflare");
    const page = await (await ada.get("/settings")).text();
    expect(page).toContain("Ab12");
    expect(page).not.toContain(TOKEN);

    const { zones } = await state("?zones=1");
    const zone = zones![0].name;
    expect((await (await api("", { method: "POST", body: JSON.stringify({ hostname: `notes.elsewhere.org` }) })).json() as SiteState).error).toContain("isn't on a domain");
    const r = await api("", { method: "POST", body: JSON.stringify({ hostname: `notes.${zone}` }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as SiteState).site?.hostname).toBe(`notes.${zone}`);
    const live = (path = "/") => fetch(`${server.root}/__erga/site/notes.${zone}${path}`).then((x) => (x.ok ? x.text() : ""));
    await expect.poll(async () => (await state()).deploy.state, { timeout: 15_000 }).toBe("deployed");
    expect(await live()).toContain("first");

    // A new version: the site follows it a short time later, by itself.
    await cut(ada, id, room, intoHeading(" second"));
    await expect.poll(() => live(), { timeout: 20_000 }).toContain("second");
    await expect.poll(async () => (await state()).deploy, { timeout: 10_000 }).toMatchObject({ state: "deployed", version: 3, error: null });

    // Remove: the record goes, and the pretend Cloudflare no longer serves it.
    expect((await api("", { method: "DELETE" })).status).toBe(200);
    expect((await state()).site).toBeNull();
    expect(await live()).toBe("");
  } finally { room.disconnect(); }
});

test("only editors may publish to a domain, only from this site's pages", async () => {
  const server = await site();
  const ada = await person(server, someone("site"));
  const bo = await person(server, someone("sitebo"));
  const { id } = await ada.newDoc();
  expect((await ada.share(id, bo.login, "viewer")).ok).toBe(true);
  const post = (who: typeof ada, origin: string) => who.get(`/api/docs/${id}/site`, { method: "POST", body: JSON.stringify({ hostname: "x.example.com" }), headers: { Origin: origin, "Content-Type": "application/json" } });
  expect((await post(bo, server.root)).status).toBe(403);
  expect((await post(ada, "https://evil.example")).status).toBe(403);
  expect((await bo.get(`/api/docs/${id}/site`)).status).toBe(200);
});
