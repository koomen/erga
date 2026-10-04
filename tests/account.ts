#!/usr/bin/env bun
// Who you are, in the upper right of every page (account.ts):
//
//   - signed in, your avatar (your GitHub picture, your initial if it doesn't
//     load), on /docs, /admin, /settings, the front page (beside its Edit
//     and Clone buttons), a page that isn't there; clicking it opens a menu:
//     your name, Documents, Settings, Admin settings (admins only), Sign out;
//   - in the editor, your avatar among its own controls opens the same menu;
//   - signed out (locally: after Sign out), a person in a circle whose menu
//     has only Sign in (with GitHub), which comes back to the same page, signed in;
//   - never inside a document: not its pages origin, not its files.
//
// Screenshots (light, dark, phone) land in tests/cdp.ts's SHOTS.
//
//   bun tests/account.ts

import { join } from "path";
import { Browser, type Page, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

const host = await startHost(null);
const root = host.root;
const browser = await Browser.launch();
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });

/** The corner as the page shows it. */
const corner = (p: Page) => p.eval<{ state: string | null; label: string | null; img: string | null; initial: string; open: boolean; links: { text: string; href: string }[]; who: string; rect: { x: number; y: number; w: number; h: number } | null }>(`(() => {
  const root = document.querySelector("[data-erga-account]"), btn = root?.querySelector("button"), menu = root?.querySelector(".erga-account-menu");
  const r = btn?.getBoundingClientRect();
  return { state: root?.dataset.ergaAccount ?? null, label: btn?.getAttribute("aria-label") ?? null, img: btn?.querySelector("img")?.getAttribute("src") ?? null,
    initial: btn?.querySelector("span")?.textContent ?? "", open: !!menu && !menu.hidden, who: menu?.querySelector(".erga-account-who")?.textContent ?? "",
    links: [...(menu?.querySelectorAll("a") ?? [])].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute("href") })),
    rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null };
})()`);
const clickOn = async (p: Page, selector: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  expect(r, `${selector} is on the page`);
  await p.click(r.x, r.y);
};

try {
  // The markup, on every page of the site's own, and nowhere in a document.
  for (const path of ["/", "/docs", "/admin", "/settings", "/nobody-here"]) {
    const html = await (await get(path)).text();
    expect(html.includes('data-erga-account="in"') && html.includes("https://avatars.githubusercontent.com/tester?s=64"), `${path} has your avatar in its corner`, html.slice(-1500));
  }
  const made = await get("/new");
  const at = made.headers.get("location")!;
  const id = ((await (await get(`${at.replace(/\/edit$/, "")}/api/name`)).json()) as { id: string }).id;
  const editorHtml = await (await get(at)).text();
  expect(editorHtml.includes('data-erga-account="in"') && editorHtml.includes('name="erga-account"'), "the editor's page has it (for viewing) and is told the links for the editor's own (editing)", editorHtml.slice(0, 400));
  expect(JSON.parse(/name="erga-account" content="([^"]+)"/.exec(editorHtml)![1].replaceAll("&quot;", '"')).admin == "/admin", "an admin's editor menu has Admin");
  const docFile = await (await get(`/d/${id}/doc/index.html`)).text();
  expect(!docFile.includes("data-erga-account"), "a document's own files are left alone", docFile.slice(-400));
  const front = await (await get("/")).text();
  const frameSrc = /<iframe id="frame" class="erga-view" src="([^"]+)"/.exec(front)![1].replaceAll("&amp;", "&");
  const framed = await (await fetch(frameSrc.replace(/^http:\/\/[^/]+/, root), { headers: { Host: new URL(frameSrc).host } })).text();
  expect(!framed.includes("data-erga-account"), "nor the front page's document, on its pages origin");
  const ada = await (await get("/docs?user=Ada")).text();
  expect(ada.includes('data-erga-account="in"') && ada.includes('href="/docs?user=Ada"') && !ada.includes('href="/admin'), "someone who isn't an admin has no Admin, and a local tab's ?user= stays on the links", ada.slice(-1200));
  ok("every page of the site's own has the corner; the editor has its own; documents have none");

  // In a real browser: /docs, signed in. Click the avatar: the menu.
  const ctx = await browser.context();
  const p = await browser.page(ctx);
  await p.open(`${root}/docs`, { width: 1100, height: 720, scale: 2 });
  let c = await corner(p);
  expect(c.state == "in" && c.initial == "T" && c.rect && c.rect.x + c.rect.w > 1100 - 24 && c.rect.y < 24, "your avatar is in the upper right", c);
  await clickOn(p, "[data-erga-account] button");
  c = await corner(p);
  expect(c.open && c.who.includes("tester") && c.links.map((l) => l.text).join() == "Documents,Settings,Admin settings,Sign out", "clicking it opens your menu", c);
  await p.screenshot(join(SHOTS, "account-docs.png"));
  await p.key("Escape");
  expect(!(await corner(p)).open, "Escape closes it");
  // Its picture failing to load leaves your initial.
  await p.eval(`document.querySelector("[data-erga-account] img")?.dispatchEvent(new Event("error")), true`);
  c = await corner(p);
  expect(!c.img && c.initial == "T" && (await p.eval<string>(`getComputedStyle(document.querySelector("[data-erga-account] button")).backgroundColor`)) != "rgba(0, 0, 0, 0)", "without the picture, your initial on your colour", c);
  ok("on /docs, your avatar opens a menu: your name, Documents, Settings, Admin settings, Sign out");

  // Dark, and a phone.
  await p.open(`${root}/admin`, { width: 1100, height: 720, scale: 2, dark: true, clear: false });
  await clickOn(p, "[data-erga-account] button");
  await p.screenshot(join(SHOTS, "account-admin-dark.png"));
  await p.open(`${root}/docs`, { width: 390, height: 760, scale: 2, clear: false });
  c = await corner(p);
  const overlap = await p.eval<boolean>(`(() => { const a = document.querySelector("[data-erga-account] button").getBoundingClientRect(); return [...document.querySelectorAll("main header > *")].some((e) => { const b = e.getBoundingClientRect(); return b.right > a.left && b.left < a.right && b.bottom > a.top && b.top < a.bottom; }); })()`);
  expect(c.rect && c.rect.x + c.rect.w <= 390 - 12 && !overlap, "at phone width it fits, clear of the page's header", c);
  await clickOn(p, "[data-erga-account] button");
  const menuFits = await p.eval<boolean>(`(() => { const r = document.querySelector(".erga-account-menu").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`);
  expect(menuFits, "and its menu stays on screen");
  await p.screenshot(join(SHOTS, "account-phone.png"));
  ok("light and dark, and at phone width");

  // The front page: beside its Edit and Clone buttons, not under them.
  await p.open(`${root}/`, { width: 1100, height: 720, scale: 2, clear: false });
  await until(async () => (await p.inPage<string>(`document.querySelector("h1")?.textContent ?? ""`)).some((t) => t == "Erga"), 15_000, "the landing page renders in its frame");
  const apart = await p.eval<boolean>(`(() => { const a = document.querySelector("[data-erga-account] button").getBoundingClientRect(), e = document.querySelector(".erga-view-buttons").getBoundingClientRect(); return e.right <= a.left - 4 && Math.abs((e.top + e.bottom) / 2 - (a.top + a.bottom) / 2) < 3; })()`);
  expect(apart, "the avatar sits right of the Edit and Clone buttons, level with them");
  await p.screenshot(join(SHOTS, "account-front.png"));
  ok("on the front page, the avatar sits beside the Edit and Clone buttons");

  // The editor: your avatar, the last of its controls, opens the same menu.
  await p.open(`${root}${at}`, { width: 1100, height: 720, scale: 2, clear: false });
  await until(() => p.eval<boolean>(`!!document.querySelector("#me .avatar") && document.body.classList.contains("erga-editor-ready")`), 15_000, "the editor shows your avatar");
  await Bun.sleep(250); // its controls fade in
  const meRect = await p.eval<{ right: number; top: number; img: string | null }>(`(() => { const b = document.querySelector("#me .avatar"), r = b.getBoundingClientRect(); return { right: r.right, top: r.top, img: b.querySelector("img")?.getAttribute("src") ?? null }; })()`);
  expect(meRect.right > 1100 - 30 && meRect.top < 30 && meRect.img?.startsWith("https://avatars.githubusercontent.com/tester"), "far right of the editor's controls, with your GitHub picture", meRect);
  await clickOn(p, "#me .avatar");
  const menu = await p.eval<{ hidden: boolean; expanded: string | null; links: string[] }>(`({ hidden: document.getElementById("account").hidden, expanded: document.querySelector("#me .avatar").getAttribute("aria-expanded"), links: [...document.querySelectorAll("#account a:not([hidden])")].map((a) => a.textContent + " " + a.getAttribute("href")) })`);
  expect(!menu.hidden && menu.expanded == "true" && menu.links.join() == "Documents /docs,Settings /settings,Admin settings /admin,Sign out /auth/logout", "clicking it opens your menu", menu);
  await Bun.sleep(600);
  expect(!(await p.eval<boolean>(`document.getElementById("account").hidden`)), "and it stays open");
  await p.screenshot(join(SHOTS, "account-editor.png"));
  await p.key("Escape");
  const eye = await p.eval<{ pressed: string | null; hidden: boolean; href: string | null }>(`({ pressed: document.getElementById("btn-edit").getAttribute("aria-pressed"), hidden: document.getElementById("btn-edit").hidden, href: document.getElementById("btn-edit").getAttribute("href") })`);
  expect(!eye.hidden && eye.pressed == "true" && eye.href == at.replace(/\/edit$/, ""), "the pencil beside it, on, goes back to the viewer", { eye, at });
  expect(await p.eval<boolean>(`document.getElementById("account").hidden`), "Escape closes it");
  ok("in the editor, your avatar opens the menu");

  // Sharing with people, from the editor: its owner adds someone, sees them listed, and takes them off again.
  await clickOn(p, "#btn-people");
  await until(() => p.eval<boolean>(`!document.getElementById("sharing").hidden && !!document.querySelector("#sharing-list li")`), 5000, "the people button opens who has the document");
  await p.eval(`(() => { const f = document.getElementById("sharing-add"); f.elements.login.value = "ada"; f.elements.role.value = "viewer"; f.requestSubmit(); })()`);
  await until(() => p.eval<boolean>(`[...document.querySelectorAll("#sharing-list li")].some((li) => li.textContent.startsWith("ada") && li.querySelector("select")?.value == "viewer")`), 5000, "adding someone lists them, with their role");
  await p.screenshot(join(SHOTS, "account-share-people.png"));
  await p.eval(`[...document.querySelectorAll("#sharing-list li")].find((li) => li.textContent.startsWith("ada")).querySelector(".remove").click()`);
  await until(() => p.eval<boolean>(`![...document.querySelectorAll("#sharing-list li")].some((li) => li.textContent.startsWith("ada"))`), 5000, "and taking them off unlists them");
  const order = await p.eval<string>(`[...document.querySelectorAll(".chrome-top > button:not([hidden]), .chrome-top > .mode, .chrome-top > a:not([hidden])")].map((e) => e.id).join(" ")`);
  expect(order == "btn-pause btn-track btn-share btn-people btn-settings mode btn-edit", "the controls, right to left from your avatar: edit, view, document settings, share with people, share with an agent, track changes, pause", order);
  await p.key("Escape");
  ok("in the editor, its owner shares it with people");

  // The view switcher: open, each view has its tooltip; a click on the document closes it, leaving the view as it was.
  await clickOn(p, '#mode button[aria-checked="true"]');
  await until(() => p.eval<boolean>(`document.getElementById("mode").classList.contains("open")`), 3000, "the view switcher opens");
  const tips = await p.eval<string[]>(`[...document.querySelectorAll("#mode button")].map((b) => b.dataset.tip + "|" + (b.title || ""))`);
  expect(tips.length == 3 && tips.every((t) => /^(Page|Markdown|HTML)/.test(t) && t.endsWith("|")), "each view has the controls' own tooltip (no browser one)", tips);
  await p.click(550, 500);
  await until(() => p.eval<boolean>(`!document.getElementById("mode").classList.contains("open")`), 3000, "a click on the document closes it");
  expect(!(await p.eval<boolean>(`document.body.classList.contains("source")`)) && (await p.eval<string>(`document.querySelector('#mode button[aria-checked="true"]').dataset.mode`)) == "text", "and the view stays the page");
  ok("the view switcher closes on a click outside it, leaving the view as it was");

  // Out of the editor and back, without leaving the page: the address and the controls change; the document doesn't move.
  const h1 = async () => (await p.inPage<number | null>(`document.querySelector("h1") ? Math.round(document.querySelector("h1").getBoundingClientRect().top) : null`)).find((t) => t != null) ?? null;
  const visible = (sel: string) => p.eval<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && getComputedStyle(el).visibility != "hidden" && getComputedStyle(el).opacity == "1"; })()`);
  const editingTop = await h1();
  // Neither the document nor anything around it bounces past its ends (macOS's rubber band), so the controls never move.
  const still = `getComputedStyle(document.documentElement).overscrollBehaviorY`;
  const bounce = async () => [await p.eval<string>(still), ...(await p.inFrames<string>(still)), ...(await p.inPage<string>(still))].filter((v) => v != null);
  expect((await bounce()).every((v) => v == "none"), "editing, nothing bounces past its ends", await bounce());
  await p.eval(`window.__samePage = true`);
  await clickOn(p, "#btn-edit");
  await until(async () => (await p.eval<string>("location.pathname")) == at.replace(/\/edit$/, "") && await visible(".erga-view-buttons") && !(await visible("#erga-editor")), 5000, "the pencil goes back to the viewer");
  await until(async () => (await h1()) != null, 5000, "the viewer's page shows");
  const viewingTop = await h1();
  expect((await bounce()).every((v) => v == "none") && (await bounce()).length >= 3, "nor viewing", await bounce());
  expect(!(await p.eval<boolean>(`!!document.querySelector(".erga-crumbs")`)) && await p.eval<string>(`getComputedStyle(document.getElementById("nav-docs")).visibility`) == "hidden", "viewing, there are no breadcrumbs");
  expect(editingTop != null && viewingTop == editingTop, "the viewer shows, with the document where it was", { editingTop, viewingTop });
  await p.screenshot(join(SHOTS, "account-viewing-from-editor.png"));
  await clickOn(p, ".erga-edit-button");
  await until(async () => (await p.eval<string>("location.pathname")) == at && await visible("#erga-editor") && !(await visible(".erga-view-buttons")), 5000, "the pencil goes back into the editor");
  expect(await p.eval<boolean>(`window.__samePage === true`), "and neither reloaded the page");
  await p.send("Runtime.evaluate", { expression: "history.back()" });
  await until(async () => (await p.eval<string>("location.pathname")) == at.replace(/\/edit$/, "") && await visible(".erga-view-buttons"), 5000, "Back goes to the viewer too");
  ok("the pencil switches between viewing and editing without a reload, the document staying put");

  // The editor's breadcrumbs: Documents and the title on one baseline, the title's descenders (g, y, p) not clipped, light and dark;
  // the arrow midway between the two words' ink (not their boxes); a long title still ends in an ellipsis.
  // (A zero-size inline-block's bottom sits on its line's baseline; a canvas measures each text's ink from where its box starts.)
  const crumbs = () => p.eval<{ docs: number; title: number; room: number; descent: number; scrollH: number; clientH: number; ellipsis: boolean; gapL: number; gapR: number }>(`(() => {
    const base = (el) => { const i = document.createElement("i"); i.style.cssText = "display:inline-block;width:0;height:0"; el.appendChild(i); const y = i.getBoundingClientRect().bottom; i.remove(); return y; };
    const docs = document.querySelector("#nav-back span"), title = document.getElementById("doc-title-text");
    const ctx = document.createElement("canvas").getContext("2d"); ctx.font = getComputedStyle(title).font;
    const t = base(title);
    const nb = document.getElementById("nav-back"), ink = (el, text, pseudo) => { const cs = getComputedStyle(el, pseudo); ctx.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily; return ctx.measureText(text); };
    const d = ink(docs, docs.textContent), a = ink(nb, "›", "::after"), ti = ink(title, title.textContent);
    const dr = docs.getBoundingClientRect(), tr = title.getBoundingClientRect();
    const arrow = dr.right + (parseFloat(getComputedStyle(nb).columnGap) || 0) + parseFloat(getComputedStyle(nb, "::after").marginLeft);
    const gapL = arrow - a.actualBoundingBoxLeft - (dr.left + d.actualBoundingBoxRight), gapR = tr.left - ti.actualBoundingBoxLeft - (arrow + a.actualBoundingBoxRight);
    return { gapL, gapR, docs: base(docs), title: t, room: title.getBoundingClientRect().bottom - t, descent: ctx.measureText(title.textContent).actualBoundingBoxDescent,
      scrollH: title.scrollHeight, clientH: title.clientHeight, ellipsis: title.scrollWidth > title.clientWidth };
  })()`);
  const crumbsAt = (await get("/new")).headers.get("location")!;
  const crumbsId = ((await (await get(`${crumbsAt.replace(/\/edit$/, "")}/api/name`)).json()) as { id: string }).id;
  const retitle = async (title: string) => {
    const r = await get(`/d/${crumbsId}/api/name`, { method: "POST", headers: { "Content-Type": "application/json", Origin: root }, body: JSON.stringify({ title, slug: "gyp" }) });
    expect(r.ok, `renamed to ${title}`, await r.text());
  };
  await retitle("Gyp jogging plan");
  for (const dark of [false, true]) {
    await p.open(`${root}/tester/gyp/edit`, { width: 1100, height: 720, scale: 2, dark, clear: false });
    await until(() => p.eval<boolean>(`document.getElementById("doc-title-text").textContent == "Gyp jogging plan"`), 15_000, "the editor shows the title");
    const m = await crumbs();
    expect(Math.abs(m.docs - m.title) < 0.5, `Documents and the title share a baseline (${dark ? "dark" : "light"})`, m);
    expect(m.scrollH <= m.clientH && m.room >= m.descent, `the title's descenders aren't clipped (${dark ? "dark" : "light"})`, m);
    expect(Math.abs(m.gapL - m.gapR) <= 1 && m.gapL > 6, `the arrow is midway between Documents and the title, ink to ink (${dark ? "dark" : "light"})`, m);
    await p.screenshot(join(SHOTS, `account-crumbs-${dark ? "dark" : "light"}.png`));
  }
  await retitle("A long gypsy jogging plan title that keeps going on past any reasonable width for a breadcrumb");
  await until(() => p.eval<boolean>(`document.getElementById("doc-title-text").textContent.startsWith("A long")`), 10_000, "the editor follows the rename");
  const long = await crumbs();
  expect(long.ellipsis && Math.abs(long.docs - long.title) < 0.5 && long.room >= long.descent, "a long title is cut short with an ellipsis, on the same baseline, descenders whole", long);
  expect((await p.eval<string>(`getComputedStyle(document.getElementById("doc-title-text")).textOverflow`)) == "ellipsis", "with an ellipsis");
  ok("the editor's breadcrumbs share a baseline and show the title's descenders, the arrow midway between them, light and dark; a long title ends in an ellipsis");

  // Sign out: nobody (locally too), and the corner offers to sign in, coming back here.
  await p.open(`${root}/docs`, { width: 1100, height: 720, scale: 2, clear: false });
  await clickOn(p, "[data-erga-account] button");
  await clickOn(p, `.erga-account-menu a[href="/auth/logout"]`);
  await until(async () => (await p.eval<string>("location.pathname")) == "/", 10_000, "signing out goes to the front page");
  await p.open(`${root}/nobody-here`, { width: 1100, height: 720, scale: 2, clear: false });
  c = await corner(p);
  expect(c.state == "out" && c.label == "Sign in" && !c.img, "signed out, a person in a circle", c);
  await clickOn(p, "[data-erga-account] button");
  c = await corner(p);
  expect(c.open && c.links.length == 1 && c.links[0].text == "Sign in" && c.links[0].href == "/auth/github?next=%2Fnobody-here", "clicking it offers only Sign in, back to this page", c);
  await p.screenshot(join(SHOTS, "account-signed-out.png"));
  await p.open(`${root}/nobody-here`, { width: 390, height: 760, scale: 2, dark: true, clear: false });
  await clickOn(p, "[data-erga-account] button");
  await p.screenshot(join(SHOTS, "account-signed-out-phone-dark.png"));
  await p.open(`${root}/nobody-here`, { width: 1100, height: 720, scale: 2, clear: false });
  await clickOn(p, "[data-erga-account] button");
  await clickOn(p, ".erga-account-github");
  await until(async () => (await corner(p)).state == "in", 10_000, "signed in again");
  expect((await p.eval<string>("location.pathname")) == "/nobody-here", "back on the same page");
  ok("signed out: the person icon's menu has only Sign in, which comes back to the same page, signed in");

  // Signed out, a document's address asks you to sign in first; the sign-in starts at GitHub's
  // (locally the dev server stands in for it) and comes back to where you were going.
  const out = await get("/auth/logout", { method: "POST", headers: { Origin: root } });
  const outCookie = out.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  const signedOut = await (await get("/docs", { headers: { Cookie: outCookie } })).headers.get("location");
  expect(signedOut == "/auth/github?next=%2Fdocs", "signed out, /docs asks you to sign in first", signedOut);
  const outFront = await (await get("/", { headers: { Cookie: outCookie } })).text();
  expect(outFront.includes('data-erga-account="out"') && outFront.includes('href="/auth/github?next=%2F"'), "and the front page's corner offers it", outFront.slice(-1200));
  ok("signed out, pages say so and offer to sign in");
} finally {
  browser.close();
  await host.dispose();
}
console.log(`\n${checks.length} checks passed (screenshots in ${SHOTS})`);
