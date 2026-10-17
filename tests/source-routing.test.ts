// Where the Ops page answers: erga.dev and staging serve it (and its API) in place at /admin/ops, on the control
// Worker's objects over the CONTROL binding; the rest of the control Worker's routes go there by a redirect. And the
// page itself when the app serves it: its old addresses go to /admin/ops, and the Git address is the control Worker's.
import { describe, expect, test } from "bun:test";
import { appAnswer, controlRoutes, isOpsPagePath, type Control } from "../control/routes";
import type { Platform } from "../server/platform";
import type { Session } from "../server/identity/index";

describe("the app's Worker", () => {
  const apart = { control: true, controlUrl: true, pipeline: false };
  test("serves the Ops page and its API in place where the control Worker is apart (erga.dev, staging)", () => {
    for (const path of ["/admin/ops", "/admin/source", "/source", "/admin/factory", "/api/source/branches", "/api/source/merge", "/api/deploys", "/api/deploys/staging/log", "/api/events", "/api/releases", "/api/releases/promote"])
      expect([path, appAnswer(path, apart)]).toEqual([path, "here"]);
  });
  test("sends the rest to the control Worker: Git, /install, the release store, the public source", () => {
    for (const path of ["/git/erga.git/info/refs", "/git", "/git/tree/main", "/install", "/install/start", "/api/install", "/releases", "/releases/stable.json"])
      expect([path, appAnswer(path, apart)]).toEqual([path, "there"]);
  });
  test("serves every control route in local development, none where there is no control Worker, and not its own routes", () => {
    expect(appAnswer("/git/erga.git/info/refs", { control: false, controlUrl: false, pipeline: true })).toBe("here");
    expect(appAnswer("/admin/ops", { control: false, controlUrl: false, pipeline: false })).toBe("none");
    // The sidebar's Ops link: with no control Worker, the app answers it with a page that says so (cloudflare/index.ts).
    for (const path of ["/admin/ops", "/admin/source"]) expect(isOpsPagePath(path)).toBe(true);
    expect(isOpsPagePath("/api/deploys")).toBe(false);
    for (const path of ["/", "/admin", "/admin/users", "/docs", "/api/health"]) expect(appAnswer(path, apart)).toBeNull();
  });
});

describe("the Ops page, served by the app", () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const platform = {
    sessionOf: async () => session,
    directory: { users: { isAdmin: async () => true, actsAsAdmin: async () => true } },
    source: {},
    control: { url: "https://ops.erga.test" },
  } as unknown as Platform;
  const control = (releases: unknown): Control => ({
    platform, app: "https://erga.test", version: null, page: "/admin/ops",
    layout: (o) => new Response(`<title>${o.title}</title>${o.body}`, { headers: { "Content-Type": "text/html" } }),
    deploys: { releases: async () => releases } as never,
    oauth: { clientId: "", accountId: "", worker: "erga-control", net: fetch },
  });
  const go = (path: string, c = control(null)) => controlRoutes(new Request(`https://erga.test${path}`, { headers: { accept: "text/html" } }), c);

  test("/admin/source, /source and /admin/factory go to /admin/ops, not to the homepage", async () => {
    for (const path of ["/admin/source", "/source", "/admin/factory"]) {
      const r = await go(path);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/admin/ops");
    }
  });
  test("/admin/ops is the page: Status, then the Git repository, whose address is the control Worker's", async () => {
    const r = await go("/admin/ops");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("<title>Ops</title>");
    expect(html).toContain("git remote add erga https://ops.erga.test/git/erga.git");
    for (const id of ["env-production", "env-staging", "env-control", "env-cloudflare"]) expect(html).toContain(`id="${id}"`);
    expect(html.indexOf('id="status"')).toBeLessThan(html.indexOf('id="repo"'));
  });
  test("/api/releases answers the channels over the binding, and 404 where there's no store", async () => {
    const view = { edge: { releases: [] }, stable: { releases: [] } };
    const ok = await go("/api/releases", control(view));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(view);
    expect((await go("/api/releases", control(null))).status).toBe(404);
  });
});
