#!/usr/bin/env bun
// The homepage, served directly (home.ts, worker/home.ts): / is the front
// page's document rendered on the app's own site, from its last deploy, with
// Erga's controls on top in a shadow root, and no frame.
//
//   - On a fresh server, the first / is the viewer (the frame) and starts the
//     first deploy; then / is served directly.
//   - It looks the same as the viewer on that document, pixel for pixel
//     (text aside, which a frame rasterizes a little differently), light and
//     dark, desktop and phone, and every element of the page is where the
//     viewer puts it.
//   - The page's styles don't reach the controls, nor theirs the page; the
//     page's files (styles, images, files at the root) load.
//   - Only admins may edit the homepage: it can't be made the homepage while
//     anyone else may edit it, nobody else can be made its editor, and an
//     editor who is no longer an admin only views it. Non-admins can't change
//     it or deploy it. The session cookie is out of the page's reach.
//   - A change deploys about ERGA_HOME_DELAY_MS later, each change pushing it
//     back; Redeploy now deploys at once; every step is told to the document's
//     open tabs ({ type: "home" }); a failed deploy leaves the last one serving.
//   - isHome sets and clears landing_document; clearing it, the next / makes
//     a fresh homepage from landing/; a locked setting can't be changed.
//
//   bun tests/home.ts

import { join } from "path";
import { Browser, Page, SHOTS } from "./cdp";
import { diffPng, shoot, VIEWS } from "./home-shots";
import { startHost, type Host } from "./host";
import { expect, until } from "./suite/harness";

// A deploy's delay; an edit reaches the deploys once a version is cut, IDLE after it (ERGA_VERSION_IDLE_MS).
const DELAY = 4000;
const IDLE = 200;
const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

const host = await startHost(null, { env: { ERGA_HOME_DELAY_MS: String(DELAY), ERGA_HOME_RECHECK_MS: "0", ERGA_VERSION_IDLE_MS: String(IDLE) } });
const root = host.root;
const browser = await Browser.launch();
const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });
const post = (path: string, body?: unknown, user?: string) =>
  get(`${path}${user ? `?user=${user}` : ""}`, { method: "POST", headers: { Origin: root, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
interface Home { isHome: boolean; canSet: boolean; blocked: string | null; deploy: { state: string; at: string | null; scheduledFor: string | null; version: number | null; error: string | null }; error?: string }
const home = async (id: string, user?: string) => await (await get(`/api/docs/${id}/home${user ? `?user=${user}` : ""}`)).json() as Home;
/** / as served: directly (from a deploy), or the viewer's frame. */
const front = async () => { const r = await get("/"); const html = await r.text(); return { html, direct: html.includes("<erga-controls"), timing: r.headers.get("server-timing") ?? "", headers: r.headers }; };

let token = "";
const publish = async (files: Record<string, string>, opts: { document?: string; title?: string } = {}) => {
  const r = await get("/api/publish", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ files, ...opts }) });
  const body = await r.json() as { ok: boolean; id?: string; url?: string; error?: string };
  expect(body.ok, "published", body);
  return body;
};
/** An agent token for DEV_LOGIN on the server at `base`, made at /tokens (asked again for a while: a server just started may still be setting up its database). */
const mintToken = async (base: string) => {
  let page = "";
  for (let i = 0; i < 50; i++) {
    page = await (await fetch(`${base}/tokens/new`, { method: "POST", body: new URLSearchParams({ label: "Home test" }), headers: { Origin: base }, redirect: "manual" })).text();
    const t = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(page)?.[1];
    if (t) return t;
    await Bun.sleep(200);
  }
  throw new Error(`no token from ${base}/tokens/new: ${page.slice(0, 300)}`);
};
const idOf = async (address: string) => ((await (await get(`${address}/api/doc`)).json()) as { docName: { id: string } }).docName.id;

try {
  // ---------------------------------------------------------------- the first /
  const first = await front();
  expect(!first.direct && first.html.includes('<iframe id="frame"'), "the first / is the viewer: there's no deploy yet", first.html.slice(0, 300));
  let now = await front();
  await until(async () => (now = await front()).direct, 15_000, "/ is served directly once the first deploy is done", () => now.html.slice(0, 300));
  expect(/home;desc="(home|memory|cache)"/.test(now.timing), "from the snapshot", now.timing);
  expect(!now.html.includes("<iframe id=\"frame\"") && now.html.includes("<h1>Erga"), "the page itself, no frame", now.html.slice(0, 300));
  expect((now.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'self'") && now.headers.get("cache-control") == "private, no-cache", "its headers", Object.fromEntries(now.headers));
  const landingId = await idOf("/tester/landing");
  const status = await home(landingId);
  expect(status.isHome && status.canSet && status.deploy.state == "deployed" && !!status.deploy.at && status.deploy.error == null, "GET /home says it's the homepage, deployed", status);
  ok("on a fresh server the first / is the viewer and starts the first deploy; then / is the page itself, from the deploy");

  // ---------------------------------------------------------------- looks the same
  // The viewer on the same document (/tester/landing, in its frame) is what / was. / differs in one way: the page starts below
  // the controls' band (58px), so they never cover its top. Everything else is the same, pixel for pixel: the band (the
  // controls over the page's background) is the viewer's top 58px, and the page under it is the viewer's, moved down.
  const BAND = 58;
  /** Where the viewer's page starts (0 while its frame fills the window; lower if the viewer gets a band of its own). */
  const viewerTop = async (v: (typeof VIEWS)[number]) => {
    const q = await browser.page(await browser.context());
    await q.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: v.mobile });
    await q.send("Page.enable");
    await q.navigate(`${root}/tester/landing`);
    const top = await q.eval<number>(`Math.round(document.getElementById("frame").getBoundingClientRect().top)`);
    q.close();
    return top;
  };
  for (const v of VIEWS) {
    const a = join(SHOTS, `home-viewer-${v.name}.png`), b = join(SHOTS, `home-direct-${v.name}.png`);
    await shoot(browser, `${root}/tester/landing`, v, a);
    await shoot(browser, `${root}/`, v, b);
    const shift = BAND - (await viewerTop(v));
    const s = v.scale;
    // Text a frame draws comes out a shade softer or sharper: blurred a little, only what moved or changed colour counts.
    // Below the controls in both (the viewer's sit over its page).
    const below = { a: BAND * s, b: (BAND + shift) * s, height: (v.height - BAND - shift - 4) * s }; // (the last rows: the blur's edge)
    const page = await diffPng(browser, a, b, 24, 1.5, below);
    const band = await diffPng(browser, a, b, 24, 1.5, { a: 0, b: 0, height: Math.min(BAND, 44) * s });
    expect(page.differ / page.total < 0.002, `the page under the band looks as the viewer shows it (${v.name})`, { ...page, a, b });
    expect(band.differ / band.total < 0.002, `the band looks as the viewer's top does: the controls on the page's background (${v.name})`, { ...band, a, b });
    const exact = await diffPng(browser, a, b, 8, 0, below);
    console.log(`     ${v.name}: below the band, ${exact.differ} of ${exact.total} pixels differ at all, ${page.differ} once blurred; the band ${band.differ} (${a} / ${b})`);
  }
  ok("/ looks as the viewer shows its document, the page moved below the controls' band: light and dark, desktop and phone (pixel diff)");

  // Every block of the page laid out where the viewer lays it out, moved down by the band (its live demos, which animate,
  // aside: their blocks count, not what moves in them).
  const layout = `JSON.stringify([...document.body.querySelectorAll("main, header, footer, section, article, nav, figure, h1, h2, h3, h4, p, ul, ol, blockquote, table")].filter((e) => !e.closest("erga-controls")).map((e) => { const r = e.getBoundingClientRect(); return [e.tagName, Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)]; }))`;
  for (const v of [VIEWS[0], VIEWS[2]]) {
    // (Measured in the viewer's frame, its blocks start at 0 wherever the frame sits: on the page, they're BAND lower.)
    const shift = BAND;
    const pv = await browser.page(await browser.context()), pd = await browser.page(await browser.context());
    for (const [p, url] of [[pv, `${root}/tester/landing`], [pd, `${root}/`]] as const) {
      await p.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await p.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: v.mobile });
      await p.send("Page.enable");
      await p.navigate(url);
    }
    let viewer = "";
    await until(async () => { viewer = (await pv.inPage<string>(`document.fonts.ready.then(() => ${layout})`)).find((x) => x) ?? ""; return viewer.length > 100; }, 15_000, "the viewer's page");
    const direct = await pd.eval<string>(`document.fonts.ready.then(() => ${layout})`);
    const va = (JSON.parse(viewer) as number[][]).map(([t, x, y, w, h]) => [t, x, y + shift, w, h]), da = JSON.parse(direct) as unknown[][];
    const at = va.findIndex((e, i) => JSON.stringify(e) != JSON.stringify(da[i]));
    expect(at < 0 && va.length == da.length, `every block where the viewer puts it, below the band (${v.name})`, { at, count: [va.length, da.length], viewer: va.slice(at, at + 4), direct: da.slice(at, at + 4) });
    pv.close(); pd.close();
  }
  ok("every block of the page is where the viewer puts it, moved below the band (desktop and phone)");

  // ---------------------------------------------------------------- controls: who sees what
  const p = await browser.page(await browser.context());
  await p.open(`${root}/`, { width: 1200, height: 800 });
  const controls = () => p.eval<{ clone: string | null; edit: string | null; account: string | null; inBody: boolean }>(`(() => { const r = document.querySelector("erga-controls")?.shadowRoot; return { clone: r?.querySelector(".erga-clone-button")?.getAttribute("href") ?? null, edit: r?.querySelector(".erga-edit-button")?.getAttribute("href") ?? null, account: r?.querySelector(".erga-account")?.dataset.ergaAccount ?? null, inBody: !!document.body.querySelector("erga-controls") }; })()`);
  let c = await controls();
  expect(c.clone == "/new?from=landing" && c.edit == "/tester/landing#edit" && c.account == "in" && !c.inBody, "its owner gets Clone, Edit (the document's address, #edit) and their avatar, outside the page's body", c);
  await p.eval(`document.querySelector("erga-controls").shadowRoot.querySelector(".erga-account-btn").click()`);
  expect(await p.eval<boolean>(`!document.querySelector("erga-controls").shadowRoot.querySelector(".erga-account-menu").hidden`), "the avatar opens its menu");
  await p.click(600, 500);
  expect(await p.eval<boolean>(`document.querySelector("erga-controls").shadowRoot.querySelector(".erga-account-menu").hidden`), "a click on the page closes it");
  await p.open(`${root}/?user=Bo`, { width: 1200, height: 800 });
  c = await controls();
  expect(c.clone == "/new?from=landing&user=Bo" && c.edit == null && c.account == "in", "someone else gets Clone and no Edit", c);
  await p.navigate(`${root}/auth/logout`);
  await p.navigate(`${root}/`);
  c = await controls();
  expect(c.edit == null && c.account == "out", "signed out: Clone and Sign in", c);
  await p.navigate(`${root}/auth/github`);
  ok("the controls: Clone for everyone, Edit for its editors, and who you are, with its menu");

  // ---------------------------------------------------------------- isolation, files
  token = await mintToken(root);
  const page = (text: string, extra = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>Second home</title><link rel="stylesheet" href="style.css">
<style>
  /* Everything it can throw at the controls. */
  a, div, button, svg, span, img { color: rgb(255, 0, 0) !important; background: rgb(0, 255, 0) !important; width: 300px !important; display: block !important; font-size: 40px !important; }
  erga-controls { display: none !important; position: static !important; opacity: 0 !important; }
  body { transform: translateX(0); }
  .bg { background-image: url(img/dot.svg); }
</style></head>
<body><h1>${text}</h1><div class="erga-view-buttons" id="probe">not a control</div><p class="bg" id="bg">x</p><img id="pic" src="img/dot.svg">${extra}
<script>fetch("data.json").then((r) => r.json()).then((d) => { document.body.dataset.data = d.ok; });</script>
</body></html>`;
  const files = { "index.html": page("Second home"), "style.css": "h1 { color: rgb(1, 2, 3) !important; }", "img/dot.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#123"/></svg>`, "data.json": `{"ok":"yes"}` };
  const second = await publish(files, { title: "Second home" });
  const secondId = second.id!;
  // ---------------------------------------------------------------- switching
  const before = await home(secondId);
  expect(!before.isHome && before.canSet && before.blocked == null && before.deploy.state == "idle", "a document that isn't the homepage", before);
  // Its tab hears every change ({ type: "home" }).
  const events: unknown[] = [];
  const ws = new WebSocket(`${root.replace(/^http/, "ws")}/d/${secondId}/api/events`);
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type == "home") events.push(m); };
  await new Promise((r) => (ws.onopen = r));
  let set = await (await post(`/api/docs/${secondId}/home`, { isHome: true })).json() as Home;
  expect(set.isHome && ["deploying", "deployed"].includes(set.deploy.state), "POST /home {isHome: true} makes it the homepage, deploying at once", set);
  expect((await home(landingId)).isHome == false, "the old one isn't any more");
  await until(async () => (now = await front()).html.includes("<h1>Second home</h1>") && now.direct, 15_000, "/ is the new homepage, served directly", () => now.html.slice(0, 200));
  await until(async () => events.length >= 2, 5000, "its tab hears of it", () => events);
  ok("isHome: true makes another document the homepage (landing_document), deployed at once, and its tabs hear of it");

  const q = await browser.page(await browser.context());
  await q.open(`${root}/`, { width: 1200, height: 800 });
  const iso = await q.eval<Record<string, unknown>>(`(async () => {
    const host = document.querySelector("erga-controls"), r = host.shadowRoot;
    const rect = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const probe = getComputedStyle(document.getElementById("probe"));
    await new Promise((ok) => { const t = setInterval(() => { if (document.body.dataset.data) { clearInterval(t); ok(); } }, 20); setTimeout(ok, 3000); });
    return {
      hostShown: getComputedStyle(host).display, hostPosition: getComputedStyle(host).position,
      clone: rect(r.querySelector(".erga-clone-button")), cloneColor: getComputedStyle(r.querySelector(".erga-clone-button")).color,
      account: rect(r.querySelector(".erga-account-btn")),
      probePosition: probe.position, probeTop: probe.top,
      h1: getComputedStyle(document.querySelector("h1")).color,
      bg: getComputedStyle(document.getElementById("bg")).backgroundImage, pic: document.getElementById("pic").naturalWidth,
      picSrc: document.getElementById("pic").getAttribute("src"), css: document.querySelector('link[rel="stylesheet"]').getAttribute("href"),
      data: document.body.dataset.data ?? null, cookie: document.cookie,
    };
  })()`);
  expect(iso.hostShown == "block" && iso.hostPosition == "fixed", "the page's CSS can't hide or move the controls' host", iso);
  expect(JSON.stringify(iso.clone) == JSON.stringify([1074, 12, 34, 34]) && iso.cloneColor == "rgb(161, 161, 169)" && JSON.stringify(iso.account) == JSON.stringify([1154, 14, 30, 30]), "nor restyle the controls (where the viewer has them: Clone, Edit, then the avatar)", iso);
  expect(iso.probePosition == "static", "the controls' styles don't reach the page (its own .erga-view-buttons)", iso);
  expect(iso.h1 == "rgb(1, 2, 3)" && /\/_home\/[a-z0-9]+\/img\/dot\.svg/.test(String(iso.bg)) && iso.pic == 4 && iso.data == "yes", "its stylesheet, its images (in CSS too) and a file its script fetches all load", iso);
  expect(/^\/_home\/[a-z0-9]+\/style\.css$/.test(String(iso.css)) && /^\/_home\/[a-z0-9]+\/img\/dot\.svg$/.test(String(iso.picSrc)), "from the deploy's own addresses", iso);
  const cssAt = await get(String(iso.css));
  expect(cssAt.ok && /immutable/.test(cssAt.headers.get("cache-control") ?? "") && (await cssAt.text()).includes("rgb(1, 2, 3)"), "kept for good (they never change)", Object.fromEntries(cssAt.headers));
  expect((await (await get("/data.json")).text()) == `{"ok":"yes"}` && (await (await get("/style.css")).text()).includes("--") , "its files at the root too, but never in place of the app's own (/style.css)");
  expect(!String(iso.cookie).includes("erga_session"), "the page can't read the session cookie", iso);
  await q.screenshot(join(SHOTS, "home-isolation.png"));
  q.close();
  ok("the page's styles can't reach the controls, nor theirs the page; its files load from the deploy");

  // ---------------------------------------------------------------- security
  const signIn = await get("/auth/github?as=Ada");
  const cookie = signIn.headers.get("set-cookie") ?? "";
  expect(/erga_session=[^;]+;.*HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie), "the session cookie is HttpOnly", cookie);
  // Bo (a user) can't change the homepage or deploy it, nor edit it.
  expect((await post(`/api/docs/${secondId}/home`, { isHome: false }, "Bo")).status == 404, "Bo can't even see a document that isn't shared with him");
  await get(`/docs/share`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ id: secondId, login: "bo", role: "viewer" }) });
  const boView = await home(secondId, "Bo");
  expect(boView.isHome && !boView.canSet, "Bo, a viewer, may not set it", boView);
  expect((await post(`/api/docs/${secondId}/home`, { isHome: false }, "Bo")).status == 403 && (await post(`/api/docs/${secondId}/home/deploy`, undefined, "Bo")).status == 403, "nor clear it, nor deploy it");
  const editor = await (await get(`/docs/share`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ id: secondId, login: "bo", role: "editor" }) })).json() as { error?: string };
  expect(/only admins may edit it/.test(editor.error ?? ""), "nobody but an admin can be made its editor", editor);
  const anyone = await (await get(`/docs/share`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ id: secondId, login: "*", role: "editor" }) })).json() as { error?: string };
  expect(/only admins may edit it/.test(anyone.error ?? ""), "nor anyone with the link", anyone);
  // Cross-site, refused.
  expect((await get(`/api/docs/${secondId}/home/deploy`, { method: "POST", headers: { Origin: "https://evil.example" } })).status == 403, "another site can't deploy it");
  // A document someone else may edit can't become the homepage.
  const third = await publish({ "index.html": "<!doctype html><title>Third</title><h1>Third</h1>" }, { title: "Third" });
  await get(`/docs/share`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ id: third.id!, login: "bo", role: "editor" }) });
  const thirdHome = await home(third.id!);
  expect(/bo may edit this document/.test(thirdHome.blocked ?? ""), "GET /home says why it can't be the homepage", thirdHome);
  const refused = await post(`/api/docs/${third.id}/home`, { isHome: true });
  expect(refused.status == 403 && /Only admins may edit the front page/.test(((await refused.json()) as Home).error ?? ""), "POST refuses it, saying why");
  // An admin editor who's made a user only views it.
  await get("/admin/users", { method: "POST", headers: { Origin: root, Accept: "application/json" }, body: new URLSearchParams({ do: "role", login: "bo", role: "admin" }) });
  const now2 = await (await get(`/docs/share`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ id: secondId, login: "bo", role: "editor" }) })).json() as { error?: string; permissions?: unknown[] };
  expect(!now2.error, "an admin can be its editor", now2);
  const boDoc = async () => ((await (await get(`/d/${secondId}/api/doc?user=Bo`)).json()) as { canEdit?: boolean }).canEdit;
  expect(await boDoc() === true, "and edits it");
  await get("/admin/users", { method: "POST", headers: { Origin: root, Accept: "application/json" }, body: new URLSearchParams({ do: "role", login: "bo", role: "user" }) });
  await until(async () => (await boDoc()) === false, 15_000, "made a user, Bo only views it (users are remembered ten seconds)");
  expect(!(await (await get("/?user=Bo")).text()).includes("erga-edit-button"), "and gets no Edit on /");
  await get(`/docs/share`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ id: secondId, login: "bo", role: "" }) }).catch(() => {});
  ok("only admins may edit the homepage: not made one while others may edit it, no non-admin editors, an ex-admin only views; the cookie is HttpOnly");

  // ---------------------------------------------------------------- debounce, events
  events.length = 0;
  const gen = () => /\/_home\/([a-z0-9]+)\//.exec(now.html)?.[1];
  const firstGen = gen();
  await publish({ ...files, "index.html": page("Edited once") }, { document: secondId });
  let s = await home(secondId);
  await until(async () => (s = await home(secondId)).deploy.state == "scheduled", 10_000, "an edit schedules a deploy", () => s);
  const firstFor = Date.parse(s.deploy.scheduledFor!);
  expect(firstFor - Date.now() <= DELAY && firstFor - Date.now() > 0, "for the delay after it", s);
  expect((await front()).html.includes("<h1>Second home</h1>"), "meanwhile / is still the last deploy");
  await Bun.sleep(400);
  await publish({ ...files, "index.html": page("Edited twice") }, { document: secondId });
  await until(async () => Date.parse((s = await home(secondId)).deploy.scheduledFor ?? "0") > firstFor, 10_000, "another edit pushes it back", () => s);
  await until(async () => (s = await home(secondId)).deploy.state == "deployed", 15_000, "then it deploys", () => s);
  now = await front();
  expect(now.html.includes("<h1>Edited twice</h1>") && gen() != firstGen, "/ is the last edit", { h1: /<h1>[^<]*/.exec(now.html)?.[0], gen: gen(), firstGen, s, events });
  const states = events.length;
  expect(states >= 3, "its tabs heard each step (scheduled, deploying, deployed)", events);
  ok("edits deploy the delay after the last of them (debounced), each step told to the document's tabs");

  // ---------------------------------------------------------------- redeploy now, failure
  await publish({ ...files, "index.html": page("Right now") }, { document: secondId });
  const forced = await (await post(`/api/docs/${secondId}/home/deploy`)).json() as Home;
  expect(["deploying", "deployed"].includes(forced.deploy.state), "Redeploy now deploys at once", forced);
  await until(async () => (now = await front()).html.includes("<h1>Right now</h1>"), 3000, "/ follows at once, not after the delay", () => now.html.slice(0, 200));
  const lastAt = (await home(secondId)).deploy.at;
  await publish({ ...files, "index.html": page("Broken", "<!-- erga:test-fail-deploy -->") }, { document: secondId });
  await post(`/api/docs/${secondId}/home/deploy`);
  await until(async () => (s = await home(secondId)).deploy.state == "failed", 10_000, "a deploy that fails says so", () => s);
  expect(/asks for its deploy to fail/.test(s.deploy.error ?? "") && s.deploy.at == lastAt, "with why, and the last good one's time", s);
  now = await front();
  expect(now.direct && now.html.includes("<h1>Right now</h1>"), "and / keeps serving the last good deploy", now.html.slice(0, 200));
  await publish({ ...files, "index.html": page("Fixed") }, { document: secondId });
  await post(`/api/docs/${secondId}/home/deploy`);
  await until(async () => (s = await home(secondId)).deploy.state == "deployed" && (now = await front()).html.includes("<h1>Fixed</h1>"), 10_000, "fixed, it deploys again", () => s);
  ok("Redeploy now deploys at once; a failed deploy says why and the last good one keeps serving");

  // ---------------------------------------------------------------- clearing it
  const cleared = await (await post(`/api/docs/${secondId}/home`, { isHome: false })).json() as Home;
  expect(!cleared.isHome && cleared.deploy.state == "idle", "isHome: false clears landing_document", cleared);
  await until(async () => { now = await front(); return !now.html.includes("Fixed") && (now.html.includes("<h1>Erga") || now.html.includes('<iframe id="frame"')); }, 10_000, "the next / makes a fresh homepage from landing/", () => now.html.slice(0, 300));
  await until(async () => (now = await front()).direct && now.html.includes("<h1>Erga"), 15_000, "and serves it directly once deployed", () => now.html.slice(0, 300));
  ok("isHome: false clears it: the next / makes a fresh homepage from landing/ and deploys it");
  ws.close();
  p.close();

  // A deploy that locks landing_document: nobody can change it here.
  const locked: Host = await startHost(null, { env: { ERGA_SERVER_CONFIG: JSON.stringify({ landing_document: null }), ERGA_HOME_DELAY_MS: String(DELAY), ERGA_VERSION_IDLE_MS: String(IDLE) } });
  try {
    const lr = (path: string, init: RequestInit = {}) => fetch(locked.root + path, { redirect: "manual", ...init });
    const t = await mintToken(locked.root);
    const made = await (await lr("/api/publish", { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ files: { "index.html": "<h1>Mine</h1>" } }) })).json() as { id: string };
    expect(/^[a-z0-9]{8}$/.test(made.id ?? ""), "a document on the locked server", made);
    const g = await (await lr(`/api/docs/${made.id}/home`)).json() as Home;
    expect(!g.isHome && !g.canSet, "a locked landing_document: canSet is false", g);
    const r = await lr(`/api/docs/${made.id}/home`, { method: "POST", headers: { Origin: locked.root, "Content-Type": "application/json" }, body: JSON.stringify({ isHome: true }) });
    expect(r.status == 409, "and POST is refused", { status: r.status, body: await r.text() });
  } finally { await locked.dispose(); }
  ok("a landing_document the deploy locks can't be changed (canSet false, POST refused)");

  console.log(`\n${checks.length} checks passed`);
} catch (e) {
  console.error(e);
  console.error(host.output().slice(-3000));
  process.exitCode = 1;
} finally {
  browser.close();
  await host.dispose();
}
