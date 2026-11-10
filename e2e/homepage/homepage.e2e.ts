// The homepage: a server's one document at /, deployed as a site.
//
// Two servers, because a server has the homepage on a domain of its own or it has not:
//   own    a server of this file's, new as the file starts, with the homepage on its own domain (home.localhost). Its
//          journey goes from the new server on: the homepage from before the project is adopted, then a site is made
//          the homepage, served on its domain, with the page model and its sign-in there, and Erga's domain keeps only
//          a way in.
//   main   the suite's server, with no such domain: there / is the homepage itself. Deploys and their answers, what
//          wins at an address, who may edit, the bars, the picker on /admin/settings, and the homepage made afresh.
// Both journeys change which document is the server's homepage; the main server gets its own back at the end.
import { expect, journey, servers, test, until } from "../helpers/fixtures";
import { runTool } from "../helpers/tools";
import {
  ask,
  docOf,
  events,
  frameOf,
  front,
  get,
  HOME,
  homeOf,
  homeOrigin,
  landingSetting,
  llmStatus,
  makeSite,
  onHome,
  openHome,
  redeploy,
  resetLanding,
  setLanding,
  signedOut,
  siteHome,
  unique,
  write,
} from "./homepage";

const main = await servers.main();
const own = await servers.of("homepage", {
  env: {
    ERGA_AGENT_MODEL: "script",
    ERGA_HOME_RECHECK_MS: "0",
    ERGA_DEPLOY: JSON.stringify({ home: HOME, app: { kind: "domain", hostname: "127.0.0.1" } }),
  },
});

const DOT = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#123"/></svg>`;

journey("the homepage on a domain of its own, from a new server on", () => {
  const html = (title: string, body = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/style.css"></head><body><h1>${title}</h1>${body}</body></html>`;
  const HOME_BODY = `<a href="about">About</a><img id="pic" src="img/dot.svg">`;
  const files = {
    "index.html": html("Site home", HOME_BODY),
    "about.html": html("About me"),
    "blog/index.html": html("The blog"),
    "docs.html": html("My docs page"),
    "404.html": html("Lost"),
    "style.css": "h1 { color: rgb(1, 2, 3); }",
    "img/dot.svg": DOT,
    _redirects: "/old /about\n",
    "essays/essay.html": `<!doctype html><html><head><title>Essay</title><script>window.early = !!window.ergaLLM;</script></head><body><h1>The essay</h1></body></html>`,
    "_erga/x.html": "<h1>Not served</h1>",
  };
  /** The site that is the homepage: its id and address. */
  let site = { id: "", address: "" };
  /** The site's own origin, and its essay's address there. (The runner only lists the steps: it has no server.) */
  const origin = own ? homeOrigin(own) : "";
  const essay = `${origin}/essays/essay`;
  const shared = async (options: Record<string, unknown>) =>
    expect((await runTool(own.root, "share_document", { document: site.id, ...options })).error).toBeUndefined();

  // Pete's bug on production: after the adoption, an admin got "Not shared with you" on /_home. The document's own
  // host still had its old owner, and decided on that.
  test("a server's homepage from before the project (/<admin>/landing) becomes /_home: an admin opens it, with its link and Edit; signed out, anyone views it", async () => {
    const made = await runTool<{ id: string }>(own.root, "create_document", {
      files: { "index.html": "<!doctype html><title>Erga</title><h1>The old homepage</h1>" },
      slug: "landing",
    });
    expect(made.error).toBeUndefined();
    expect((await setLanding(own, made.result!.id)).error).toBeUndefined();
    // The server's first / adopts it (server/documents/landing.ts adoptLanding).
    await front(own);
    const admin = await get(own, "/_home");
    const page = await admin.text();
    expect({ status: admin.status, refused: page.includes("Not shared with you") }).toEqual({ status: 200, refused: false });
    expect(page).toContain('erga-edit-button"');
    // The home page link on /docs goes there.
    expect(await (await get(own, "/docs")).text()).toMatch(
      /class="erga-view-button erga-home-button"[^>]*href="\/_home"|href="\/_home"[^>]*class="erga-view-button erga-home-button"/
    );
    // Signed out, anyone views it. It is the old document, now called "Erga Homepage" (adoptLanding renames it).
    const out = await get(own, "/_home", { headers: signedOut(own) });
    const outText = await out.text();
    const title = /<iframe id="frame"[^>]* title="([^"]*)"/.exec(outText)?.[1];
    expect({ status: out.status, doc: frameOf(outText)?.[1], title }).toEqual({
      status: 200,
      doc: made.result!.id,
      title: "Erga Homepage",
    });
    // The admin edits it, as the editor does: a file written into it.
    await write(own, "/_home", { "index.html": "<!doctype html><title>Erga</title><h1>New</h1>" });
    expect(await (await get(own, `/d/${made.result!.id}/doc/index.html`)).text()).toContain("<h1>New</h1>");
  });

  test("the site's own domain serves its files as they are, at clean addresses, and no page of Erga's", async () => {
    site = await siteHome(own, files);
    const at = (path: string) => onHome(own, path);
    const home = await at("/");
    expect(home).toMatchObject({ status: 200, page: files["index.html"] });
    expect(home.csp).toBe("frame-ancestors 'self'");
    expect(await at("/about")).toMatchObject({ status: 200, page: files["about.html"] });
    expect(await at("/blog")).toMatchObject({ status: 301, location: "/blog/" });
    expect(await at("/old")).toMatchObject({ status: 301, location: "/about" });
    expect(await at("/img/dot.svg")).toMatchObject({ status: 200, text: DOT });
    // Erga's paths are the site's here.
    expect(await at("/docs")).toMatchObject({ status: 200, page: files["docs.html"] });
    for (const path of ["/api/health", "/_home", "/auth/sign-in", "/mcp"])
      expect(await at(path), path).toMatchObject({ status: 404, page: files["404.html"] });
  });

  test("on its own domain, /_erga/ is Erga's: the model for the homepage only, a pass that must be good, nothing else", async () => {
    await shared({ page_llm: true, page_llm_who: "all" });
    const json = { "Content-Type": "application/json", Origin: origin };
    const body = (o: Record<string, unknown>) =>
      JSON.stringify({ messages: [{ role: "user", content: '@script [{"text": "Hi."}]' }], ...o });
    const token = /"(eyJ2Ijp7ImRvYyI6[\w-]+\.[\w-]+)"/.exec((await onHome(own, "/essays/essay")).text)?.[1];
    expect(token).toBeTruthy();
    // The site's files under /_erga/ never answer.
    expect((await onHome(own, "/_erga/x.html")).status).toBe(404);
    expect((await onHome(own, "/_erga/x")).status).toBe(404);
    // A guest, from the page, with its token: answered. From another site, or with no token: no.
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const llm = (o: Record<string, unknown>, headers: Record<string, string> = {}) =>
      onHome(own, "/_erga/api/llm", { method: "POST", headers: { ...json, ...ip, ...headers }, body: body(o) });
    const id = site.id;
    expect(await llm({ document: id, token })).toMatchObject({ status: 200, text: JSON.stringify({ text: "Hi." }) });
    expect((await llm({ document: id, token }, { Origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await llm({ document: id, token }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await llm({ document: id })).status).toBe(403);

    // The pass: the Erga domain gives one to someone signed in there, and sends it to the own domain only.
    const pass = await get(own, "/auth/home-pass?provider=github&next=%2F%2Felsewhere.example");
    const to = new URL(pass.headers.get("location")!);
    expect(to.origin).toBe(origin);
    expect(to.pathname).toBe("/_erga/pass");
    expect(to.searchParams.get("next")).toBe("/");
    // Signed out there: the provider's sign-in first, back to the pass.
    const out = await get(own, "/auth/home-pass?provider=github&next=%2Fessays%2Fessay", { headers: signedOut(own) });
    expect(out.headers.get("location")).toBe(
      `/auth/github?next=${encodeURIComponent("/auth/home-pass?provider=github&next=%2Fessays%2Fessay")}`
    );
    // The own domain sends its sign-in there.
    expect((await onHome(own, "/_erga/auth/github?next=%2Fessays%2Fessay")).location).toBe(
      `${own.root}/auth/home-pass?provider=github&next=%2Fessays%2Fessay`
    );
    // A pass that isn't this server's, or whose claims changed (a later expiry): no cookie.
    const good = to.searchParams.get("pass")!;
    const later = Buffer.from(JSON.stringify({ v: { login: "tester" }, e: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    for (const bad of [good.replace(/\.[\w-]+$/, ".AAAA"), good.replace(/^[\w-]+\./, `${later}.`)]) {
      const r = await onHome(own, `/_erga/pass?pass=${encodeURIComponent(bad)}&next=%2F`);
      expect(r.status).toBe(403);
      expect(r.setCookie).toEqual([]);
    }
    const signedIn = await onHome(own, `${to.pathname}${to.search}`);
    expect(signedIn).toMatchObject({ status: 302, location: "/" });
    const cookie = signedIn.setCookie[0].split(";")[0];
    expect(cookie).toMatch(/^erga_visitor_\d+=/);

    // With the cookie: signed in, for the homepage's model; another document's, never, even one the person may open.
    const status = await onHome(own, `/_erga/api/llm?document=${id}`, { headers: { Cookie: cookie } });
    expect(JSON.parse(status.text)).toMatchObject({ on: true, signedIn: true });
    expect(await llm({ document: id }, { Cookie: cookie })).toMatchObject({ status: 200, text: JSON.stringify({ text: "Hi." }) });
    const other = await runTool<{ id: string }>(own.root, "create_document", { files: { "index.html": "<h1>Other</h1>" } });
    expect((await runTool(own.root, "share_document", { document: other.result!.id, page_llm: true })).error).toBeUndefined();
    expect(await llm({ document: other.result!.id }, { Cookie: cookie })).toMatchObject({ status: 403 });
    // The Erga domain's session never counts here.
    const session = (await get(own, `/api/llm?document=${id}`).then((r) => r.json())) as { signedIn: boolean };
    expect(session.signedIn).toBe(true);
    expect(JSON.parse((await onHome(own, `/_erga/api/llm?document=${id}`)).text)).toMatchObject({ signedIn: false });
  });

  test("in a browser, the domain shows the deployed site with no bars; an edit does not change it, a deploy does", async ({ tab }) => {
    const p = tab.page;
    const heading = () => p.locator("h1").textContent();
    await p.goto(`${origin}/`);
    expect(await heading()).toBe("Site home");
    expect(await p.evaluate(() => getComputedStyle(document.querySelector("h1")!).color)).toBe("rgb(1, 2, 3)");
    await until(() => p.evaluate(() => (document.querySelector("#pic") as HTMLImageElement).naturalWidth == 4), 5_000, "the picture loads");
    expect(await p.locator("erga-controls, #erga-editor, iframe").count()).toBe(0);
    await Promise.all([p.waitForURL((u) => u.pathname == "/about"), p.click("a")]);
    expect(await heading()).toBe("About me");

    await write(own, site.id, { "index.html": html("Site home, edited", HOME_BODY) });
    await p.goto(`${origin}/`);
    expect(await heading()).toBe("Site home");
    expect((await redeploy(own)).error).toBeUndefined();
    await until(
      async () => (await p.goto(`${origin}/`), (await heading()) == "Site home, edited"),
      5_000,
      "the deploy shows on the domain"
    );
  });

  test("on its own domain, the site's pages have ergaLLM; a guest may call it, signing in comes back to the page, and signing out of Erga signs out there", async ({
    tab,
  }) => {
    const p = tab.page;
    await p.goto(essay);
    expect(await p.locator("h1").textContent()).toBe("The essay");
    // Before the page's own scripts.
    expect(await p.evaluate(() => (window as unknown as { early: boolean }).early)).toBe(true);
    expect(await llmStatus(p)).toEqual({ on: true, model: expect.any(String), signedIn: false });
    expect(await ask(p, '@script [{"text": "Hello, guest."}]')).toEqual({ text: "Hello, guest." });

    // Signing in: the dialog's button goes through the Erga domain (signed in there: the dev login) and back here.
    await p.evaluate(() => (window as any).ergaLLM.signIn());
    const button = p.locator("erga-sign-in .provider").first();
    await until(() => button.isVisible(), 5_000, "the sign-in dialog shows");
    expect(await button.getAttribute("href")).toMatch(/^\/_erga\/auth\/\w+\?next=%2Fessays%2Fessay$/);
    await Promise.all([p.waitForURL(essay), button.click()]);
    expect(await p.locator("h1").textContent()).toBe("The essay");
    expect(await llmStatus(p)).toMatchObject({ on: true, signedIn: true });
    expect(await ask(p, '@script [{"text": "Hello, signed in."}]')).toEqual({ text: "Hello, signed in." });
    // The cookie is the own domain's alone.
    const visitor = `erga_visitor_${own.port}`;
    const cookies = await p.context().cookies(origin);
    expect(cookies.map((c) => c.name)).toContain(visitor);
    expect(cookies.find((c) => c.name == visitor)).toMatchObject({ httpOnly: true, sameSite: "Lax" });

    // Signing out of Erga signs out of the own domain too: its cookie goes, on the way back to Erga's /.
    await p.goto(`${own.root}/auth/logout`);
    await p.waitForURL(`${own.root}/`);
    expect((await p.context().cookies(origin)).map((c) => c.name)).not.toContain(visitor);
  });

  test("on the Erga domain, / is a page with Sign in and no link to the site; the site's files are not there", async ({ tab }) => {
    // The tab is on Erga's /, signed out, after the sign-out of the step before.
    const button = tab.page.locator("main a.new");
    expect(await button.textContent()).toBe("Sign in");
    expect(await button.isVisible()).toBe(true);
    // One way in: no account corner beside it.
    expect(await tab.page.locator(".erga-account").count()).toBe(0);
    const r = await get(own, "/", { headers: signedOut(own) });
    const page = await r.text();
    expect(r.status).toBe(200);
    expect(page).toContain('href="/auth/sign-in?next=%2Fdocs"');
    expect(page).not.toContain(HOME);
    expect(page).not.toContain("Site home");
    expect((await get(own, "/about", { headers: signedOut(own) })).status).toBe(404);
    // Signed in, / is their documents, as before.
    expect((await get(own, "/")).headers.get("location")).toBe("/docs");
  });

  test("on its own domain, a homepage for signed-in viewers only asks a guest to sign in, there", async ({ tab }) => {
    await shared({ page_llm_who: "signed_in" });
    const p = tab.page;
    await p.goto(essay);
    expect(await llmStatus(p)).toMatchObject({ on: true, signedIn: false });
    expect((await ask(p, "Hi")).code).toBe("sign_in");
    const button = p.locator("erga-sign-in .provider").first();
    await until(() => button.isVisible(), 5_000, "the sign-in dialog shows");
    expect(await button.getAttribute("href")).toMatch(/^\/_erga\/auth\/\w+\?next=%2Fessays%2Fessay$/);
    await Promise.all([p.waitForURL(essay), button.click()]);
    expect(await ask(p, '@script [{"text": "Hello, signed in."}]')).toEqual({ text: "Hello, signed in." });
  });

  test("the homepage's settings show its domain, a link that opens the site there", async ({ tab }) => {
    const p = tab.page;
    await p.addInitScript(() => {
      if (window.top != window) return;
      try {
        if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
      } catch {
        /* no storage */
      }
    });
    await p.goto(`${own.root}${site.address}?edit`);
    // The gear, once the editor's controls are in (they fade in as it comes up).
    const gear = () =>
      p.evaluate(() => {
        const g = document.getElementById("btn-settings"),
          r = g?.getBoundingClientRect();
        if (!g || !r?.width || getComputedStyle(g.closest(".chrome")!).opacity != "1") return null;
        const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        return document.elementFromPoint(at.x, at.y)?.closest("#btn-settings") == g ? at : null;
      });
    const at = (await until(gear, 10_000, "the gear can be clicked"))!;
    await p.mouse.click(at.x, at.y);
    const note = () => p.evaluate(() => document.getElementById("ds-home-note")?.textContent?.trim() ?? "");
    await until(async () => (await note()) == `Homepage · ${HOME}`, 5_000, "the settings name the domain", note);
    expect(await p.getAttribute("#ds-home-domain", "href")).toBe(`${origin}/`);
    const [there] = await Promise.all([p.context().waitForEvent("page"), p.click("#ds-home-domain")]);
    await until(async () => (await there.locator("h1").textContent()) == "Site home, edited", 5_000, "the site opens on its domain");
    await there.close();
  });
});

journey("the homepage on the Erga domain", () => {
  const html = (title: string, body = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="${body.includes("deep") ? "../../" : body.includes("folder") ? "../" : ""}style.css"></head><body><h1>${title}</h1>${body}</body></html>`;
  /** The site's first page, under a title. */
  const index = (title: string, more = "") => html(title, `<a href="about">About</a>${more}`);
  const files = {
    "index.html": index("Site home"),
    "about.html": html("About me"),
    "blog/index.html": html("The blog", `<p>folder</p><a id="post" href="2026/post">Post</a>`),
    "blog/2026/post.html": html("A post", "<p>deep</p>"),
    "docs.html": html("My docs page"),
    "404.html": html("Lost", "<p>No page here.</p>"),
    "style.css": "h1 { color: rgb(1, 2, 3); }",
    "data.json": `{"ok":"yes"}`,
    _redirects: "/old /about\n",
  };
  let site = { id: "", address: "" };
  /** An address as someone signed out gets it: its status and its text. */
  const out = async (path: string) => {
    const r = await get(main, path, { headers: signedOut(main) });
    return { status: r.status, text: await r.text() };
  };
  const version = async () => (await runTool(main.root, "versions", { document: site.id })).result?.current.n as number;
  /** Once / is the deployed page with this heading. */
  const frontShows = (title: string) =>
    until(
      async () => (await front(main)).html.includes(`<h1>${title}</h1>`),
      5_000,
      `/ shows "${title}"`,
      async () => (await front(main)).html.slice(0, 300)
    );

  test.afterAll(async () => void (await resetLanding(main)));

  test("landing_document makes another document the homepage, deployed at once, and its tabs hear of it", async () => {
    // The homepage until now (the server makes one from assets/landing/ for its first /).
    const before = (await until(async () => docOf((await front(main)).html), 5_000, "/ names its document"))!;
    site = await makeSite(main, files);
    expect(await homeOf(main, site.id)).toEqual({ isHome: false });
    const heard = await events(main, site.id);
    try {
      expect((await setLanding(main, site.id)).error).toBeUndefined();
      const set = await homeOf(main, site.id);
      expect(set).toMatchObject({ isHome: true, canDeploy: true });
      expect(["deploying", "deployed"]).toContain(set.deploy.state);
      expect((await homeOf(main, before)).isHome).toBe(false);
      await frontShows("Site home");
      expect((await front(main)).direct).toBe(true);
      await until(() => heard.of("home").length >= 2, 5_000, "the document's tabs hear of the deploy");
    } finally {
      heard.close();
    }
  });

  test("Deploy answers when the deploy is done, with the new version and the live files' addresses; a failed deploy says why, and the last good one keeps serving; fixed, it deploys again", async () => {
    const before = await version();
    await write(main, site.id, { "index.html": index("Right now"), "data.json": `{"ok":"new"}` });
    const done = (await redeploy(main)).result!;
    // (The write is a version by itself a moment later, or now: the deploy names the version it had.)
    expect(done.deploy.state).toBe("deployed");
    expect([before, await version()]).toContain(done.deploy.version);
    expect(done.live?.url).toBe(`${main.root}/`);
    expect(done.live?.files["data.json"]).toMatch(new RegExp(`^${main.root}/_home-files/[a-z0-9]+/data\\.json$`));
    expect(await (await fetch(done.live!.files["data.json"])).text()).toBe(`{"ok":"new"}`);
    expect((await front(main)).html).toContain("<h1>Right now</h1>");
    const lastAt = (await homeOf(main, site.id)).deploy.at;
    await write(main, site.id, { "index.html": index("Broken", "<!-- erga:test-fail-deploy -->") });
    const failed = (await redeploy(main)).result!;
    expect(failed.deploy.state).toBe("failed");
    expect(failed.live?.files["data.json"]).toBe(done.live?.files["data.json"]);
    const s = await homeOf(main, site.id);
    expect(s.deploy.error).toMatch(/asks for its deploy to fail/);
    expect(s.deploy.at).toBe(lastAt);
    const now = await front(main);
    expect(now.direct).toBe(true);
    expect(now.html).toContain("<h1>Right now</h1>");
    await write(main, site.id, { "index.html": index("Fixed") });
    expect((await redeploy(main)).result!.deploy.state).toBe("deployed");
    await frontShows("Fixed");
  });

  test("on the Erga domain, Erga's pages and its documents win over the site's files", async () => {
    // The site's own address for its document is a page of the site too: the document wins.
    const [, owner, slug] = site.address.split("/");
    await write(main, site.id, { [`${owner}/${slug}.html`]: html("Not the document") });
    expect((await redeploy(main)).result!.deploy.state).toBe("deployed");
    // (The site's other pages are there, at their clean addresses.)
    expect((await out("/about")).text).toContain("<h1>About me</h1>");
    expect((await out("/docs")).text).not.toContain("My docs page");
    const doc = await (await get(main, site.address)).text();
    expect(doc).not.toContain("Not the document");
    expect(doc).toContain('<meta name="erga-doc"');
    // A document's address with nothing there is Erga's too: signed out, it asks to sign in.
    expect((await out(`/${owner}/no-such-document`)).text).not.toContain("<h1>Lost</h1>");
  });

  test("only admins may edit the homepage: no other editors, no deploy from elsewhere, a document that others may edit is not made the homepage, and an ex-admin only views it; the session cookie is HttpOnly", async () => {
    const cookie = (await get(main, "/auth/github?as=Ada")).headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/erga_session(_\d+)?=[^;]+;.*HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // Someone of this test's own, so making them an admin touches no other test.
    const bo = unique("bo");
    const share = async (doc: string, login: string, role: string) =>
      (await runTool(main.root, "share_document", { document: doc, login, role })).error;
    expect((await runTool(main.root, "ls", { document: site.id }, { user: bo })).status).toBe(403);
    await share(site.id, bo, "viewer");
    expect(await homeOf(main, site.id, bo)).toMatchObject({ isHome: true, canDeploy: false });
    expect((await redeploy(main, bo)).status).toBe(403);
    expect(await share(site.id, bo, "editor")).toMatch(/only admins may edit it/);
    expect(await share(site.id, "*", "editor")).toMatch(/only admins may edit it/);
    expect((await redeploy(main, undefined, "https://evil.example")).status).toBe(403);
    // A document someone else may edit can't become the homepage.
    const third = await runTool<{ id: string }>(main.root, "create_document", {
      title: unique("Third "),
      files: { "index.html": "<!doctype html><title>Third</title><h1>Third</h1>" },
    });
    await share(third.result!.id, bo, "editor");
    const refused = await setLanding(main, third.result!.id);
    expect(refused.error).toMatch(/Only admins may edit the homepage/);
    expect(refused.error).toMatch(new RegExp(`${bo} may edit this document`));
    // An admin may be its editor.
    expect((await runTool(main.root, "set_user", { action: "role", login: bo, role: "admin" })).error).toBeUndefined();
    expect(await share(site.id, bo, "editor")).toBeUndefined();
    const canEdit = async () => ((await (await get(main, `/d/${site.id}/api/doc?user=${bo}`)).json()) as { canEdit?: boolean }).canEdit;
    expect(await canEdit()).toBe(true);
    // Made a user again, they only view it. (A server remembers a user for ten seconds at most.)
    expect((await runTool(main.root, "set_user", { action: "role", login: bo, role: "write" })).error).toBeUndefined();
    await until(async () => (await canEdit()) === false, 12_000, "the ex-admin may not edit");
    expect(await (await get(main, `/d/${site.id}?user=${bo}`, { redirect: "follow" })).text()).not.toContain("erga-edit-button");
  });

  test("the page's styles can't reach the controls, nor theirs the page; its files load from the deploy, and at the root, never over the app's", async ({
    tab,
  }) => {
    // A page with everything it can throw at the controls.
    const hostile = `<!doctype html>
<html><head><meta charset="utf-8"><title>Second home</title><link rel="stylesheet" href="style.css">
<style>
  a, div, button, svg, span, img { color: rgb(255, 0, 0) !important; background: rgb(0, 255, 0) !important; width: 300px !important; display: block !important; font-size: 40px !important; }
  erga-controls { display: none !important; position: static !important; opacity: 0 !important; }
  body { transform: translateX(0); }
  .bg { background-image: url(img/dot.svg); }
</style></head>
<body><h1>Second home</h1><a href="about">About</a><div class="erga-view-buttons" id="probe">not a control</div><p class="bg" id="bg">x</p><img id="pic" src="img/dot.svg">
<script>fetch("data.json").then((r) => r.json()).then((d) => { document.body.dataset.data = d.ok; });</script>
</body></html>`;
    await write(main, site.id, { "index.html": hostile, "img/dot.svg": DOT });
    expect((await redeploy(main)).result!.deploy.state).toBe("deployed");
    await frontShows("Second home");
    const p = tab.page;
    await p.setViewportSize({ width: 1200, height: 800 });
    await openHome(p, main);
    await until(() => p.evaluate(() => document.body.dataset.data == "new"), 5_000, "the page's script reads its data file");
    // (The bars take the page's tone once the script has its colour: the icons ease to it.)
    const tone = () =>
      p.evaluate(() => getComputedStyle(document.querySelector("erga-controls")!.shadowRoot!.querySelector(".erga-agent-share")!).color);
    await until(async () => (await tone()) == "rgb(154, 154, 162)", 5_000, "the controls take the page's tone", tone);
    const iso = await p.evaluate(() => {
      const host = document.querySelector("erga-controls")!,
        r = host.shadowRoot!;
      const rect = (e: Element) => {
        const b = e.getBoundingClientRect();
        return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
      };
      return {
        hostShown: getComputedStyle(host).display,
        hostPosition: getComputedStyle(host).position,
        agent: rect(r.querySelector(".erga-agent-share")!),
        account: rect(r.querySelector(".erga-account-btn")!),
        probePosition: getComputedStyle(document.getElementById("probe")!).position,
        h1: getComputedStyle(document.querySelector("h1")!).color,
        bg: getComputedStyle(document.getElementById("bg")!).backgroundImage,
        pic: (document.getElementById("pic") as HTMLImageElement).naturalWidth,
        picSrc: document.getElementById("pic")!.getAttribute("src"),
        css: document.querySelector('link[rel="stylesheet"]')!.getAttribute("href"),
        cookie: document.cookie,
      };
    });
    expect(iso).toMatchObject({ hostShown: "block", hostPosition: "fixed" });
    // Where the viewer has them, signed out: Share with an agent (no Documents), then Sign in.
    expect(iso).toMatchObject({ agent: [1108, 12, 34, 34], account: [1154, 14, 30, 30] });
    expect(iso.probePosition).toBe("static");
    expect(iso.h1).toBe("rgb(1, 2, 3)");
    expect(iso.bg).toMatch(/\/_home-files\/[a-z0-9]+\/img\/dot\.svg/);
    expect(iso.pic).toBe(4);
    expect(iso.css).toMatch(/^\/_home-files\/[a-z0-9]+\/style\.css$/);
    expect(iso.picSrc).toMatch(/^\/_home-files\/[a-z0-9]+\/img\/dot\.svg$/);
    const css = await get(main, iso.css!);
    expect(css.ok).toBe(true);
    expect(css.headers.get("cache-control") ?? "").toMatch(/immutable/);
    expect(await css.text()).toContain("rgb(1, 2, 3)");
    expect(await (await get(main, "/data.json")).text()).toBe(`{"ok":"new"}`);
    // (The app's own files are under /_erga/: a name at the root is the homepage's.)
    expect(await (await get(main, "/style.css")).text()).toContain("rgb(1, 2, 3)");
    expect(iso.cookie).not.toContain("erga_session");
  });

  test("site.json turns the bars off: / has no controls and no room for them; the site's links and folders work", async ({ tab }) => {
    await write(main, site.id, { "site.json": `{"bars": false}`, "index.html": index("Fixed") });
    expect((await redeploy(main)).result!.deploy.state).toBe("deployed");
    const home = await until(
      async () => {
        const f = await front(main);
        return f.html.includes("<h1>Fixed</h1>") && !f.direct ? f : null;
      },
      5_000,
      "/ has no controls"
    );
    expect(home!.html).not.toContain("padding-top");
    // The page's own links work at their clean addresses, and its relative files load from a folder's page.
    const p = tab.page;
    const colour = () => p.evaluate(() => getComputedStyle(document.querySelector("h1")!).color);
    await openHome(p, main);
    await Promise.all([p.waitForURL((u) => u.pathname == "/about"), p.click("a")]);
    expect(await p.locator("h1").textContent()).toBe("About me");
    await p.goto(`${main.root}/blog`);
    expect(new URL(p.url()).pathname).toBe("/blog/");
    await until(async () => (await colour()) == "rgb(1, 2, 3)", 5_000, "the folder's page has the site's style");
    await Promise.all([p.waitForURL((u) => u.pathname == "/blog/2026/post"), p.click("#post")]);
    await until(async () => (await colour()) == "rgb(1, 2, 3)", 5_000, "the post has the site's style");
    await p.context().clearCookies();
  });

  /** A document that the picker finds by its title. */
  const target = { id: "", title: `Picker target ${Math.random().toString(36).slice(2, 8)}` };

  test("the Homepage picker on /admin/settings finds a document by its title as you type; choosing it saves it; Reset undoes it", async ({
    tab,
  }) => {
    const { page } = tab;
    const { title } = target;
    const made = await runTool<{ id: string }>(main.root, "create_document", {
      title,
      files: { "index.html": `<!doctype html><title>${title}</title><h1>${title}</h1>` },
    });
    target.id = made.result!.id;
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${main.root}/admin/settings`);
    const row = 'li.setting[data-key="landing_document"]';
    const text = (sel: string) => page.locator(`${row} ${sel}`).first().textContent();
    expect(await text("label.key")).toBe("Homepage");
    expect(await text(".desc")).toContain("The document or project shown at /");

    // A part of the title, typed: the document shows, with its owner and address, and its kind.
    const find = page.locator(`${row} input.find[role=combobox]`);
    await find.click();
    await find.pressSequentially(title.slice(-10, -1));
    await until(async () => (await page.locator(`${row} [role=option]`).count()) == 1, 5_000, "the picker finds one document");
    expect(await text("[role=option] .title")).toBe(title);
    expect(await text("[role=option] .badge")).toBe("Document");
    const where = (await text("[role=option] .where"))!;
    expect(where).toMatch(/^\S+ · \/\S+\/\S+$/);
    // The list has the shared admin look: below the box, over the page.
    expect(await page.locator(`${row} .found`).evaluate((el) => getComputedStyle(el).position)).toBe("absolute");

    // Chosen with the keys: saved, and the page shows it.
    await find.press("ArrowDown");
    expect(await page.locator(`${row} [role=option]`).getAttribute("aria-selected")).toBe("true");
    await find.press("Enter");
    const chosen = () =>
      page
        .locator(`${row} .meta a.open-doc`)
        .textContent({ timeout: 500 })
        .catch(() => null);
    await until(async () => (await chosen()) == title, 5_000, "the page shows the chosen document");
    expect(await landingSetting(main)).toBe(where.split(" · ")[1]);
    expect(await homeOf(main, target.id)).toMatchObject({ isHome: true });
    expect(await homeOf(main, site.id)).toEqual({ isHome: false });

    // Reset: back to the default (none: the repo's demo page).
    await page.click(`${row} .reset`);
    await page.waitForSelector(`${row} .meta a.open-doc`, { state: "detached" });
    expect(await page.locator(`${row} .reset`).count()).toBe(0);
    expect(await landingSetting(main)).toBe("");
  });

  test("a reset landing_document clears it: the next / makes a fresh homepage from assets/landing/ and deploys it", async () => {
    expect(await homeOf(main, target.id)).toEqual({ isHome: false });
    // The viewer on the new homepage at first, then its deployed page, with Erga's controls.
    const logo = `<h1 class="logo"`;
    await until(
      async () => {
        const f = (await front(main)).html;
        return !f.includes(target.title) && (f.includes(logo) || f.includes('<iframe id="frame"'));
      },
      5_000,
      "/ is a fresh homepage"
    );
    await until(
      async () => {
        const f = await front(main);
        return f.direct && f.html.includes(logo);
      },
      5_000,
      "the fresh homepage is deployed"
    );
    expect(await landingSetting(main)).toBe("/_home");
  });

  test("an admin renames the homepage in the breadcrumb: its address stays /_home, and the title stays after a reload", async ({ tab }) => {
    const page = tab.page;
    const js = <T>(expr: string) => page.evaluate(expr) as Promise<T>;
    /** Clicks the middle of an element, once it shows. */
    const clickOn = async (selector: string) => {
      const at = await until(
        () =>
          js<{ x: number; y: number } | null>(
            `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`
          ),
        5_000,
        `${selector} shows`
      );
      await page.mouse.move(at!.x, at!.y);
      await page.mouse.click(at!.x, at!.y);
    };
    const title = () => js<string>(`document.getElementById("doc-title-text").textContent`);
    /** The editor is up with its title, its tree mounted, and the page in its frame has the focus (a card opened before loses its focus to it). */
    const editorUp = async () => {
      await until(
        () =>
          js(
            `document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title").hidden && !!window.ergaPage && !!window.ergaTree && !!document.querySelector("#pages #pages-tree .et-row[data-path]")`
          ),
        10_000,
        "the editor is up with its title and its tree"
      );
      await until(
        async () => {
          if (await js(`document.activeElement?.id != "frame"`)) return false;
          for (const f of page.frames())
            if (await f.evaluate(`!!window.ergaFrame?.page && document.hasFocus()`).catch(() => false)) return true;
          return false;
        },
        10_000,
        "the page in the editor has the focus"
      );
    };
    const indexRow = `#pages .et-row[data-path="index.html"]`;
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.addInitScript(() => {
      if (window.top != window) return;
      try {
        if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
      } catch {
        /* no storage */
      }
    });
    await page.goto(`${main.root}/_home?edit`);
    await editorUp();
    await clickOn("#doc-title");
    await until(
      () => js(`!document.getElementById("pages").hidden && !!document.querySelector(${JSON.stringify(indexRow)})`),
      5_000,
      "the pages show"
    );
    // index.html is the page at /_home.
    expect(await js<string>(`document.querySelector(${JSON.stringify(`${indexRow} .et-name`)}).getAttribute("href")`)).toBe("/_home?edit");
    await clickOn(indexRow);
    await clickOn(`${indexRow} [data-act="rename"]`);
    await until(
      () => js(`!document.getElementById("naming").hidden && document.activeElement.id == "naming-title"`),
      5_000,
      "the title's card opens"
    );
    // The address is /_home, and it doesn't change: no slug to type in.
    expect(await js<string>(`document.getElementById("naming-prefix").textContent`)).toBe("/_home");
    expect(await js<number>(`document.getElementById("naming-slug").getBoundingClientRect().width`)).toBe(0);
    await page.keyboard.type("Our homepage");
    await page.keyboard.press("Enter");
    await until(() => js(`document.getElementById("naming").hidden`), 5_000, "the title's card closes");
    expect(await js<string>(`document.getElementById("naming-status").textContent`)).not.toMatch(/can't/);
    await until(async () => (await title()) == "Our homepage", 5_000, "the breadcrumb has the new title", title);
    expect(new URL(page.url()).pathname).toBe("/_home");
    await page.reload();
    await until(async () => (await title().catch(() => "")) == "Our homepage", 10_000, "the title stays after a reload");
    await editorUp();
    await clickOn("#doc-title");
    const name = () => js<string | undefined>(`document.querySelector(${JSON.stringify(`${indexRow} .et-name`)})?.textContent`);
    await until(async () => (await name()) == "Our homepage", 5_000, "the pages name the homepage by its title", name);
  });

  test("signed out, / has Clone and Sign in with its menu, and no Edit", async ({ tab }) => {
    const p = tab.page;
    await openHome(p, main);
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
    await p.evaluate(() =>
      (document.querySelector("erga-controls")!.shadowRoot!.querySelector(".erga-account-btn") as HTMLElement).click()
    );
    expect(await menuHidden()).toBe(false);
    await p.mouse.click(600, 500);
    expect(await menuHidden()).toBe(true);
  });

  test("someone who isn't an admin sees the homepage project with Clone, without Edit, which an admin has; /new?from=landing copies it", async () => {
    const id = docOf((await front(main)).html);
    const ada = await (await get(main, "/_home?user=Ada")).text();
    expect(docOf(ada)).toBe(id);
    expect(ada).not.toContain("erga-edit-button");
    expect(ada).toContain("erga-new-clone");
    // Edit is for an admin (the dev server's own person).
    expect(await (await get(main, "/_home")).text()).toContain('erga-edit-button"');
    const made = await get(main, "/new?from=landing");
    expect(made.status).toBe(302);
    expect(made.headers.get("location") ?? "").toMatch(/^\/tester\/.+?edit$/);
  });
});
