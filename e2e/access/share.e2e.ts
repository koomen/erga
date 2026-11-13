// Share: who may open and edit a document, and how access is given, taken away and asked for.
//
// The first journey is one owner, one document and one reader (Ada) on the shared server. Nobody but the owner opens
// the document; a viewer only looks, also in the room; an editor edits, with Share off; access taken away closes the
// open editor; Ada asks for access; the owner shares from the documents list and its Share dialog, and lets readers
// use their agent. The rules of access are checked with requests (`?user=`), the dialogs on the page.
// The second journey is the admin's switch "Users can share content publicly", on a server of this file's own: it
// changes the whole server.
import { framed, pagesFetch } from "../helpers/pages-fetch";
import { expect, journey, servers, test, until, type Page } from "../helpers/fixtures";
import { deployHome } from "../helpers/server";
import { runTool } from "../helpers/tools";
import { agentClosed, editorUp, getter, joinRoom, newDoc, share, signedOut, signIn, soon, unique } from "./access";
import { clickOn } from "../helpers/press";

const [s, own] = await Promise.all([servers.main(), servers.of("share")]);

type Access = { permissions: { login: string; role: string }[]; requests: { login: string }[]; readerAgent?: boolean };

/**
 * From before the page's first frame to now, each state the editor's Share button had, as the person sees it: whether
 * it showed, and how strong its icon was. Every change in the page writes one down (in window.__share).
 */
const watchShare = (page: Page) =>
  page.addInitScript(() => {
    if (window.top != window) return;
    const seen: string[] = ((window as any).__share = []);
    const note = () => {
      const b = document.getElementById("btn-share");
      if (!b) return;
      const svg = b.querySelector("svg");
      const state = `${b.hidden || !b.isConnected ? "gone" : "there"} ${svg ? getComputedStyle(svg).opacity : "?"}`;
      if (seen[seen.length - 1] != state) seen.push(state);
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true });
  });

/** The editor's Share button as the page shows it now, and each state it had. */
const shareButton = (page: Page) =>
  page.evaluate(() => {
    const b = document.getElementById("btn-share")!,
      r = b.getBoundingClientRect();
    return {
      shown: !b.hidden && r.width > 0,
      off: b.getAttribute("aria-disabled") == "true",
      tip: b.dataset.tip,
      card: !document.getElementById("sharing")!.hidden,
      states: (window as any).__share as string[],
    };
  });

journey("an owner shares a document with a reader", () => {
  let page: Page;
  const root = s?.root,
    get = getter(root);
  const owner = unique("own"),
    ada = unique("ada"),
    bo = unique("bo"),
    cy = unique("cy");
  let cookie: string, doc: Awaited<ReturnType<typeof newDoc>>;
  /** A request as the owner (their cookie), or as someone else (`?user=`). */
  const mine = (path: string, init: RequestInit = {}) => get(path, { ...init, headers: { Cookie: cookie, ...(init.headers as object) } });
  const as = (who: string, path: string, init?: RequestInit) => get(`${path}${path.includes("?") ? "&" : "?"}user=${who}`, init);
  const tool = <T = any>(name: string, args: Record<string, unknown>, who = owner) => runTool<T>(root, name, args, { user: who });
  const access = async () => (await tool<{ access: Access }>("ls", { document: doc.id })).result!.access;
  const shared = async () => (await access()).permissions.map((x) => `${x.login}:${x.role}`).join();
  /** The page's text in storage (written a moment after an edit), and as the room serves it (at once). */
  const stored = async () => (await mine(`/d/${doc.id}/api/stored/index.html`)).text();
  const served = async () => (await mine(`/d/${doc.id}/doc/index.html`)).text();
  const put = (who: string, path: string, body: string) => as(who, `/d/${doc.id}/api/stored/${path}`, { method: "PUT", body });

  test("someone the document is not shared with cannot open it, nor reach its host, and is told why", async () => {
    cookie = await signIn(root, owner);
    doc = await newDoc(root, cookie);
    expect(doc.address).toBe(`/${owner}/untitled`);
    const r = await as(ada, doc.address);
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("has not shared this document with");
    expect((await as(ada, `/d/${doc.id}/api/doc`)).status).toBe(403);
  });

  test("a viewer opens it and has it on their list, view only; they cannot write, rename, delete or share it", async () => {
    const made = await share(root, doc.id, ada, "viewer", owner);
    expect(made.status).toBe(200);
    expect(made.result?.permissions.map((x) => `${x.login}:${x.role}`)).toEqual([`${owner}:owner`, `${ada}:viewer`]);
    expect((await as(ada, doc.address)).status).toBe(200);
    expect((await as(ada, `/d/${doc.id}/doc/index.html`)).ok).toBe(true);
    const list = await (await as(ada, "/docs")).text();
    expect(list).toContain(`href="${doc.address}?user=${ada}&amp;edit"`);
    expect(list).toContain(`${owner} · view only`);
    expect(list).not.toContain(`value="${doc.id}"`);
    expect((await put(ada, "index.html", "<h1>Mine now</h1>")).status).toBe(403);
    expect((await tool("rename_document", { document: doc.id, title: "Viewer's title" }, ada)).status).toBe(403);
    expect((await tool("delete_document", { document: doc.id }, ada)).status).toBe(403);
    expect((await share(root, doc.id, bo, "editor", ada)).status).toBe(403);
    // The owner's tools say who it is shared with; a viewer's do not.
    expect(await shared()).toBe(`${owner}:owner,${ada}:viewer`);
    const hers = await tool<{ access?: Access }>("ls", { document: doc.id }, ada);
    expect([hers.status, hers.result?.access]).toEqual([200, undefined]);
  });

  test("the viewer names the document's own origin, which serves the page only to this site's frame; a forged token opens nothing", async () => {
    const viewer = await (await mine(doc.address)).text();
    const url = /<meta name="erga-pages" content="([^"]+)">/.exec(viewer)?.[1] ?? "";
    expect(url, viewer.slice(0, 1500)).toBeTruthy();
    const at = new URL(url),
      origin = new URL(root).origin;
    expect(at.hostname.startsWith(`${doc.id}-${owner}.`), url).toBe(true);
    expect(at.origin).not.toBe(origin);
    // The page, as a frame's: only this site may frame it; its HTML as written, the viewer's script first.
    const frame = await framed(`${url}index.html`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-security-policy") ?? "").toContain(`frame-ancestors ${origin}`);
    const html = await frame.text();
    expect(html.replace(/<script[^]*?<\/script>/g, "")).not.toContain("data-erga-text");
    expect(html.indexOf("erga-hello")).toBeGreaterThan(0);
    // The file itself, as a page's own fetch has it, without a cookie: as it is.
    expect(await (await pagesFetch(`${url}index.html`)).text()).toBe(await (await mine(`/d/${doc.id}/doc/index.html`)).text());
    // A forged token, or a good one at another document's origin, opens nothing; none of this site's pages are there.
    const forged = url.replace(/\/t\/([^/.]+)\.[^/]+\//, "/t/$1.forged/");
    expect((await pagesFetch(`${forged}index.html`)).status).toBe(403);
    expect((await pagesFetch(`${at.origin.replace(doc.id, "aaaaaaaa")}${at.pathname}index.html`)).status).toBe(403);
    expect((await pagesFetch(`${at.origin}/docs`)).status).toBe(404);
  });

  test("in the room, a viewer sees every edit and theirs reach nobody, nor storage; made an editor, their edits land", async () => {
    const host = `${root}/d/${doc.id}`;
    const me = await joinRoom(host, owner),
      viewer = await joinRoom(host, ada);
    try {
      viewer.insertAfter("<p>", "Viewer was here. ");
      // The viewer's edit has gone out before the owner's is made: once the room serves the owner's, it has had both.
      await until(viewer.sent, 2000, "the viewer's edit sent");
      me.insertAfter("<p>", "Owner was here. ");
      await until(() => viewer.text().includes("Owner was here."), 5000, "the viewer sees the owner's edit");
      // (Storage has an edit a second later: the step after the next one reads it there, with no wait.)
      await until(async () => (await served()).includes("Owner was here."), 5000, "the room serves the owner's edit");
      expect(me.text()).not.toContain("Viewer was here.");
      expect(await served()).not.toContain("Viewer was here.");
      viewer.leave();
      await share(root, doc.id, ada, "editor", owner);
      const editor = await joinRoom(host, ada);
      try {
        editor.insertAfter("<p>", "Editor was here. ");
        await until(() => me.text().includes("Editor was here."), 5000, "an editor's edit reaches the owner");
        expect((await put(ada, "notes.txt", "hi")).ok).toBe(true);
      } finally {
        editor.leave();
      }
    } finally {
      viewer.leave();
      me.leave();
    }
  });

  // The Share button once showed and then went away for an editor who is not the owner.
  test("an editor of someone's document sees Share off, from the first frame on, and a click opens nothing", async ({ tab }) => {
    page = tab.page;
    await page.setViewportSize({ width: 1200, height: 800 });
    await agentClosed(page);
    await watchShare(page);
    await page.goto(`${root}${doc.at}&user=${ada}`);
    await editorUp(page);
    expect(await shareButton(page)).toEqual({
      shown: true,
      off: true,
      tip: "Only the owner can share",
      card: false,
      states: ["there 0.4"],
    });
    await clickOn(page, "#btn-share");
    // Every state it had: there and dimmed; never gone, never full strength.
    expect(await shareButton(page)).toMatchObject({ card: false, states: ["there 0.4"] });
  });

  test("access taken away while their editor is open: the page opens again and says so, and they write no more", async () => {
    await until(() => page.evaluate(() => document.body.classList.contains("erga-listening")), 15_000, "Ada's editor joined its room");
    // Storage has the edits of the step in the room by now: the owner's and the editor's, and never the viewer's.
    await until(
      async () => /Owner was here\..*Editor was here\.|Editor was here\..*Owner was here\./s.test(await stored()),
      10_000,
      "the edits stored"
    );
    expect(await stored()).not.toContain("Viewer was here.");
    await page.evaluate(() => {
      (window as any).beforeTheChange = true;
    });
    await share(root, doc.id, ada, "none", owner);
    await until(
      () => page.evaluate(() => !(window as any).beforeTheChange && document.readyState == "complete").catch(() => false),
      10_000,
      "Ada's page opened again"
    );
    expect(await page.locator("main").innerText()).toContain(`${owner} has not shared this document with ${ada}.`);
    expect((await put(ada, "index.html", "<h1>Still mine</h1>")).status).toBe(403);
  });

  test("the page with no access has three ways out; Ask tells the owner, one time for each person", async () => {
    expect(await page.locator("main .ways > *").allInnerTexts()).toEqual([
      `Ask ${owner} for access`,
      "Use another account",
      "Your documents",
    ]);
    expect(await page.locator("main .ways a").evaluateAll((l) => l.map((a) => new URL((a as HTMLAnchorElement).href).pathname))).toEqual([
      "/auth/logout",
      "/docs",
    ]);
    await page.locator("#ask-access").click();
    await soon(() => page.locator("#ask-access").innerText()).toBe("Asked");
    expect(await page.locator("#ask-access").isDisabled()).toBe(true);
    expect(await page.locator("#ask-note").innerText()).toBe(`${owner} sees your request on their documents list.`);
    // The page remembers; a second request changes nothing.
    await page.reload();
    await soon(() => page.locator("#ask-access").innerText()).toBe("Asked");
    // Bo asks through his agent's tool, two times.
    expect((await tool("request_access", { document: doc.id }, bo)).error).toBeUndefined();
    expect((await tool("request_access", { document: doc.id }, bo)).error).toBeUndefined();
    expect((await access()).requests.map((r) => r.login).sort()).toEqual([ada, bo].sort());
  });

  test("the owner sees the requests at the top of the documents list, and shares or declines there", async () => {
    const asks = () =>
      page.locator("ul.asks li").evaluateAll((l) => l.map((li) => (li as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
    await page.goto(`${root}/auth/github?as=${owner}&next=/docs`);
    expect((await asks()).sort()).toEqual(
      [`${ada} asks for access to Untitled Share Decline`, `${bo} asks for access to Untitled Share Decline`].sort()
    );
    // Share: Ada can view it. Decline: Bo can't, and his request doesn't come back.
    await page.locator(`ul.asks li[data-login="${ada}"] button.share`).click();
    await page.locator(`ul.asks li[data-login="${bo}"] button.decline`).click();
    await until(async () => !(await asks()).length, 5000, "the two requests go");
    expect((await as(ada, doc.address)).status).toBe(200);
    expect((await as(bo, doc.address)).status).toBe(403);
    expect((await tool("request_access", { document: doc.id }, bo)).error).toBeUndefined();
    await page.reload();
    expect(await asks()).toEqual([]);
    // Someone who has access has nothing to ask for.
    expect((await tool("request_access", { document: doc.id }, ada)).error).toMatch(/already/);
  });

  test("the Share dialog on the documents list adds a person, sets anyone with the link, and stops sharing with a person", async () => {
    await page.evaluate((href) => {
      document.querySelector(`li a[href="${href}"]`)!.closest("li")!.querySelector<HTMLElement>("button.share")!.click();
    }, doc.at);
    const people = () => page.evaluate(() => document.querySelectorAll("#share .people li").length);
    const anyone = (role: string) =>
      page.evaluate((role) => {
        const select = document.getElementById("share-anyone") as HTMLSelectElement;
        select.value = role;
        select.dispatchEvent(new Event("change"));
      }, role);
    await soon(people).toBe(2);
    await page.evaluate((who) => {
      const f = document.querySelector<HTMLFormElement>("#share form.add")!;
      (f.elements.namedItem("who") as HTMLInputElement).value = who;
      (f.elements.namedItem("role") as HTMLSelectElement).value = "viewer";
      f.requestSubmit();
    }, cy);
    await soon(people).toBe(3);
    await anyone("editor");
    await soon(shared).toBe(`${owner}:owner,*:editor,${ada}:viewer,${cy}:viewer`);
    // Anyone with the link may open it now, signed in; an editor by the link still shares nothing.
    expect((await as(bo, doc.address)).status).toBe(200);
    expect((await share(root, doc.id, bo, "editor", bo)).status).toBe(403);
    await page.evaluate(() => document.querySelector<HTMLElement>("#share .people li:last-child button.act")!.click());
    await soon(people).toBe(2);
    await anyone("none");
    await soon(shared).toBe(`${owner}:owner,${ada}:viewer`);
    expect((await as(bo, doc.address)).status).toBe(403);
    // The owner's own permission can't be changed.
    expect((await share(root, doc.id, owner, "viewer", owner)).status).toBe(403);
    await page.keyboard.press("Escape");
  });

  test("a reader has no agent in the viewer until the owner lets readers use theirs", async () => {
    await page.goto(`${root}${doc.address}?user=${ada}`);
    await page.locator(".erga-view-buttons").waitFor();
    expect(await page.evaluate(() => !!document.getElementById("agent"))).toBe(false);
    // A reader has no editor, so no Share button at any moment.
    expect(await page.evaluate(() => [(window as any).__share, !!document.querySelector(".erga-edit-button")])).toEqual([[], false]);
  });

  test("the owner's Share is on and opens the card, which follows a share made elsewhere", async () => {
    await page.goto(`${root}${doc.at}`);
    await editorUp(page);
    expect(await shareButton(page)).toEqual({ shown: true, off: false, tip: "Share", card: false, states: ["there 1"] });
    await clickOn(page, "#btn-share");
    await soon(async () => (await shareButton(page)).card).toBe(true);
    // (Cut list, brought back.) An agent shares the document, and stops: the open card lists them, and drops them.
    const listed = () =>
      page.evaluate(() => [...document.querySelectorAll("#sharing-list li .who")].map((w) => w.firstChild!.textContent!.trim()));
    await soon(listed).toEqual([owner, ada]);
    await until(
      () => page.evaluate(() => document.body.classList.contains("erga-listening")),
      15_000,
      "the owner's editor joined its room"
    );
    await share(root, doc.id, cy, "viewer", owner);
    await soon(listed).toEqual([owner, ada, cy]);
    await share(root, doc.id, cy, "none", owner);
    await soon(listed).toEqual([owner, ada]);
    await page.keyboard.press("Escape");
  });

  test("the owner's switch in Document settings gives readers their agent", async () => {
    await clickOn(page, "#btn-settings");
    await page.locator("#ds-agent-on").waitFor();
    expect(await page.locator("#ds-agent-on").isChecked()).toBe(false);
    await page.locator("#ds-agent-on").click();
    await soon(async () => (await access()).readerAgent).toBe(true);
    await page.goto(`${root}${doc.address}?user=${ada}`);
    await page.locator(".erga-view-buttons").waitFor();
    expect(await page.evaluate(() => !!document.getElementById("agent"))).toBe(true);
  });
});

journey("the admin's switch: users can share content publicly", () => {
  let page: Page;
  const root = own?.root;
  let open: Awaited<ReturnType<typeof newDoc>>, closed: Awaited<ReturnType<typeof newDoc>>;
  /** Someone not signed in asks for a page. */
  const stranger = (path: string) => fetch(root + path, { redirect: "manual", headers: { ...signedOut(own), Accept: "text/html" } });
  /** Flips the switch on the Access page, as the admin does. */
  const setPublic = async (on: boolean) => {
    await page.goto(`${root}/admin/access`);
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    expect(await page.isChecked("#public-sharing")).toBe(!on);
    await page.evaluate(() => document.querySelector<HTMLInputElement>("#public-sharing")!.click());
    await until(async () => (await page.textContent("#public-hint")) == "Saved.", 5000, `public sharing ${on ? "on" : "off"}`);
  };

  test("on: a document shared with anyone with the link opens for people who are not signed in; off: it is closed, but kept", async ({
    tab,
  }) => {
    page = tab.page;
    [open, closed] = [await newDoc(root), await newDoc(root)];
    expect((await share(root, open.id, "*", "viewer")).status).toBe(200);
    // On (local development starts so): it opens for someone signed out.
    let r = await stranger(open.address);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("erga-pages");
    await setPublic(false);
    r = await stranger(open.address);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")?.startsWith("/auth/sign-in")).toBe(true);
    // A new share with anyone with the link: refused, saying why.
    const refused = await share(root, closed.id, "*", "viewer");
    expect(refused.status).toBe(403);
    expect(refused.error).toContain("doesn't let users share content publicly");
    // The homepage stays public.
    expect((await stranger("/")).status).toBe(200);
  });

  test("off: the Share dialog does not offer anyone with the link, and shows a share made before, to stop it; on again: it opens", async () => {
    await page.goto(`${root}/docs`);
    await page.click(`button.share[data-id="${closed.id}"]`);
    await until(async () => (await page.textContent("#share-hint")) == "", 5000, "the share dialog loaded");
    expect(await page.isVisible("#share .anyone")).toBe(false);
    await page.keyboard.press("Escape");
    await page.click(`button.share[data-id="${open.id}"]`);
    await until(async () => (await page.inputValue("#share-anyone")) == "viewer", 5000, "the kept share shows");
    expect(await page.textContent("#share-anyone-note")).toContain("Public sharing is off");
    await page.keyboard.press("Escape");
    await setPublic(true);
    expect((await stranger(open.address)).status).toBe(200);
  });

  // (Cut list, brought back.) The homepage project has no owner: only an owner shares.
  test("an admin in the homepage project's editor sees Share off, from the first frame on", async () => {
    // The homepage project, as a deploy makes it.
    await deployHome(own);
    await page.setViewportSize({ width: 1200, height: 800 });
    await agentClosed(page);
    await watchShare(page);
    await page.goto(`${root}/_home?edit`);
    await editorUp(page);
    expect(await shareButton(page)).toEqual({
      shown: true,
      off: true,
      tip: "Only the owner can share",
      card: false,
      states: ["there 0.4"],
    });
    await clickOn(page, "#btn-share");
    expect(await shareButton(page)).toMatchObject({ card: false, states: ["there 0.4"] });
  });
});
