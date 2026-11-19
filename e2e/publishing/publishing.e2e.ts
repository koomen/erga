// Publishing: a document's version on a domain.
//
// Two servers, because a server has custom domains or it has not:
//   own    a server of this file's, new as the file starts, with two custom domains (site.localhost, blog.localhost).
//          Its journey goes from the new server on: nothing at /, the default homepage that the deploy's step makes and
//          publishes, a document published to a custom domain from its settings, the page model and its sign-in there,
//          a domain that another document has, "Not published", and an editor who is not an admin.
//   main   the suite's server, with the Erga domain alone, where the default homepage is published. A document takes
//          the domain, publishes and fails, what wins at an address, who may publish, the header bar, and the default
//          homepage's own address.
// The main journey changes which document the Erga domain has; the default homepage gets it back at the end.
import type { Page } from "playwright-core";
import { agentClosed, expect, journey, servers, test, until } from "../helpers/fixtures";
import { pressOn } from "../helpers/press";
import { deployHome } from "../helpers/server";
import { runTool } from "../helpers/tools";
import {
  ask,
  BLOG,
  docOf,
  ergaOf,
  events,
  frameOf,
  front,
  get,
  homeAgain,
  llmStatus,
  makeSite,
  onDomain,
  openRoot,
  originOf,
  publish,
  publishedSite,
  publishingOf,
  setPublishing,
  signedOut,
  SITE,
  unique,
  write,
} from "./publishing";

const main = await servers.main();
const own = await servers.of("publishing", {
  env: {
    ERGA_AGENT_MODEL: "script",
    ERGA_SITE_RECHECK_MS: "0",
    ERGA_DEPLOY: JSON.stringify({ domains: [SITE, BLOG], app: { kind: "domain", hostname: "127.0.0.1" } }),
  },
});

const DOT = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#123"/></svg>`;

/** Opens a document's settings in the editor, with the gear, once the editor's controls are in (they fade in as it comes up). */
async function openSettings(p: Page, at: string) {
  await agentClosed(p);
  await p.goto(at);
  const gear = () =>
    p.evaluate(() => {
      const g = document.getElementById("btn-settings"),
        r = g?.getBoundingClientRect();
      if (!g || !r?.width || getComputedStyle(g.closest(".chrome")!).opacity != "1") return null;
      const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      return document.elementFromPoint(at.x, at.y)?.closest("#btn-settings") == g ? at : null;
    });
  await until(gear, 10_000, "the gear can be clicked");
  await pressOn(p, "#btn-settings");
  // (=== false: the section is there, and shows. Before it is there, hidden is undefined.)
  await until(() => p.evaluate(() => document.getElementById("ds-pub")?.hidden === false), 5_000, "the settings show Publishing");
}
/** The Publishing section, as the person reads it. */
const section = (p: Page) =>
  p.evaluate(() => {
    const $ = (id: string) => document.getElementById(id)!;
    const off = (id: string) => $(id).getAttribute("aria-disabled") == "true";
    return {
      to: $("ds-pub-domain").textContent!.trim(),
      toOff: off("ds-pub-domain"),
      menu: $("ds-pub-menu").hidden
        ? null
        : [...$("ds-pub-menu").querySelectorAll("li")].map((li) => [...li.children].map((c) => c.textContent).join(" | ")),
      ask: $("ds-pub-confirm").hidden ? null : $("ds-pub-ask").textContent,
      bars: [($("ds-bars-on") as HTMLInputElement).checked, ($("ds-bars-on") as HTMLInputElement).disabled],
      barsTip: $("ds-bars").dataset.tip ?? "",
      name: $("ds-pub-name").textContent,
      status: $("ds-status").textContent!.trim(),
      publish: [$("ds-publish").textContent, off("ds-publish"), $("ds-publish").classList.contains("newer")],
      publishTip: $("ds-publish").dataset.tip ?? "",
      tags: [...document.querySelectorAll("#ds-list .ds-tag")].map((t) => t.textContent),
    };
  });
/**
 * Once the section rests at `name` (the domain's, or "Not published"): its change's call has answered, so Publish is
 * not locked by it. (The section also hears of the change from the server, which may come first.)
 */
const rests = (p: Page, name: string) =>
  until(
    async () => {
      const s = await section(p);
      return s.name == name && s.ask == null && (name == "Not published" || !s.publish[1]) ? s : null;
    },
    5_000,
    `the section rests at ${name}`,
    () => section(p)
  );

/**
 * "Publish to", with real keys: the menu opens, the arrows go `down` rows from the chosen one, and Enter chooses.
 * It is grey while a change's call runs (the section may show the change before that call answers): a press then does nothing.
 */
async function choose(p: Page, down: number) {
  await until(async () => !(await section(p)).toOff, 5_000, "Publish to can be pressed");
  await pressOn(p, "#ds-pub-domain");
  await until(async () => (await section(p)).menu != null, 5_000, "the menu opens");
  for (let i = 0; i < Math.abs(down); i++) await p.keyboard.press(down > 0 ? "ArrowDown" : "ArrowUp");
  await p.keyboard.press("Enter");
}

journey("custom domains, from a new server on", () => {
  const html = (title: string, body = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/style.css"></head><body><h1>${title}</h1>${body}</body></html>`;
  const HOME_BODY = `<a href="about">About</a><img id="pic" src="img/dot.svg">`;
  const files = {
    "index.html": html("Site home", HOME_BODY),
    "about.html": html("About me"),
    "blog/index.html": html("The blog", `<script type="module" src="/erga/steps/editor.js"></script>`),
    "docs.html": html("My docs page"),
    "404.html": html("Lost"),
    "style.css": "h1 { color: rgb(1, 2, 3); }",
    "img/dot.svg": DOT,
    _redirects: "/old /about\n",
    "essays/essay.html": `<!doctype html><html><head><title>Essay</title><script>window.early = !!window.ergaLLM;</script></head><body><h1>The essay</h1></body></html>`,
    "_erga/x.html": "<h1>Not served</h1>",
  };
  /** The site published to site.localhost: its id, address and title. */
  let site = { id: "", address: "", title: "" };
  /** The custom domain's origin, and its essay's address there. (The runner only lists the steps: it has no server.) */
  const origin = own ? originOf(own, SITE) : "";
  const essay = `${origin}/essays/essay`;
  const erga = own ? ergaOf(own) : "";
  const at = (path: string, o?: Parameters<typeof onDomain>[3]) => onDomain(own, SITE, path, o);
  const shared = async (options: Record<string, unknown>) =>
    expect((await runTool(own.root, "share_document", { document: site.id, ...options })).error).toBeUndefined();
  /** Nothing: a 404 with no body. */
  const NOTHING = { status: 404, text: "" };

  test("a new server answers with nothing; the deploy's step makes the default homepage and publishes it one time; Not published stays so after the next deploy", async () => {
    // Nothing is published anywhere: no page, and no text of Erga's. Signed out, /documents sends to the sign-in.
    expect(await front(own)).toMatchObject({ status: 404, html: "" });
    expect(await at("/")).toMatchObject(NOTHING);
    expect(await at("/_erga/api/llm?document=abcdefgh")).toMatchObject(NOTHING);
    expect((await get(own, "/documents", { headers: signedOut(own) })).headers.get("location")).toBe("/auth/sign-in?next=%2Fdocuments");
    expect((await get(own, "/_home")).status).toBe(404);
    // The deploy's step: the default homepage, at /_home, published to the Erga domain with Erga's header bar.
    await deployHome(own);
    const home = await until(
      async () => {
        const f = await front(own);
        return f.controls ? f : null;
      },
      10_000,
      "/ is the default homepage"
    );
    const id = docOf(home!.html)!;
    const first = (await publishingOf(own, id))!;
    expect(first).toMatchObject({ domain: erga, bars: true, state: "published", canPublish: true });
    // The next deploy asks again: nothing is published again.
    await deployHome(own);
    expect((await publishingOf(own, id))!.at).toBe(first.at);
    // An admin opens it at /_home, with Edit; the home page link on /documents goes there; signed out, anyone views it.
    const admin = await (await get(own, "/_home")).text();
    expect([frameOf(admin), admin.includes('erga-edit-button"')]).toEqual([id, true]);
    expect(await (await get(own, "/documents")).text()).toMatch(
      /class="erga-view-button erga-home-button"[^>]*href="\/_home"|href="\/_home"[^>]*class="erga-view-button erga-home-button"/
    );
    expect(frameOf(await (await get(own, "/_home", { headers: signedOut(own) })).text())).toBe(id);
    // "Not published": / answers with nothing at once, and the next deploy leaves it so. The document stays.
    expect((await setPublishing(own, "/_home", { domain: "" })).error).toBeUndefined();
    expect(await front(own)).toMatchObject({ status: 404, html: "" });
    await deployHome(own);
    expect(await front(own)).toMatchObject({ status: 404, html: "" });
    expect((await get(own, "/_home")).status).toBe(200);
    // Signed in, / is their documents.
    expect((await get(own, "/")).headers.get("location")).toBe("/documents");
  });

  test("Document settings, with real keys: Publish to starts at Not published, lists the domains, and Publish puts the document on a custom domain, where the header bar is off", async ({
    tab,
  }) => {
    const p = tab.page;
    site = await makeSite(own, files);
    await openSettings(p, `${own.root}${site.address}?edit`);
    expect(await section(p)).toMatchObject({
      to: "Not published",
      bars: [false, true],
      name: "Not published",
      status: "Choose a domain to publish",
      publish: ["Publish", true, false],
    });
    // The menu: "Not published", then the Erga domain and the deploy's domains, each with the document that has it, or Free.
    await pressOn(p, "#ds-pub-domain");
    await until(async () => (await section(p)).menu != null, 5_000, "the menu opens");
    expect((await section(p)).menu).toEqual(["Not published", `${erga} | Free`, `${SITE} | Free`, `${BLOG} | Free`]);
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("Enter");
    // Linked, and not published yet: the domain serves nothing. The header bar works only on the Erga domain.
    expect(await rests(p, SITE)).toMatchObject({
      to: SITE,
      menu: null,
      bars: [false, true],
      barsTip: `The Erga header bar can only be shown on ${erga}`,
      status: "Not published yet",
      publish: ["Publish", false, true],
      tags: [],
    });
    expect(await at("/")).toMatchObject(NOTHING);
    await pressOn(p, "#ds-publish");
    await until(
      async () => {
        const s = await section(p);
        return /^Published .+ · version \d+$/.test(s.status) && !s.publish[1] && !s.publish[2] && s.tags.join() == "Published";
      },
      5_000,
      "the publish is done, and the version has its tag",
      () => section(p)
    );

    // The domain serves the site's files as they are, at clean addresses, and no page of Erga's.
    const home = await at("/");
    expect(home).toMatchObject({ status: 200, page: files["index.html"] });
    expect(home.csp).toBe("frame-ancestors 'self'");
    expect(await at("/about")).toMatchObject({ status: 200, page: files["about.html"] });
    expect(await at("/blog")).toMatchObject({ status: 301, location: "/blog/" });
    // Only a library of Erga's that a page imports (/erga/<name>/editor.js) is named anew: it is on the Erga domain.
    expect((await at("/blog/")).page).toContain(`<script type="module" src="${own.root}/erga/steps/editor.js"></script>`);
    expect(await at("/old")).toMatchObject({ status: 301, location: "/about" });
    expect(await at("/img/dot.svg")).toMatchObject({ status: 200, text: DOT });
    // Erga's paths are the site's here.
    expect(await at("/docs")).toMatchObject({ status: 200, page: files["docs.html"] });
    for (const path of ["/api/health", "/_home", "/auth/sign-in", "/mcp"])
      expect(await at(path), path).toMatchObject({ status: 404, page: files["404.html"] });
    // The other custom domain, and the Erga domain, have nothing of it.
    expect(await onDomain(own, BLOG, "/")).toMatchObject(NOTHING);
    expect((await front(own, "/about")).status).toBe(404);
  });

  test("on a custom domain, /_erga/ is Erga's: the model for the document it serves only, a pass that must be good, nothing else", async () => {
    await shared({ page_llm: true, page_llm_who: "all" });
    const json = { "Content-Type": "application/json", Origin: origin };
    const body = (o: Record<string, unknown>) =>
      JSON.stringify({ messages: [{ role: "user", content: '@script [{"text": "Hi."}]' }], ...o });
    const token = /"(eyJ2Ijp7ImRvYyI6[\w-]+\.[\w-]+)"/.exec((await at("/essays/essay")).text)?.[1];
    expect(token).toBeTruthy();
    // The site's files under /_erga/ never answer.
    expect((await at("/_erga/x.html")).status).toBe(404);
    expect((await at("/_erga/x")).status).toBe(404);
    // A guest, from the page, with its token: answered. From another site, or with no token: no.
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const llm = (o: Record<string, unknown>, headers: Record<string, string> = {}) =>
      at("/_erga/api/llm", { method: "POST", headers: { ...json, ...ip, ...headers }, body: body(o) });
    const id = site.id;
    expect(await llm({ document: id, token })).toMatchObject({ status: 200, text: JSON.stringify({ text: "Hi." }) });
    expect((await llm({ document: id, token }, { Origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await llm({ document: id, token }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await llm({ document: id })).status).toBe(403);

    // The pass: the Erga domain gives one to someone signed in there, and sends it to a domain of the deploy's only.
    const pass = await get(own, `/auth/domain-pass?domain=${SITE}&provider=github&next=%2F%2Felsewhere.example`);
    const to = new URL(pass.headers.get("location")!);
    expect(to.origin).toBe(origin);
    expect(to.pathname).toBe("/_erga/pass");
    expect(to.searchParams.get("next")).toBe("/");
    expect((await get(own, "/auth/domain-pass?domain=elsewhere.example&provider=github&next=%2F")).status).toBe(404);
    // Signed out there: the provider's sign-in first, back to the pass.
    const ask = `/auth/domain-pass?domain=${SITE}&provider=github&next=%2Fessays%2Fessay`;
    const out = await get(own, ask, { headers: signedOut(own) });
    expect(out.headers.get("location")).toBe(`/auth/github?next=${encodeURIComponent(ask)}`);
    // The custom domain sends its sign-in there.
    expect((await at("/_erga/auth/github?next=%2Fessays%2Fessay")).location).toBe(`${own.root}${ask}`);
    // A pass that isn't this server's, whose claims changed (a later expiry), or that is another domain's: no cookie.
    const good = to.searchParams.get("pass")!;
    const later = Buffer.from(JSON.stringify({ v: { login: "tester", domain: SITE }, e: Math.floor(Date.now() / 1000) + 3600 })).toString(
      "base64url"
    );
    for (const bad of [good.replace(/\.[\w-]+$/, ".AAAA"), good.replace(/^[\w-]+\./, `${later}.`)]) {
      const r = await at(`/_erga/pass?pass=${encodeURIComponent(bad)}&next=%2F`);
      expect(r.status).toBe(403);
      expect(r.setCookie).toEqual([]);
    }
    const signedIn = await at(`${to.pathname}${to.search}`);
    expect(signedIn).toMatchObject({ status: 302, location: "/" });
    const cookie = signedIn.setCookie[0].split(";")[0];
    expect(cookie).toMatch(/^erga_visitor_\d+=/);

    // With the cookie: signed in, for the model of the document the domain serves; another document's, never, even one
    // the person may open.
    const status = await at(`/_erga/api/llm?document=${id}`, { headers: { Cookie: cookie } });
    expect(JSON.parse(status.text)).toMatchObject({ on: true, signedIn: true });
    expect(await llm({ document: id }, { Cookie: cookie })).toMatchObject({ status: 200, text: JSON.stringify({ text: "Hi." }) });
    const other = await runTool<{ id: string }>(own.root, "create_document", { files: { "index.html": "<h1>Other</h1>" } });
    expect((await runTool(own.root, "share_document", { document: other.result!.id, page_llm: true })).error).toBeUndefined();
    expect(await llm({ document: other.result!.id }, { Cookie: cookie })).toMatchObject({ status: 403 });
    // The Erga domain's session never counts here.
    const session = (await get(own, `/api/llm?document=${id}`).then((r) => r.json())) as { signedIn: boolean };
    expect(session.signedIn).toBe(true);
    expect(JSON.parse((await at(`/_erga/api/llm?document=${id}`)).text)).toMatchObject({ signedIn: false });
  });

  test("in a browser, the domain shows the published site with no bars; an edit does not change it, a publish does", async ({ tab }) => {
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
    const done = (await publish(own, site.id)).result!;
    expect(done.publishing.state).toBe("published");
    // Its files are live at their clean addresses there.
    expect(done.live).toMatchObject({ url: `${origin}/`, files: { "about.html": `${origin}/about.html` } });
    await until(
      async () => (await p.goto(`${origin}/`), (await heading()) == "Site home, edited"),
      5_000,
      "the publish shows on the domain"
    );
  });

  test("on a custom domain, the site's pages have ergaLLM; a guest may call it, signing in comes back to the page, and signing out of Erga signs out there", async ({
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
    // The cookie is the custom domain's alone.
    const visitor = `erga_visitor_${own.port}`;
    const cookies = await p.context().cookies(origin);
    expect(cookies.map((c) => c.name)).toContain(visitor);
    expect(cookies.find((c) => c.name == visitor)).toMatchObject({ httpOnly: true, sameSite: "Lax" });

    // Signing out of Erga signs out of each custom domain too (also one with nothing published): the cookie goes, on
    // the way back to Erga's /, which has nothing published and answers with nothing.
    await p.goto(`${own.root}/auth/logout`);
    await p.waitForURL(`${own.root}/`);
    expect(await front(own)).toMatchObject({ status: 404, html: "" });
    expect((await p.context().cookies(origin)).map((c) => c.name)).not.toContain(visitor);
  });

  test("on a custom domain, a site for signed-in viewers only asks a guest to sign in, there", async ({ tab }) => {
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

  test("a domain that another document has: the panel asks first; the old site serves until the new document is published; Not published asks, and takes the site away at once", async ({
    tab,
  }) => {
    const p = tab.page;
    const other = await makeSite(own, { "index.html": html("The other site") });
    await openSettings(p, `${own.root}${other.address}?edit`);
    // The menu names the document that has the domain.
    await choose(p, 2);
    const asked = `${site.title} is currently published to ${SITE}. Link this document instead? Visitors will see ${site.title} until this document is published.`;
    await until(
      async () => (await section(p)).ask == asked,
      5_000,
      "the panel asks",
      () => section(p)
    );
    // Cancel: nothing changed.
    await pressOn(p, "#ds-pub-cancel");
    expect(await section(p)).toMatchObject({ to: "Not published", ask: null });
    expect((await publishingOf(own, site.id))!.domain).toBe(SITE);
    // Link this document: the first document is unlinked, and its site still serves.
    await choose(p, 2);
    await until(async () => (await section(p)).ask == asked, 5_000, "the panel asks again");
    await pressOn(p, "#ds-pub-ok");
    expect(await rests(p, SITE)).toMatchObject({ status: "Not published yet", publish: ["Publish", false, true] });
    expect((await publishingOf(own, site.id))!).toMatchObject({ domain: null, state: "free", version: null });
    expect((await at("/")).page).toContain("<h1>Site home, edited</h1>");
    // Publish: the domain serves the new document.
    await pressOn(p, "#ds-publish");
    await until(async () => (await at("/")).page.includes("<h1>The other site</h1>"), 5_000, "the domain serves the new document");
    await until(
      async () => (await section(p)).tags.includes("Published"),
      5_000,
      "the version is tagged",
      () => section(p)
    );
    // The Sites row of /admin/documents shows the same links, each to its document, and no control.
    const row = /<li class="sites"[^]*?<\/li>/.exec(await (await get(own, "/admin/documents")).text())![0];
    const lines = [...row.matchAll(/<tr data-domain="[^"]*">([^]*?)<\/tr>/g)].map((m) =>
      m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    expect(lines).toEqual([`${erga} Free`, expect.stringMatching(new RegExp(`^${SITE} ${other.title} Published v\\d+$`)), `${BLOG} Free`]);
    expect(row).toContain(`href="${other.address}"`);
    expect(row).not.toMatch(/<(input|button|select)/);

    // Not published: the panel asks, and after Unpublish the domain answers with nothing at once, and is free.
    await choose(p, -2);
    await until(
      async () => (await section(p)).ask == `Confirm you want to unpublish ${SITE}?`,
      5_000,
      "the panel asks",
      () => section(p)
    );
    expect((await at("/")).status).toBe(200);
    await pressOn(p, "#ds-pub-ok");
    await rests(p, "Not published");
    expect(await at("/")).toMatchObject(NOTHING);
    expect(await at("/_erga/api/llm?document=abcdefgh")).toMatchObject(NOTHING);
    expect((await publishingOf(own, other.id))!.domains.map((d) => d.document)).toEqual([null, null, null]);
  });

  test("an editor who is not an admin sees the publishing, and every control is grey, with a tip that says why", async ({ tab }) => {
    const p = tab.page;
    const bo = unique("bo");
    expect((await runTool(own.root, "share_document", { document: site.id, login: bo, role: "editor" })).error).toBeUndefined();
    expect((await setPublishing(own, site.id, { domain: erga })).error).toBeUndefined();
    expect((await publish(own, site.id)).result?.publishing.state).toBe("published");
    await openSettings(p, `${own.root}${site.address}?edit&user=${bo}`);
    expect(await section(p)).toMatchObject({
      to: erga,
      toOff: true,
      bars: [true, true],
      barsTip: "Only an admin can publish.",
      name: erga,
    });
    expect(await section(p)).toMatchObject({ publish: ["Publish", true, false], publishTip: "Only an admin can publish." });
    expect((await section(p)).status).toMatch(/^Published .+ · version \d+$/);
    // A click opens no menu, and the operations refuse them.
    await pressOn(p, "#ds-pub-domain");
    expect((await section(p)).menu).toBeNull();
    expect((await setPublishing(own, site.id, { domain: "" }, bo)).status).toBe(403);
    expect((await publish(own, site.id, bo)).status).toBe(403);
    // They edit the document all the same: nothing of it is live before an admin publishes.
    expect(
      (await runTool(own.root, "write", { document: site.id, files: { "index.html": html("By Bo") } }, { user: bo })).error
    ).toBeUndefined();
    expect((await front(own)).html).not.toContain("By Bo");
    expect((await publish(own, site.id)).result?.publishing.state).toBe("published");
    expect((await front(own)).html).toContain("<h1>By Bo</h1>");
  });
});

journey("the Erga domain", () => {
  const html = (title: string, body = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="${body.includes("deep") ? "../../" : body.includes("folder") ? "../" : ""}style.css"></head><body><h1>${title}</h1>${body}</body></html>`;
  /** The site's first page, under a title. */
  const index = (title: string, more = "") => html(title, `<a href="about">About</a>${more}`);
  const files = {
    "index.html": index("Site home"),
    "about.html": html("About me"),
    "blog/index.html": html("The blog", `<p>folder</p><a id="post" href="2026/post">Post</a>`),
    "blog/2026/post.html": html("A post", "<p>deep</p>"),
    // Its own header, with a link at its top right, as erga.dev/docs has.
    "docs.html": `<!doctype html><html><head><meta charset="utf-8"><title>Docs</title></head><body style="margin:0"><header style="display:flex;justify-content:space-between;padding:20px 16px"><b>Site</b><a id="try" href="/new">Try it out</a></header><h1>My docs page</h1></body></html>`,
    "404.html": html("Lost", "<p>No page here.</p>"),
    "style.css": "h1 { color: rgb(1, 2, 3); }",
    "data.json": `{"ok":"yes"}`,
    _redirects: "/old /about\n",
  };
  let site = { id: "", address: "", title: "" };
  const erga = main ? ergaOf(main) : "";
  /** An address as someone signed out gets it: its status and its text. */
  const out = async (path: string) => {
    const f = await front(main, path);
    return { status: f.status, text: f.html };
  };
  const version = async () => (await runTool(main.root, "versions", { document: site.id })).result?.current.n as number;
  /** Once / is the published page with this heading. */
  const frontShows = (title: string) =>
    until(
      async () => (await front(main)).html.includes(`<h1>${title}</h1>`),
      5_000,
      `/ shows "${title}"`,
      async () => (await front(main)).html.slice(0, 300)
    );

  test.afterAll(async () => void (await homeAgain(main)));

  test("a document takes the Erga domain only with replace; the default homepage serves until the publish; the document's tabs hear of it", async () => {
    // The Erga domain's document until now: the default homepage, which the deploy's step made and published.
    const before = (await until(async () => docOf((await front(main)).html), 5_000, "/ names its document"))!;
    site = await makeSite(main, files);
    expect(await publishingOf(main, site.id)).toMatchObject({
      domain: null,
      state: "free",
      domains: [{ domain: erga, erga: true, document: { id: before } }],
    });
    const heard = await events(main, site.id);
    try {
      // Another document has the domain: refused, with its name. An agent asks its user, then sends replace.
      const refused = await setPublishing(main, site.id, { domain: erga });
      expect([refused.status, refused.error]).toEqual([409, expect.stringMatching(/\(\/_home\) is published to .+ replace: true/)]);
      expect((await setPublishing(main, site.id, { domain: "elsewhere.example" })).error).toMatch(/has no domain elsewhere\.example/);
      const linked = (await setPublishing(main, site.id, { domain: erga, replace: true })).result!.publishing;
      // Linked, with the header bar on at first; the default homepage is unlinked, and still what / serves.
      expect(linked).toMatchObject({ domain: erga, bars: true, state: "linked", version: null, serving: true });
      expect((await publishingOf(main, before))!.domain).toBeNull();
      expect(docOf((await front(main)).html)).toBe(before);
      expect((await publish(main, site.id)).result!.publishing.state).toBe("published");
      await frontShows("Site home");
      expect((await front(main)).controls).toBe(true);
      await until(() => heard.of("publishing").length >= 2, 5_000, "the document's tabs hear of the publish");
    } finally {
      heard.close();
    }
  });

  test("Publish answers when the publish is done, with the new version and the live files' addresses; a failed publish says why, and the last good one keeps serving; fixed, it publishes again", async () => {
    const before = await version();
    await write(main, site.id, { "index.html": index("Right now"), "data.json": `{"ok":"new"}` });
    const done = (await publish(main, site.id)).result!;
    // (The write is a version by itself a moment later, or now: the publish names the version it had.)
    expect(done.publishing.state).toBe("published");
    expect([before, await version()]).toContain(done.publishing.version);
    expect(done.live?.url).toBe(`${main.root}/`);
    expect(done.live?.files["data.json"]).toMatch(new RegExp(`^${main.root}/_home-files/[a-z0-9]+/data\\.json$`));
    expect(await (await fetch(done.live!.files["data.json"])).text()).toBe(`{"ok":"new"}`);
    expect((await front(main)).html).toContain("<h1>Right now</h1>");
    const lastAt = done.publishing.at;
    await write(main, site.id, { "index.html": index("Broken", "<!-- erga:test-fail-publish -->") });
    const failed = (await publish(main, site.id)).result!;
    expect(failed.publishing).toMatchObject({ state: "failed", at: lastAt });
    expect(failed.publishing.error).toMatch(/asks for its publish to fail/);
    expect(failed.live?.files["data.json"]).toBe(done.live?.files["data.json"]);
    expect(await front(main)).toMatchObject({ controls: true, html: expect.stringContaining("<h1>Right now</h1>") });
    await write(main, site.id, { "index.html": index("Fixed") });
    expect((await publish(main, site.id)).result!.publishing.state).toBe("published");
    await frontShows("Fixed");
  });

  test("on the Erga domain, Erga's pages and its documents win over the site's files", async () => {
    // The site's own address for its document is a page of the site too: the document wins.
    const [, owner, slug] = site.address.split("/");
    await write(main, site.id, { [`${owner}/${slug}.html`]: html("Not the document") });
    expect((await publish(main, site.id)).result!.publishing.state).toBe("published");
    // (The site's other pages are there, at their clean addresses.)
    expect((await out("/about")).text).toContain("<h1>About me</h1>");
    // /docs is no page of Erga's: it is the site's docs.html. The documents list is /documents.
    expect((await out("/docs")).text).toContain("<h1>My docs page</h1>");
    expect((await out("/documents")).text).not.toContain("My docs page");
    expect(await (await get(main, "/documents")).text()).toContain('data-live-view="documents"');
    const doc = await (await get(main, site.address)).text();
    expect(doc).not.toContain("Not the document");
    expect(doc).toContain('<meta name="erga-doc"');
    // A document's address with nothing there is Erga's too: signed out, it asks to sign in.
    expect((await out(`/${owner}/no-such-document`)).text).not.toContain("<h1>Lost</h1>");
  });

  test("only an admin publishes, from this site; someone with edit access edits the document, and sees its publishing; the session cookie is HttpOnly", async () => {
    const cookie = (await get(main, "/auth/github?as=Ada")).headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/erga_\d+=[^;]+;.*HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const bo = unique("bo");
    const share = async (login: string, role: string) =>
      (await runTool(main.root, "share_document", { document: site.id, login, role })).error;
    expect((await runTool(main.root, "ls", { document: site.id }, { user: bo })).status).toBe(403);
    // A viewer has no publishing to see; an editor sees it, and may change none of it.
    await share(bo, "viewer");
    expect(await publishingOf(main, site.id, bo)).toBeUndefined();
    expect(await share(bo, "editor")).toBeUndefined();
    expect(await publishingOf(main, site.id, bo)).toMatchObject({ domain: erga, state: "published", canPublish: false });
    expect((await publish(main, site.id, bo)).status).toBe(403);
    expect((await setPublishing(main, site.id, { bars: false }, bo)).status).toBe(403);
    expect((await publish(main, site.id, undefined, "https://evil.example")).status).toBe(403);
    const canEdit = async () => ((await (await get(main, `/d/${site.id}/api/doc?user=${bo}`)).json()) as { canEdit?: boolean }).canEdit;
    expect(await canEdit()).toBe(true);
  });

  test("the page's styles can't reach the controls, nor theirs the page; its files load from the publish, and at the root, never over the app's; every page of the site has the controls", async ({
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
    expect((await publish(main, site.id)).result!.publishing.state).toBe("published");
    await frontShows("Second home");
    const p = tab.page;
    await p.setViewportSize({ width: 1200, height: 800 });
    await openRoot(p, main);
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
    // (The app's own files are under /_erga/: a name at the root is the site's.)
    expect(await (await get(main, "/style.css")).text()).toContain("rgb(1, 2, 3)");
    expect(iso.cookie).not.toMatch(/erga_\d+=/);
    // On a phone, the controls never make the page wider than the window, even with a scrollbar's room to take back.
    await p.setViewportSize({ width: 390, height: 844 });
    const wide = () =>
      p.evaluate(() => {
        document.querySelector<HTMLElement>("erga-controls")!.style.setProperty("--erga-scrollbar", "15px");
        return document.documentElement.scrollWidth;
      });
    expect(await wide()).toBe(390);
    // And signed out, the site's other pages have the same controls, above the page: Sign in never covers its own top
    // right (before, the bare Sign in corner sat on the docs page's link).
    await p.goto(`${main.root}/docs`);
    const docs = await p.evaluate(() => {
      const a = document.getElementById("try")!,
        b = a.getBoundingClientRect();
      const account = document.querySelector("erga-controls")?.shadowRoot?.querySelector<HTMLElement>(".erga-account");
      return {
        clear: document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) == a,
        account: account?.dataset.ergaAccount ?? null,
      };
    });
    expect(docs).toEqual({ clear: true, account: "out" });
  });

  test("the header bar is the document's publishing setting: off, no page has the controls or room for them, at once, with no publish; the site's links and folders work", async ({
    tab,
  }) => {
    await write(main, site.id, { "index.html": index("Fixed") });
    const done = (await publish(main, site.id)).result!.publishing;
    expect((await front(main)).html).toMatch(/html:root:root \{ padding-top/);
    // The bar can't be on for a custom domain; this server has none, and the Erga domain's goes off at once.
    const off = (await setPublishing(main, site.id, { bars: false })).result!.publishing;
    expect(off).toMatchObject({ bars: false, state: "published", at: done.at, version: done.version });
    for (const path of ["/", "/about"]) {
      const f = await front(main, path);
      expect([path, f.status, f.controls, f.html.includes("padding-top")]).toEqual([path, 200, false, false]);
    }
    // The page's own links work at their clean addresses, and its relative files load from a folder's page.
    const p = tab.page;
    const colour = () => p.evaluate(() => getComputedStyle(document.querySelector("h1")!).color);
    await openRoot(p, main);
    await Promise.all([p.waitForURL((u) => u.pathname == "/about"), p.click("a")]);
    expect(await p.locator("h1").textContent()).toBe("About me");
    await p.goto(`${main.root}/blog`);
    expect(new URL(p.url()).pathname).toBe("/blog/");
    await until(async () => (await colour()) == "rgb(1, 2, 3)", 5_000, "the folder's page has the site's style");
    await Promise.all([p.waitForURL((u) => u.pathname == "/blog/2026/post"), p.click("#post")]);
    await until(async () => (await colour()) == "rgb(1, 2, 3)", 5_000, "the post has the site's style");
    await p.context().clearCookies();
    // On again: every page has the controls again, at once.
    expect((await setPublishing(main, site.id, { bars: true })).result!.publishing.bars).toBe(true);
    expect([(await front(main)).controls, (await front(main, "/about")).controls]).toEqual([true, true]);
  });

  test("Not published takes the Erga domain's site away at once; the default homepage, linked again, shows nothing new until it is published", async () => {
    expect((await setPublishing(main, site.id, { domain: "" })).result!.publishing).toMatchObject({ domain: null, state: "free" });
    expect(await front(main)).toMatchObject({ status: 404, html: "" });
    expect((await front(main, "/about")).status).not.toBe(200);
    // The default homepage is still at /_home: an admin links it again. / answers with nothing until the publish.
    expect((await setPublishing(main, "/_home", { domain: erga })).result!.publishing).toMatchObject({ domain: erga, state: "linked" });
    expect(await front(main)).toMatchObject({ status: 404, html: "" });
    expect((await publish(main, "/_home")).result!.publishing.state).toBe("published");
    const logo = `<h1 class="logo"`;
    await until(
      async () => {
        const f = await front(main);
        return f.controls && f.html.includes(logo);
      },
      5_000,
      "the default homepage is published again"
    );
  });

  test("an admin renames the default homepage in its title card: its address stays /_home, and the title stays after a reload", async ({
    tab,
  }) => {
    const page = tab.page;
    const js = <T>(expr: string) => page.evaluate(expr) as Promise<T>;
    const clickOn = (selector: string) => pressOn(page, selector);
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
    await agentClosed(page);
    // (For the reload below: while `__mute`, the tab's sockets send nothing.)
    await page.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (this: WebSocket, data) {
        if (!(window as { __mute?: boolean }).__mute) send.call(this, data);
      };
    });
    await page.goto(`${main.root}/_home?edit`);
    await editorUp();
    // One page: the title opens its name.
    await clickOn("#doc-title");
    await until(
      () => js(`!document.getElementById("naming").hidden && document.activeElement.id == "naming-title"`),
      5_000,
      "the title's card opens"
    );
    // The address is /_home, and it doesn't change: no slug to type in.
    expect(await js<string>(`document.getElementById("naming-prefix").textContent`)).toBe("/_home");
    expect(await js<number>(`document.getElementById("naming-slug").getBoundingClientRect().width`)).toBe(0);
    await page.keyboard.type("Our homepage");
    // The reload comes before the server hears of the rename: the tab sends nothing more, and the title is kept.
    for (const f of page.frames()) await f.evaluate(`window.__mute = true`);
    await page.keyboard.press("Enter");
    await until(() => js(`document.getElementById("naming").hidden`), 5_000, "the title's card closes");
    expect(await js<string>(`document.getElementById("naming-status").textContent`)).not.toMatch(/can't/);
    await until(async () => (await title()) == "Our homepage", 5_000, "the breadcrumb has the new title", title);
    expect(new URL(page.url()).pathname).toBe("/_home");
    await page.reload();
    await until(async () => (await title().catch(() => "")) == "Our homepage", 10_000, "the title stays after a reload", title);
    const named = async () => (await runTool(main.root, "ls", { document: "/_home" })).result?.title as string;
    await until(async () => (await named()) == "Our homepage", 5_000, "the server has the new title", named);
    await editorUp();
    // index.html, in the tree, is the page at /_home, named by the title.
    const name = () => js<string | undefined>(`document.querySelector(${JSON.stringify(`${indexRow} .et-name`)})?.textContent`);
    await until(async () => (await name()) == "Our homepage", 5_000, "the pages name the default homepage by its title", name);
    expect(await js<string>(`document.querySelector(${JSON.stringify(`${indexRow} .et-name`)}).getAttribute("href")`)).toBe("/_home?edit");
  });

  test("signed out, / has Clone and Sign in with its menu, and no Edit", async ({ tab }) => {
    const p = tab.page;
    await openRoot(p, main);
    const id = docOf((await front(main)).html);
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
    expect(await controls()).toEqual({ clone: `/new?from=${id}`, edit: null, account: "out", inBody: false });
    const menuHidden = () =>
      p.evaluate(() => (document.querySelector("erga-controls")!.shadowRoot!.querySelector(".erga-account-menu") as HTMLElement).hidden);
    await p.evaluate(() =>
      (document.querySelector("erga-controls")!.shadowRoot!.querySelector(".erga-account-btn") as HTMLElement).click()
    );
    expect(await menuHidden()).toBe(false);
    await p.mouse.click(600, 500);
    expect(await menuHidden()).toBe(true);
  });

  test("someone who isn't an admin sees the default homepage with Clone, without Edit, which an admin has; /new?from=<its id> copies it", async () => {
    const id = docOf((await front(main)).html);
    const ada = await (await get(main, "/_home?user=Ada")).text();
    expect(frameOf(ada)).toBe(id);
    expect(ada).not.toContain("erga-edit-button");
    expect(ada).toContain("erga-new-clone");
    // Edit is for an admin (the dev server's own person).
    expect(await (await get(main, "/_home")).text()).toContain('erga-edit-button"');
    const made = await get(main, `/new?from=${id}&user=Ada`);
    expect(made.status).toBe(302);
    expect(made.headers.get("location") ?? "").toMatch(/^\/ada\/.+?edit/);
  });
});
