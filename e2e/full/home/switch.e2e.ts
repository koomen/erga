// Making another document the homepage: its deploys, its files, isolation from the controls, and who may.
import { expect, servers, test } from "../../helpers/fixtures";
import { events, someone } from "../versions/versions";
import { adminToken, deployed, fresh, front, get, home, openHome, publish, redeploy, resetLanding, setLanding } from "./home";
import { runTool } from "../../helpers/tools";

await servers.short();
test.afterEach(async () => { await resetLanding(await servers.short()); });

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

/** A second document of DEV_LOGIN's (published with an admin token), made the homepage on /admin (landing_document). */
async function secondHome() {
  const server = await servers.short();
  const landing = await fresh(server);
  const token = await adminToken(server);
  const { id } = await publish(server, token, files, { title: "Second home" });
  expect((await setLanding(server, id)).error).toBeUndefined();
  expect((await home(server, id)).isHome).toBe(true);
  await expect.poll(async () => { const f = await front(server); return f.direct && f.html.includes("<h1>Second home</h1>"); }).toBe(true);
  return { server, token, id, landing };
}

test("landing_document makes another document the homepage, deployed at once, and its tabs hear of it", async () => {
  const server = await servers.short();
  const landing = await fresh(server);
  await deployed(server);
  const { id } = await publish(server, await adminToken(server), files, { title: "Second home" });
  expect(await home(server, id)).toEqual({ isHome: false });
  const heard = await events(server, id);
  try {
    expect((await setLanding(server, id)).error).toBeUndefined();
    const set = await home(server, id);
    expect(set).toMatchObject({ isHome: true, canDeploy: true });
    expect(["deploying", "deployed"]).toContain(set.deploy.state);
    expect((await home(server, landing.id)).isHome).toBe(false);
    await expect.poll(async () => { const f = await front(server); return f.direct && f.html.includes("<h1>Second home</h1>"); }).toBe(true);
    await expect.poll(() => heard.of("home").length).toBeGreaterThanOrEqual(2);
  } finally { heard.close(); }
});

test("the page's styles can't reach the controls, nor theirs the page; its files load from the deploy, and at the root, never over the app's", async ({ tab }) => {
  const { server } = await secondHome();
  await tab.page.setViewportSize({ width: 1200, height: 800 });
  await openHome(tab.page, server.root);
  await expect.poll(() => tab.page.evaluate(() => document.body.dataset.data ?? null)).toBe("yes");
  // (The bars take the page's tone once the script has its colour: the icons ease to it.)
  await expect
    .poll(() =>
      tab.page.evaluate(
        () => getComputedStyle(document.querySelector("erga-controls")!.shadowRoot!.querySelector(".erga-agent-share")!).color
      )
    )
    .toBe("rgb(154, 154, 162)");
  const iso = await tab.page.evaluate(() => {
    const host = document.querySelector("erga-controls")!, r = host.shadowRoot!;
    const rect = (e: Element) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const probe = getComputedStyle(document.getElementById("probe")!);
    return {
      hostShown: getComputedStyle(host).display,
      hostPosition: getComputedStyle(host).position,
      agent: rect(r.querySelector(".erga-agent-share")!),
      agentColor: getComputedStyle(r.querySelector(".erga-agent-share")!).color,
      account: rect(r.querySelector(".erga-account-btn")!),
      probePosition: probe.position,
      h1: getComputedStyle(document.querySelector("h1")!).color,
      bg: getComputedStyle(document.getElementById("bg")!).backgroundImage, pic: (document.getElementById("pic") as HTMLImageElement).naturalWidth,
      picSrc: document.getElementById("pic")!.getAttribute("src"), css: document.querySelector('link[rel="stylesheet"]')!.getAttribute("href"),
      cookie: document.cookie,
    };
  });
  expect(iso).toMatchObject({ hostShown: "block", hostPosition: "fixed" });
  // Where the viewer has them, signed out: Share with an agent (no Documents), then Sign in.
  expect(iso).toMatchObject({ agent: [1108, 12, 34, 34], agentColor: "rgb(154, 154, 162)", account: [1154, 14, 30, 30] });
  expect(iso.probePosition).toBe("static");
  expect(iso.h1).toBe("rgb(1, 2, 3)");
  expect(iso.bg).toMatch(/\/_home-files\/[a-z0-9]+\/img\/dot\.svg/);
  expect(iso.pic).toBe(4);
  expect(iso.css).toMatch(/^\/_home-files\/[a-z0-9]+\/style\.css$/);
  expect(iso.picSrc).toMatch(/^\/_home-files\/[a-z0-9]+\/img\/dot\.svg$/);
  const css = await get(server, iso.css!);
  expect(css.ok).toBe(true);
  expect(css.headers.get("cache-control") ?? "").toMatch(/immutable/);
  expect(await css.text()).toContain("rgb(1, 2, 3)");
  expect(await (await get(server, "/data.json")).text()).toBe(`{"ok":"yes"}`);
  // (The app's own files are under /_erga/: a name at the root is the homepage's.)
  expect(await (await get(server, "/style.css")).text()).toContain("rgb(1, 2, 3)");
  expect(iso.cookie).not.toContain("erga_session");
});

// Making a user an admin and back: users are remembered ten seconds, so the demotion takes that long to show.
test("only admins may edit the homepage: not made one while others may edit it, no non-admin editors, an ex-admin only views; the cookie is HttpOnly", { timeout: 30_000 }, async () => {
  const { server, token, id } = await secondHome();
  const cookie = (await get(server, "/auth/github?as=Ada")).headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/erga_session(_\d+)?=[^;]+;.*HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Lax/i);
  // Someone of this test's own, so making them an admin touches no other test.
  const bo = someone("bo");
  const share = async (doc: string, login: string, role: string) => ({
    error: (await runTool(server.root, "share_document", { document: doc, login, role })).error,
  });
  expect((await runTool(server.root, "ls", { document: id }, { user: bo })).status).toBe(403);
  await share(id, bo, "viewer");
  expect(await home(server, id, bo)).toMatchObject({ isHome: true, canDeploy: false });
  expect((await redeploy(server, bo)).status).toBe(403);
  expect((await share(id, bo, "editor")).error).toMatch(/only admins may edit it/);
  expect((await share(id, "*", "editor")).error).toMatch(/only admins may edit it/);
  expect((await redeploy(server, undefined, "https://evil.example")).status).toBe(403);
  // A document someone else may edit can't become the homepage.
  const third = await publish(server, token, { "index.html": "<!doctype html><title>Third</title><h1>Third</h1>" }, { title: "Third" });
  await share(third.id, bo, "editor");
  const refused = await setLanding(server, third.id);
  expect(refused.error).toMatch(/Only admins may edit the homepage/);
  expect(refused.error).toMatch(new RegExp(`${bo} may edit this document`));
  // An admin may be its editor; made a user again, they only view it.
  const role = (r: string) => runTool(server.root, "set_user", { action: "role", login: bo, role: r });
  await role("admin");
  expect((await share(id, bo, "editor")).error).toBeUndefined();
  const canEdit = async () => ((await (await get(server, `/d/${id}/api/doc?user=${bo}`)).json()) as { canEdit?: boolean }).canEdit;
  expect(await canEdit()).toBe(true);
  await role("write");
  await expect.poll(canEdit, { timeout: 15_000 }).toBe(false);
  expect(await (await get(server, `/d/${id}?user=${bo}`, { redirect: "follow" })).text()).not.toContain("erga-edit-button");
});

// An edit doesn't deploy: / stays as it was until someone deploys.
test("an edit never deploys by itself; a deploy puts the document live, each step told to the document's tabs", {
  timeout: 25_000,
}, async () => {
  const { server, token, id } = await secondHome();
  const heard = await events(server, id);
  try {
    const gen = (html: string) => /\/_home-files\/([a-z0-9]+)\//.exec(html)?.[1];
    const firstGen = gen((await front(server)).html);
    const live = (await home(server, id)).deploy.version;
    await publish(server, token, { ...files, "index.html": page("Edited once") }, { document: id });
    await expect.poll(async () => (await runTool(server.root, "versions", { document: id })).result?.current.n).toBeGreaterThan(live ?? 0);
    const after = await home(server, id);
    expect([after.deploy.state, after.deploy.version]).toEqual(["deployed", live]);
    expect((await front(server)).html).toContain("<h1>Second home</h1>");
    await redeploy(server);
    await expect
      .poll(async () => (await home(server, id)).deploy.state == "deployed" && (await front(server)).html.includes("<h1>Edited once</h1>"))
      .toBe(true);
    expect(gen((await front(server)).html)).not.toBe(firstGen);
    expect(heard.of("home").length).toBeGreaterThanOrEqual(2);
  } finally { heard.close(); }
});

type Redeployed = {
  deploy: { state: string; version: number | null; error: string | null };
  live: { url: string; files: Record<string, string> } | null;
};

test("redeploy answers when the deploy is done: the new version and the live files' addresses; a failed deploy says why and the last good one keeps serving; fixed, it deploys again", async () => {
  const { server, token, id } = await secondHome();
  await publish(server, token, { ...files, "index.html": page("Right now"), "data.json": `{"ok":"new"}` }, { document: id });
  const current = (await runTool(server.root, "versions", { document: id })).result?.current.n;
  const done = (await redeploy(server)).result as Redeployed;
  expect([done.deploy.state, done.deploy.version]).toEqual(["deployed", current]);
  expect(done.live?.url).toBe(`${server.root}/`);
  expect(done.live?.files["data.json"]).toMatch(new RegExp(`^${server.root}/_home-files/[a-z0-9]+/data\\.json$`));
  expect(await (await fetch(done.live!.files["data.json"])).text()).toBe(`{"ok":"new"}`);
  expect((await front(server)).html).toContain("<h1>Right now</h1>");
  const lastAt = (await home(server, id)).deploy.at;
  await publish(server, token, { ...files, "index.html": page("Broken", "<!-- erga:test-fail-deploy -->") }, { document: id });
  const failed = (await redeploy(server)).result as Redeployed;
  expect(failed.deploy.state).toBe("failed");
  expect(failed.live?.files["data.json"]).toBe(done.live?.files["data.json"]);
  const s = await home(server, id);
  expect(s.deploy.error).toMatch(/asks for its deploy to fail/);
  expect(s.deploy.at).toBe(lastAt);
  const now = await front(server);
  expect(now.direct).toBe(true);
  expect(now.html).toContain("<h1>Right now</h1>");
  await publish(server, token, { ...files, "index.html": page("Fixed") }, { document: id });
  await redeploy(server);
  await expect.poll(async () => (await home(server, id)).deploy.state == "deployed" && (await front(server)).html.includes("<h1>Fixed</h1>")).toBe(true);
});

test("a reset landing_document clears it: the next / makes a fresh homepage from assets/landing/ and deploys it", async () => {
  const { server, id } = await secondHome();
  await resetLanding(server);
  expect(await home(server, id)).toEqual({ isHome: false });
  await expect.poll(async () => { const f = (await front(server)).html; return !f.includes("Second home") && (f.includes(`<h1 class="logo"`) || f.includes('<iframe id="frame"')); }).toBe(true);
  await expect.poll(async () => { const f = await front(server); return f.direct && f.html.includes(`<h1 class="logo"`); }).toBe(true);
});
