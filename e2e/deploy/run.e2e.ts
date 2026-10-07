// A whole deploy from /deploy (tests/deploy.ts): where it goes (a bought domain, documents' pages on a second one), a
// GitHub app with its callback filled in, the review, every step as it goes, and then what the mock Cloudflare was
// asked to do: the new server's settings, its domains, no secret in the clear, the OAuth token given back.
import { expect, test } from "../fixtures";
import { openDeploy, servers } from "./deploy";

await servers.mock();

const SECRET = "0123456789abcdef0123456789abcdef01234567";

test("where it goes, a GitHub app, the review; the deploy shows its steps, finishes, and leaves the new server's settings and no token", { timeout: 20_000 /* a whole deploy against the mock: about 3 s, more on a loaded machine */ }, async ({ tab }) => {
  const s = await servers.mock(), p = await openDeploy(tab.page, s.root), page = tab.page;
  await p.oauth();
  await p.buy("myerga");
  // Documents' pages on a second domain.
  await page.evaluate(() => { const sel = document.getElementById("pages-zone") as HTMLSelectElement; sel.value = [...sel.options].find((o) => o.textContent == "ada-pages.net")!.value; sel.dispatchEvent(new Event("change")); return true; });
  await p.fill("app-host", "write.myerga.com");
  await p.click("#where-next");
  await expect.poll(() => p.current()).toBe("github");
  expect(await p.text("#gh-callback")).toBe("https://write.myerga.com/auth/github/callback");
  expect(await page.evaluate(() => (document.getElementById("gh-new") as HTMLAnchorElement).href)).toContain("oauth_application%5Bcallback_url%5D=https%3A%2F%2Fwrite.myerga.com");
  await p.click("#github-next");
  expect(await p.text("#github-error"), "it asks for the GitHub app's ID first").toContain("Client ID");
  await p.fill("gh-id", "Ov23liMockClientId");
  await p.fill("gh-secret", SECRET);
  await p.click("#github-next");
  await expect.poll(() => p.current()).toBe("deploy");
  const review = await p.text("#review");
  for (const x of ["https://write.myerga.com", "<document>.ada-pages.net", "tester (you)"]) expect(review).toContain(x);

  await p.click("#go");
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("#progress li.done").length >= 2 && !!document.querySelector("#progress li.running, #progress li.pending")), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => !document.getElementById("live")!.hidden), { timeout: 15_000 }).toBe(true);
  expect(await page.evaluate(() => document.querySelectorAll("#progress li.done").length)).toBe(8);
  const live = await p.text("#live");
  expect(live).toContain("write.myerga.com");
  expect(live).toContain("given it back to Cloudflare");
  const state = await p.mock();
  const b = Object.fromEntries(state.scripts.erga.metadata.bindings.map((x: any) => [x.name, x]));
  expect([b.ADMINS.text, b.PAGES_DOMAIN.text, b.GITHUB_CLIENT_ID.text]).toEqual(["tester", "ada-pages.net", "Ov23liMockClientId"]);
  expect(JSON.stringify(state)).not.toContain(SECRET);
  expect(state.domains.some((d: any) => d.hostname == "write.myerga.com")).toBe(true);
  expect(state.routes[Object.keys(state.routes)[0]][0].pattern).toBe("*.ada-pages.net/*");
  expect(state.revoked, "the OAuth token revoked at the end").toBe(1);
  const after = await p.session();
  expect([after.connected, after.run.status]).toEqual([false, "done"]);
});
