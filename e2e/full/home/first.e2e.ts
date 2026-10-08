// The first / on a fresh server, and a landing_document the deploy locks: a server of their own each.
import { expect, test } from "../../fixtures";
import { adminToken, front, get, home, publish } from "./home";

// A server of its own (a few seconds to start; more on a loaded machine).
const OWN_SERVER = { timeout: 60_000 };

test("on a fresh server the first / is the viewer and starts the first deploy; then / is the page itself, from the deploy", OWN_SERVER, async ({ tab }) => {
  const server = await tab.own({ env: { ERGA_HOME_RECHECK_MS: "0" } });
  const first = await front(server);
  expect(first.direct).toBe(false);
  expect(first.html).toContain('<iframe id="frame"');
  await expect.poll(async () => (await front(server)).direct).toBe(true);
  const now = await front(server);
  expect(now.timing).toMatch(/home;desc="(home|memory|cache)"/);
  expect(now.html).not.toContain('<iframe id="frame"');
  expect(now.html).toContain("<h1>Erga");
  expect(now.headers.get("content-security-policy") ?? "").toContain("frame-ancestors 'self'");
  expect(now.headers.get("cache-control")).toBe("private, no-cache");
  const id = ((await (await get(server, "/tester/landing/api/doc")).json()) as { docName: { id: string } }).docName.id;
  const status = await home(server, id);
  expect(status).toMatchObject({ isHome: true, canSet: true, deploy: { state: "deployed", error: null } });
  expect(status.deploy.at).toBeTruthy();
});

test("a landing_document the deploy locks can't be changed: canSet is false, and POST is refused", OWN_SERVER, async ({ tab }) => {
  const server = await tab.own({ env: { ERGA_SERVER_CONFIG: JSON.stringify({ landing_document: null }) } });
  const made = await publish(server, await adminToken(server), { "index.html": "<h1>Mine</h1>" });
  expect(made.id).toMatch(/^[a-z0-9]{8}$/);
  expect(await home(server, made.id)).toMatchObject({ isHome: false, canSet: false });
  const r = await get(server, `/api/docs/${made.id}/home`, { method: "POST", headers: { Origin: server.root, "Content-Type": "application/json" }, body: JSON.stringify({ isHome: true }) });
  expect(r.status).toBe(409);
});
