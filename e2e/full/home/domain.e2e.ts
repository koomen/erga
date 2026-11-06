// The homepage on a domain of its own (the deploy facts' home: `bun erga deploy <host> --home <domain>`). There, the
// deployed site's files as they are: no bars, no pencil, no viewer, no frame, nothing of Erga's. On the Erga domain,
// / is a small page with Sign in and no link to the site, and the site's files are not served. Here the domain is
// home.localhost, which the browser sends to this machine.
import { request } from "node:http";
import { expect, servers, test } from "../../helpers/fixtures";
import { adminToken, get, home, openHome, publish, redeploy, resetLanding, setLanding, signedOut } from "./home";

const HOME = "home.localhost";
const own = () => servers.of("home-domain", { env: { ERGA_HOME_RECHECK_MS: "0", ERGA_DEPLOY: JSON.stringify({ home: HOME }) } });
await own();
test.afterEach(async () => {
  await resetLanding(await own());
});

const html = (title: string, body = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/style.css"></head><body><h1>${title}</h1>${body}</body></html>`;
const files = {
  "index.html": html("Site home", `<a href="about">About</a><img id="pic" src="img/dot.svg">`),
  "about.html": html("About me"),
  "blog/index.html": html("The blog"),
  "docs.html": html("My docs page"),
  "404.html": html("Lost"),
  "style.css": "h1 { color: rgb(1, 2, 3); }",
  "img/dot.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#123"/></svg>`,
  _redirects: "/old /about\n",
};

/** A request to the home domain (the server at `root`, with the domain in Host: fetch here can't name it). */
const onHome = (root: string, path: string) =>
  new Promise<{ status: number; location: string | null; text: string; csp: string | null }>((done, failed) => {
    const port = new URL(root).port;
    request({ host: "127.0.0.1", port, path, headers: { Host: `${HOME}:${port}` } }, (r) => {
      let text = "";
      r.setEncoding("utf8").on("data", (c: string) => (text += c));
      r.on("end", () =>
        done({
          status: r.statusCode ?? 0,
          location: r.headers.location ?? null,
          text,
          csp: (r.headers["content-security-policy"] as string) ?? null,
        })
      );
    })
      .on("error", failed)
      .end();
  });

/** The site made the homepage and deployed: its server, token and id. */
async function site() {
  const server = await own();
  const token = await adminToken(server);
  const { id } = await publish(server, token, files, { title: "Site home" });
  expect((await setLanding(server, id)).error).toBeUndefined();
  await expect.poll(async () => (await home(server, id)).deploy.state, { timeout: 10_000 }).toBe("deployed");
  return { server, token, id };
}

test("the site's own domain serves its files as they are, at clean addresses, and nothing of Erga's", async () => {
  const { server } = await site();
  const at = (path: string) => onHome(server.root, path);
  const front = await at("/");
  expect(front).toMatchObject({ status: 200, text: files["index.html"] });
  expect(front.csp).toBe("frame-ancestors 'self'");
  expect(await at("/about")).toMatchObject({ status: 200, text: files["about.html"] });
  expect(await at("/blog")).toMatchObject({ status: 301, location: "/blog/" });
  expect(await at("/old")).toMatchObject({ status: 301, location: "/about" });
  expect(await at("/img/dot.svg")).toMatchObject({ status: 200, text: files["img/dot.svg"] });
  // Erga's paths are the site's here.
  expect(await at("/docs")).toMatchObject({ status: 200, text: files["docs.html"] });
  for (const path of ["/api/health", "/_home", "/auth/sign-in", "/mcp"])
    expect(await at(path), path).toMatchObject({ status: 404, text: files["404.html"] });
  expect((await at("/about")).text).not.toContain("ergaLLM");
});

test("on the Erga domain, / is a page with Sign in and no link to the site; the site's files are not there", async ({ tab }) => {
  const { server } = await site();
  const r = await get(server, "/", { headers: signedOut(server) });
  const page = await r.text();
  expect(r.status).toBe(200);
  expect(page).toContain('href="/auth/sign-in?next=%2Fdocs"');
  expect(page).not.toContain(HOME);
  expect(page).not.toContain("Site home");
  expect((await get(server, "/about", { headers: signedOut(server) })).status).toBe(404);
  // Signed in, / is their documents, as before.
  expect((await get(server, "/")).headers.get("location")).toBe("/docs");

  await openHome(tab.page, server.root);
  const button = tab.page.locator("main a.new");
  expect(await button.textContent()).toBe("Sign in");
  expect(await button.isVisible()).toBe(true);
  // One way in: no account corner beside it.
  expect(await tab.page.locator(".erga-account").count()).toBe(0);
});

test("in a browser, the domain shows the deployed site with no bars; a deploy changes it", async ({ tab }) => {
  const { server, token, id } = await site();
  const origin = `http://${HOME}:${new URL(server.root).port}`;
  const p = tab.page;
  await p.goto(`${origin}/`);
  expect(await p.locator("h1").textContent()).toBe("Site home");
  expect(await p.evaluate(() => getComputedStyle(document.querySelector("h1")!).color)).toBe("rgb(1, 2, 3)");
  await expect.poll(() => p.evaluate(() => (document.querySelector("#pic") as HTMLImageElement).naturalWidth)).toBe(4);
  expect(await p.locator("erga-controls, #erga-editor, iframe").count()).toBe(0);
  await Promise.all([p.waitForURL((u) => u.pathname == "/about"), p.click("a")]);
  expect(await p.locator("h1").textContent()).toBe("About me");

  // An edit does not go live; a deploy does.
  await publish(server, token, { "index.html": html("Site home, edited") }, { document: id });
  await p.goto(`${origin}/`);
  expect(await p.locator("h1").textContent()).toBe("Site home");
  expect((await redeploy(server)).error).toBeUndefined();
  await expect
    .poll(async () => {
      await p.goto(`${origin}/`);
      return p.locator("h1").textContent();
    })
    .toBe("Site home, edited");
});
