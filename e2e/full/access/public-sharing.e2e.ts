// "Users can share content publicly", the Access page's switch (/admin/access), end to end on a server of this file's
// own (it changes the whole server). On: a document shared with anyone with the link opens for people who aren't
// signed in, as viewers. Off: the share menu doesn't offer anyone with the link, a new such share is refused saying
// why, and those made before stay but open for nobody signed out, until it's on again. The homepage is public either
// way. Local development starts with it on (a server starts with it off). The admin is DEV_LOGIN ("tester").
import { expect, servers, test, until } from "../../helpers/fixtures";
import { newDoc } from "./access";

const server = () => servers.of("public-sharing");
await server();

test("on: anyone with the link opens for people signed out; off: not offered, refused, kept but closed; on again: open", async ({ tab }) => {
  const page = tab.page, root = (await server()).root;
  const port = new URL(root).port;
  // Someone not signed in: locally, a browser that signed out.
  const signedOut = (path: string) =>
    fetch(root + path, { redirect: "manual", headers: { Cookie: `erga_signed_out_${port}=1`, Accept: "text/html" } });
  const share = (id: string, role: string) =>
    page.evaluate(
      async ([id, role]) => {
        const r = await fetch("/api/tools/share_document", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document: id, login: "*", role }),
        });
    return { status: r.status, body: await r.json() };
  }, [id, role]);
  const setPublic = async (on: boolean) => {
    await page.goto(`${root}/admin/access?user=tester`);
    await page.evaluate(() => { window.confirm = () => true; });
    if ((await page.isChecked("#public-sharing")) != on) await page.evaluate(() => document.querySelector<HTMLInputElement>("#public-sharing")!.click());
    await until(async () => (await page.textContent("#public-hint")) == "Saved.", 5000, `public sharing ${on ? "on" : "off"}`);
  };

  const shared = await newDoc(root), unshared = await newDoc(root);
  const address = shared.at.replace(/[?&]edit=?$/, "");
  await page.goto(`${root}/docs`);
  expect((await share(shared.id, "viewer")).status).toBe(200);
  // On: it opens for someone signed out.
  let r = await signedOut(new URL(address, root).pathname);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("erga-pages");
  // Off.
  await setPublic(false);
  r = await signedOut(new URL(address, root).pathname);
  expect(r.status).toBe(302);
  expect(r.headers.get("location")?.startsWith("/auth/sign-in")).toBe(true);
  // A new share with anyone with the link: refused, saying why.
  await page.goto(`${root}/docs`);
  const refused = await share(unshared.id, "viewer");
  expect(refused.status).toBe(403);
  expect(refused.body.error).toContain("doesn't let users share content publicly");
  // The share menu doesn't offer it for a document without one; for the one shared before, it shows, kept, to stop.
  await page.click(`button.share[data-id="${unshared.id}"]`);
  await until(async () => (await page.textContent("#share-hint")) == "", 5000, "the share dialog loaded");
  expect(await page.isVisible("#share .anyone")).toBe(false);
  await page.keyboard.press("Escape");
  await page.click(`button.share[data-id="${shared.id}"]`);
  await until(async () => (await page.inputValue("#share-anyone")) == "viewer", 5000, "the kept share shows");
  expect(await page.textContent("#share-anyone-note")).toContain("Public sharing is off");
  await page.keyboard.press("Escape");
  // The homepage stays public.
  expect((await signedOut("/")).status).toBe(200);
  // On again: the kept share opens for people signed out again.
  await setPublic(true);
  expect((await signedOut(new URL(address, root).pathname)).status).toBe(200);
});
