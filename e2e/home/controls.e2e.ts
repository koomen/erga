// The controls over the homepage: who sees what.
import { expect, servers, test } from "../fixtures";
import { deployed, fresh, resetLanding } from "./home";

await servers.short();
test.afterEach(async () => { await resetLanding(await servers.short()); });

test("Clone for everyone, Edit for its editors, and who you are, with its menu", async ({ tab }) => {
  const server = await servers.short();
  const { address } = await fresh(server);
  await deployed(server);
  const p = tab.page;
  await p.setViewportSize({ width: 1200, height: 800 });
  const controls = () => p.evaluate(() => {
    const r = document.querySelector("erga-controls")?.shadowRoot;
    return { clone: r?.querySelector(".erga-clone-button")?.getAttribute("href") ?? null, edit: r?.querySelector(".erga-edit-button")?.getAttribute("href") ?? null, account: (r?.querySelector(".erga-account") as HTMLElement | null)?.dataset.ergaAccount ?? null, inBody: !!document.body.querySelector("erga-controls") };
  });
  await p.goto(`${server.root}/`);
  expect(await controls()).toEqual({ clone: "/new?from=landing", edit: `${address}#edit`, account: "in", inBody: false });
  const menuHidden = () => p.evaluate(() => (document.querySelector("erga-controls")!.shadowRoot!.querySelector(".erga-account-menu") as HTMLElement).hidden);
  await p.evaluate(() => (document.querySelector("erga-controls")!.shadowRoot!.querySelector(".erga-account-btn") as HTMLElement).click());
  expect(await menuHidden()).toBe(false);
  await p.mouse.click(600, 500);
  expect(await menuHidden()).toBe(true);
  await p.goto(`${server.root}/?user=Bo`);
  expect(await controls()).toMatchObject({ clone: "/new?from=landing&user=Bo", edit: null, account: "in" });
  await p.goto(`${server.root}/auth/logout`);
  await p.goto(`${server.root}/`);
  expect(await controls()).toMatchObject({ edit: null, account: "out" });
});
