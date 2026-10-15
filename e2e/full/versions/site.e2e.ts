// Publishing a document to a domain in the person's own Cloudflare account, against the pretend
// Cloudflare (deploy/mock-cloudflare.ts, ERGA_DEPLOY_MOCK=1, its pretend consent page): connect (a consent), publish at a
// hostname, the site following a new published version, and the take-down; and the same in the editor's settings, the
// consent in a popup. The pieces alone: tests/sites.test.ts.
import { expect, servers, test } from "../../fixtures";
import { openDocEditor, tester } from "./settings";
import { cut, intoHeading, person, someone, type Person } from "./versions";
const site = () => servers.of("site", { env: {
  ERGA_DEPLOY_MOCK: "1", ERGA_SITE_DELAY_MS: "1500", ERGA_WRITE_DELAY_MS: "50", ERGA_VERSION_IDLE_MS: "1000", ERGA_VERSION_MAX_MS: "8000",
} });

interface SiteState { connection: { connected: boolean; accounts: { name: string }[] }; site: { hostname: string } | null; deploy: { state: string; version: number | null; error: string | null }; zones?: { name: string }[]; error?: string }

/** Cloudflare's consent, through the pretend consent page's Authorize: Connect Cloudflare as a browser follows it. */
async function consent(who: Person, start = "/auth/cloudflare/start?return=%2Fsettings") {
  const r = await who.get(start);
  const to = new URL(r.headers.get("location")!);
  expect(to.pathname).toBe("/auth/cloudflare/mock/consent");
  const kept = r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_cf_consent="))!;
  return who.get(`/auth/cloudflare/callback?code=mock-code&state=${to.searchParams.get("state")}`, { headers: { Cookie: `${who.cookie}; ${kept}` } });
}

test("connect Cloudflare (a consent), publish at a hostname, the site follows the next version, and Remove takes it down", async () => {
  const server = await site();
  const ada = await person(server, someone("site"));
  const { id } = await ada.newDoc();
  const room = await ada.join(id);
  try {
    await cut(ada, id, room, intoHeading(" first"));
    const api = (path = "", init: RequestInit = {}) => ada.get(`/api/docs/${id}/site${path}`, { ...init, headers: { Origin: server.root, "Content-Type": "application/json", ...(init.headers as Record<string, string>) } });
    const state = async (q = "") => (await (await api(q)).json()) as SiteState;
    expect((await state()).connection.connected).toBe(false);

    // The consent: back on /settings, connected as the account Cloudflare's page chose.
    expect((await consent(ada)).headers.get("location")).toBe("/settings?cloudflare=connected");
    const page = await (await ada.get("/settings?cloudflare=connected")).text();
    expect(page).toContain("Connected as Ada's account");
    expect(page).not.toContain("mock-oauth-");
    expect((await state()).connection).toMatchObject({ connected: true, accounts: [{ name: "Ada's account" }] });

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

    // Disconnect: Erga's access revoked, and the domains go with it.
    expect((await ada.get("/settings/cloudflare/disconnect", { method: "POST", body: new URLSearchParams(), headers: { Origin: server.root } })).status).toBe(303);
    expect((await state()).connection.connected).toBe(false);
  } finally { room.disconnect(); }
});

test("in the editor's settings, Connect Cloudflare opens the consent in a popup, and the panel goes on to the domains", async ({ tab }) => {
  const server = await site();
  const owner = await tester(server);
  const doc = { owner, ...(await owner.newDoc()) };
  // A connection left by another test of this server's: start from none.
  await doc.owner.get("/settings/cloudflare/disconnect", { method: "POST", body: new URLSearchParams(), headers: { Origin: server.root } });
  const s = await openDocEditor(tab.page, server, doc.address);
  await s.open();
  const p = tab.page;
  await p.locator("#ds-site-connect").scrollIntoViewIfNeeded();
  expect(await p.locator("#ds-site-connect").textContent()).toBe("Connect Cloudflare");
  const [popup] = await Promise.all([p.context().waitForEvent("page"), p.click("#ds-site-connect")]);
  await popup.waitForLoadState();
  expect(new URL(popup.url()).pathname).toBe("/auth/cloudflare/mock/consent");
  expect(await popup.locator(".scopes").textContent()).toContain("workers-scripts.edit");
  expect(await p.locator("#ds-site-connect").textContent()).toBe("Waiting for Cloudflare…");
  await popup.click("#authorize");
  await popup.waitForEvent("close", { timeout: 10_000 });
  // The panel, still open, goes straight on to a name and one of the domains.
  await expect.poll(() => p.locator("#ds-site-zone option").count(), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(await s.isOpen()).toBe(true);
  expect(await p.locator("#ds-site-zone option").first().textContent()).toBe("ada-example.com");
  await p.fill("#ds-site-name", "notes");
  expect(await p.locator("#ds-site-publish").textContent()).toBe("Publish to notes.ada-example.com");

  // A refused consent: the panel says why, and offers Connect again.
  await doc.owner.get("/settings/cloudflare/disconnect", { method: "POST", body: new URLSearchParams(), headers: { Origin: server.root } });
  await p.keyboard.press("Escape");
  await expect.poll(() => s.isOpen()).toBe(false);
  await s.open();
  await expect.poll(() => p.locator("#ds-site-connect").count(), { timeout: 10_000 }).toBe(1);
  const [again] = await Promise.all([p.context().waitForEvent("page"), p.click("#ds-site-connect")]);
  await again.waitForLoadState();
  await again.click("text=Cancel");
  await expect.poll(() => p.locator("#ds-site-error").textContent(), { timeout: 10_000 }).toContain("You didn't authorize Erga on Cloudflare");
  await again.close();
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
