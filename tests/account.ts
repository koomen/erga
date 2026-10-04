#!/usr/bin/env bun
// Who you are, in the upper right of every page (account.ts):
//
//   - signed in, your avatar (your GitHub picture, your initial if it doesn't
//     load), on /docs, /admin, /tokens, the front page (beside its Edit
//     button), a page that isn't there; clicking it opens a menu: your name,
//     Your documents, Admin (admins only), Sign out;
//   - in the editor, your avatar among its own controls opens the same menu;
//   - signed out (locally: after Sign out), a person in a circle that offers
//     Sign in with GitHub, which comes back to the same page, signed in;
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

const host = await startHost(null, { env: { ERGA_LANDING: "landing" } });
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
  await until(() => /landing_document is now \/tester\/landing/.test(host.output()), 30_000, "the dev server publishes the landing project", () => host.output().slice(-3000));

  // The markup, on every page of the site's own, and nowhere in a document.
  for (const path of ["/", "/docs", "/admin", "/tokens", "/nobody-here"]) {
    const html = await (await get(path)).text();
    expect(html.includes('data-erga-account="in"') && html.includes("https://avatars.githubusercontent.com/tester?s=64"), `${path} has your avatar in its corner`, html.slice(-1500));
  }
  const made = await get("/new");
  const at = made.headers.get("location")!;
  const id = ((await (await get(`${at}/api/name`)).json()) as { id: string }).id;
  const editorHtml = await (await get(at)).text();
  expect(!editorHtml.includes("data-erga-account") && editorHtml.includes('name="erga-account"'), "the editor shows it itself (and is told which links)", editorHtml.slice(0, 400));
  expect(JSON.parse(/name="erga-account" content="([^"]+)"/.exec(editorHtml)![1].replaceAll("&quot;", '"')).admin == "/admin", "an admin's editor menu has Admin");
  const docFile = await (await get(`/d/${id}/doc/index.html`)).text();
  expect(!docFile.includes("data-erga-account"), "a document's own files are left alone", docFile.slice(-400));
  const front = await (await get("/")).text();
  const frameSrc = /<iframe class="erga-landing" src="([^"]+)"/.exec(front)![1].replaceAll("&amp;", "&");
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
  expect(c.open && c.who.includes("tester") && c.links.map((l) => l.text).join() == "Your documents,Admin,Sign out", "clicking it opens your menu", c);
  await p.screenshot(join(SHOTS, "account-docs.png"));
  await p.key("Escape");
  expect(!(await corner(p)).open, "Escape closes it");
  // Its picture failing to load leaves your initial.
  await p.eval(`document.querySelector("[data-erga-account] img")?.dispatchEvent(new Event("error")), true`);
  c = await corner(p);
  expect(!c.img && c.initial == "T" && (await p.eval<string>(`getComputedStyle(document.querySelector("[data-erga-account] button")).backgroundColor`)) != "rgba(0, 0, 0, 0)", "without the picture, your initial on your colour", c);
  ok("on /docs, your avatar opens a menu: your name, Your documents, Admin, Sign out");

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

  // The front page: beside its Edit button, not under it.
  await p.open(`${root}/`, { width: 1100, height: 720, scale: 2, clear: false });
  await until(async () => (await p.inFrames<string>(`document.querySelector("h1")?.textContent ?? ""`)).some((t) => t == "Erga"), 15_000, "the landing page renders in its frame");
  const apart = await p.eval<boolean>(`(() => { const a = document.querySelector("[data-erga-account] button").getBoundingClientRect(), e = document.querySelector("a.erga-edit-button:not(.erga-docs-button)").getBoundingClientRect(); return e.right <= a.left - 4 && Math.abs((e.top + e.bottom) / 2 - (a.top + a.bottom) / 2) < 3; })()`);
  expect(apart, "the avatar sits right of the Edit button, level with it");
  await p.screenshot(join(SHOTS, "account-front.png"));
  ok("on the front page, the avatar sits beside the Edit button");

  // The editor: your avatar, the last of its controls, opens the same menu.
  await p.open(`${root}${at}`, { width: 1100, height: 720, scale: 2, clear: false });
  await until(() => p.eval<boolean>(`!!document.querySelector("#me .avatar")`), 15_000, "the editor shows your avatar");
  const meRect = await p.eval<{ right: number; top: number; img: string | null }>(`(() => { const b = document.querySelector("#me .avatar"), r = b.getBoundingClientRect(); return { right: r.right, top: r.top, img: b.querySelector("img")?.getAttribute("src") ?? null }; })()`);
  expect(meRect.right > 1100 - 30 && meRect.top < 30 && meRect.img?.startsWith("https://avatars.githubusercontent.com/tester"), "far right of the editor's controls, with your GitHub picture", meRect);
  await clickOn(p, "#me .avatar");
  const menu = await p.eval<{ hidden: boolean; expanded: string | null; links: string[] }>(`({ hidden: document.getElementById("account").hidden, expanded: document.querySelector("#me .avatar").getAttribute("aria-expanded"), links: [...document.querySelectorAll("#account a:not([hidden])")].map((a) => a.textContent + " " + a.getAttribute("href")) })`);
  expect(!menu.hidden && menu.expanded == "true" && menu.links.join() == "Your documents /docs,Admin /admin,Sign out /auth/logout", "clicking it opens your menu", menu);
  await Bun.sleep(600);
  expect(!(await p.eval<boolean>(`document.getElementById("account").hidden`)), "and it stays open");
  await p.screenshot(join(SHOTS, "account-editor.png"));
  await p.key("Escape");
  expect(await p.eval<boolean>(`document.getElementById("account").hidden`), "Escape closes it");
  ok("in the editor, your avatar opens the menu");

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
  expect(c.open && c.links.length == 1 && c.links[0].text == "Sign in with GitHub" && c.links[0].href == "/auth/github?next=%2Fnobody-here", "clicking it offers Sign in with GitHub, back to this page", c);
  await p.screenshot(join(SHOTS, "account-signed-out.png"));
  await p.open(`${root}/nobody-here`, { width: 390, height: 760, scale: 2, dark: true, clear: false });
  await clickOn(p, "[data-erga-account] button");
  await p.screenshot(join(SHOTS, "account-signed-out-phone-dark.png"));
  await p.open(`${root}/nobody-here`, { width: 1100, height: 720, scale: 2, clear: false });
  await clickOn(p, "[data-erga-account] button");
  await clickOn(p, ".erga-account-github");
  await until(async () => (await corner(p)).state == "in", 10_000, "signed in again");
  expect((await p.eval<string>("location.pathname")) == "/nobody-here", "back on the same page");
  ok("signed out: the person icon offers Sign in with GitHub, which comes back to the same page, signed in");

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
