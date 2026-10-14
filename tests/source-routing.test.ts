// Where the Source page answers: erga.dev and staging serve it (and its API) in place at /admin/source, on the control
// Worker's objects over the CONTROL binding; the rest of the control Worker's routes go there by a redirect. And the
// page itself when the app serves it: /source goes to /admin/source, and the Git address is the control Worker's.
import { describe, expect, test } from "bun:test";
import { appAnswer, controlRoutes, type Control } from "../control/routes";
import type { Platform } from "../server/platform";
import type { Session } from "../server/identity/index";

describe("the app's Worker", () => {
  const apart = { control: true, controlUrl: true, pipeline: false };
  test("serves the Source page and its API in place where the control Worker is apart (erga.dev, staging)", () => {
    for (const path of ["/admin/source", "/source", "/admin/factory", "/api/source/branches", "/api/source/merge", "/api/deploys", "/api/deploys/staging/log", "/api/events", "/api/releases", "/api/releases/promote"])
      expect([path, appAnswer(path, apart)]).toEqual([path, "here"]);
  });
  test("sends the rest to the control Worker: Git, /install, the release store, the public source", () => {
    for (const path of ["/git/erga.git/info/refs", "/git", "/git/tree/main", "/install", "/install/start", "/api/install", "/releases", "/releases/stable.json"])
      expect([path, appAnswer(path, apart)]).toEqual([path, "there"]);
  });
  test("serves every control route in local development, none where there is no control Worker, and not its own routes", () => {
    expect(appAnswer("/git/erga.git/info/refs", { control: false, controlUrl: false, pipeline: true })).toBe("here");
    expect(appAnswer("/admin/source", { control: false, controlUrl: false, pipeline: false })).toBe("none");
    for (const path of ["/", "/admin", "/admin/users", "/docs", "/api/health"]) expect(appAnswer(path, apart)).toBeNull();
  });
});

describe("the Source page, served by the app", () => {
  const session = { login: "ada", name: "Ada" } as unknown as Session;
  const platform = {
    sessionOf: async () => session,
    directory: { users: { isAdmin: async () => true, actsAsAdmin: async () => true } },
    source: { mirrorUrl: "" },
    control: { url: "https://ops.erga.test" },
  } as unknown as Platform;
  const control = (releases: unknown): Control => ({
    platform, app: "https://erga.test", version: null, page: "/admin/source",
    layout: (o) => new Response(`<title>${o.title}</title>${o.body}`, { headers: { "Content-Type": "text/html" } }),
    deploys: { releases: async () => releases } as never,
    oauth: { clientId: "", accountId: "", worker: "erga-control", net: fetch },
  });
  const go = (path: string, c = control(null)) => controlRoutes(new Request(`https://erga.test${path}`, { headers: { accept: "text/html" } }), c);

  test("/source and /admin/factory go to /admin/source, not to the homepage", async () => {
    for (const path of ["/source", "/admin/factory"]) {
      const r = await go(path);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/admin/source");
    }
  });
  test("/admin/source is the page, and its Git address is the control Worker's", async () => {
    const r = await go("/admin/source");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("git remote add erga https://ops.erga.test/git/erga.git");
  });
  test("/api/releases answers the channels over the binding, and 404 where there's no store", async () => {
    const view = { edge: { releases: [] }, stable: { releases: [] } };
    const ok = await go("/api/releases", control(view));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(view);
    expect((await go("/api/releases", control(null))).status).toBe(404);
  });
});
