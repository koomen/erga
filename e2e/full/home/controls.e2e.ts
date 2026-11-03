// The controls over the homepage: who sees what. / is the homepage for someone signed out only (someone signed in
// goes to /docs); the homepage project's own page, /_home, has Edit for admins.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";
import { deployed, fresh, front, homeView, openHome, redeploy, resetLanding } from "./home";

await servers.short();
test.afterEach(async () => {
  await resetLanding(await servers.short());
});

test("signed out, / has Clone (the New menu's last item) and Sign in with its menu, no Edit; /_home has Edit for admins only", async ({
  tab,
}) => {
  const server = await servers.short();
  await fresh(server);
  await deployed(server);
  const p = tab.page;
  await p.setViewportSize({ width: 1200, height: 800 });
  await openHome(p, server.root);
  const controls = () =>
    p.evaluate(() => {
      const r = document.querySelector("erga-controls")?.shadowRoot;
      return {
        clone: r?.querySelector(".erga-new-clone")?.getAttribute("href") ?? null,
        edit: r?.querySelector(".erga-edit-button")?.getAttribute("href") ?? null,
        account: (r?.querySelector(".erga-account") as HTMLElement | null)?.dataset.ergaAccount ?? null,
        inBody: !!document.body.querySelector("erga-controls"),
      };
    });
  expect(await controls()).toEqual({ clone: "/new?from=landing", edit: null, account: "out", inBody: false });
  const menuHidden = () =>
    p.evaluate(() => (document.querySelector("erga-controls")!.shadowRoot!.querySelector(".erga-account-menu") as HTMLElement).hidden);
  await p.evaluate(() => (document.querySelector("erga-controls")!.shadowRoot!.querySelector(".erga-account-btn") as HTMLElement).click());
  expect(await menuHidden()).toBe(false);
  await p.mouse.click(600, 500);
  expect(await menuHidden()).toBe(true);
  // Signed in: the homepage project's page, with Edit for an admin (the dev server's own person), not for Bo.
  expect(await homeView(server)).toContain('class="erga-view-button erga-edit-button"');
  expect(await homeView(server, "Bo")).not.toContain("erga-edit-button");
});

test("a homepage with its own Inter gets no second one from the controls", async () => {
  const server = await servers.short();
  await fresh(server);
  await deployed(server);
  expect((await front(server)).html).toContain('<style id="erga-fonts">');
  const page = `<!doctype html><html><head><style>@font-face { font-family: "Inter"; src: url(inter.woff2) format("woff2"); }</style></head><body><p>Hi</p></body></html>`;
  expect((await runTool(server.root, "write", { document: "/_home", files: { "index.html": page } })).error).toBeUndefined();
  await redeploy(server);
  await until(async () => (await front(server)).html.includes("<p>Hi</p>"), 10_000, "the new page deployed");
  const html = (await front(server)).html;
  expect({ own: html.includes('font-family: "Inter"'), controls: html.includes('<style id="erga-fonts">') }).toEqual({
    own: true,
    controls: false,
  });
});
