#!/usr/bin/env bun
// The front page is a document like any other (the landing_document
// setting), and the repo's landing project gets there one way: published
// through the server's API (landing.ts), by the dev server as it starts and
// by the deploy afterwards.
//
//   - A dev server with a landing project (ERGA_LANDING=landing) publishes it
//     as DEV_LOGIN's /tester/landing, and / shows it, in a frame on the
//     document's own pages origin, with Edit and Clone; /new?from=landing
//     copies it. Restarted, it publishes into the same document.
//   - `bun landing.ts <server>`, the deploy's step, with an admin's token
//     (ERGA_DEPLOY_TOKEN) republishes a changed project into that document,
//     and / shows the change; without a token, or with a non-admin's, it
//     stops and says why.
//   - Only a document's owner may make it the front page; /admin shows the
//     setting with the document's address.
//
// Screenshots of / and /admin land in tests/cdp.ts's SHOTS.
//
//   bun tests/landing.ts

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const ROOT = new URL("../", import.meta.url).pathname;
const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };
const landingHtml = readFileSync(join(ROOT, "landing/index.html"), "utf8");

const host = await startHost(null, { env: { ERGA_LANDING: "landing" } });
const root = host.root;
const scratch = mkdtempSync(join(tmpdir(), "erga-landing-"));
const browser = await Browser.launch();
try {
  // As the dev server starts, it publishes the landing project and makes it the front page.
  await until(() => /landing page: landing_document is now \/tester\/landing/.test(host.output()), 30_000, "the dev server publishes the landing project", () => host.output().slice(-3000));
  const get = (path: string, init: RequestInit = {}) => fetch(root + path, { redirect: "manual", ...init });
  const front = await (await get("/")).text();
  const frameSrc = /<iframe id="frame" class="erga-view" src="([^"]+)"/.exec(front)?.[1]?.replaceAll("&amp;", "&");
  expect(frameSrc && /^http:\/\/[a-z0-9]{8}-tester\.localhost:\d+\/t\/[^/]+\/\?view=index\.html$/.test(frameSrc), "/ frames the landing document on its own pages origin", front.slice(0, 1500));
  // The frame's host page shows the document's page, its index, straight away.
  const hostPage = await (await fetch(frameSrc.replace(/^http:\/\/[^/]+/, root), { headers: { Host: new URL(frameSrc).host } })).text();
  expect(hostPage.includes('<iframe id="view" class="on" src="doc/index.html"'), "whose host page shows its index straight away", hostPage.slice(0, 800));
  const src = frameSrc.replace(/\?view=index\.html$/, "doc/index.html");
  expect(front.includes("<title>Erga</title>") && front.includes('href="/new?from=landing"') && front.includes('href="/tester/landing/edit"'), "titled by it, with Clone (a copy) and, for its editor, Edit");
  const id = /^http:\/\/([a-z0-9]{8})-/.exec(src)![1];
  const served = await (await fetch(src.replace(/^http:\/\/[^/]+/, root), { headers: { Host: new URL(src).host } })).text();
  expect(served == landingHtml, "the frame serves the published landing/index.html", served.slice(0, 300));
  ok("the dev server publishes landing/ as /tester/landing, and / shows it on its own origin");

  // The setting names it (by id); /admin shows it with its address.
  const p = await browser.page(await browser.context());
  await p.open(`${root}/admin`, { width: 1100, height: 760, scale: 2 });
  const row = await p.eval<{ value: string; meta: string; link: string }>(`(() => { const li = document.querySelector('li.setting[data-key="landing_document"]'); return { value: li.querySelector("[name=value]").value, meta: li.querySelector(".meta").textContent, link: li.querySelector("a.open-doc")?.getAttribute("href") ?? "" }; })()`);
  expect(row.value == "/tester/landing" && row.link == "/tester/landing" && row.meta.includes("set by tester"), "/admin shows landing_document as the document's address, set by the deploying admin", row);
  await p.screenshot(join(SHOTS, "landing-admin.png"));
  ok("/admin shows the landing document by its address");

  // In a real browser: the front page shows the document, its own page in the frame.
  await p.open(`${root}/`, { width: 1100, height: 760, scale: 2 });
  await until(async () => (await p.inPage<string>(`document.querySelector("h1")?.textContent ?? ""`)).some((t) => t == "Erga"), 15_000, "the landing page renders in its frame");
  expect(await p.eval<boolean>(`!!document.querySelector("a.erga-clone-button[href='/new?from=landing']") && !!document.querySelector("a.erga-edit-button[href='/tester/landing/edit']")`), "with Edit and Clone over it");
  await p.screenshot(join(SHOTS, "landing-front.png"));
  ok("in headless Chrome, / renders the landing document with Edit and Clone");

  // Clone makes your own copy of it, in the editor.
  const made = await get("/new?from=landing");
  const at = made.headers.get("location") ?? "";
  expect(made.status == 302 && at.startsWith("/tester/") && at.endsWith("/edit"), "/new?from=landing makes a document, and opens its editor", { status: made.status, at });
  const copyId = ((await (await get(`${at.replace(/\/edit$/, "")}/api/name`)).json()) as { id: string }).id;
  expect(copyId != id && (await (await get(`/d/${copyId}/doc/index.html`)).text()) == landingHtml, "a copy of the landing document");
  ok("/new?from=landing copies the landing document");

  // The deploy's step: a token of the admin's, and a changed project, republished into the same document.
  const minted = await (await get("/tokens/new", { method: "POST", body: new URLSearchParams({ label: "Deploy" }), headers: { Origin: root } })).text();
  const token = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(minted)?.[1];
  expect(token, "an admin's token, made at /tokens", minted.slice(0, 300));
  const project = join(scratch, "landing");
  cpSync(join(ROOT, "landing"), project, { recursive: true });
  writeFileSync(join(project, "index.html"), landingHtml.replace("<h1>Erga</h1>", "<h1>Erga, deployed</h1>"));
  writeFileSync(join(project, "extra.css"), "body { outline: 0; }\n");
  const deploy = (env: Record<string, string>) => {
    const r = Bun.spawnSync(["bun", join(ROOT, "landing.ts"), root], { env: { ...process.env, ERGA_LANDING: project, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  let run = deploy({ ERGA_DEPLOY_TOKEN: token! });
  expect(run.code == 0 && run.out.includes("republished") && run.out.includes("/tester/landing"), "bun landing.ts republishes the project", run.out);
  let again = "";
  await until(async () => (again = await (await get("/")).text()).includes("<title>Erga, deployed</title>"), 10_000, "/ shows the republished page (its title follows the heading)", () => again.slice(0, 800));
  expect(again.includes(`${id}-tester.localhost`), "into the same document", again.slice(0, 800));
  expect((await (await get(`/d/${id}/doc/extra.css`)).text()).includes("outline"), "with its new files");
  ok("bun landing.ts (the deploy's step) republishes a changed project into the same document");

  // Without a token, or with someone's who isn't an admin, it stops and says why.
  run = deploy({ ERGA_DEPLOY_TOKEN: "" });
  expect(run.code == 1 && run.out.includes("ERGA_DEPLOY_TOKEN"), "without a token it says what it needs", run.out);
  const ada = await fetch(`${root}/auth/github?as=Ada&next=/docs`, { redirect: "manual" });
  const adaCookie = ada.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="))!;
  const adaMinted = await (await get("/tokens/new", { method: "POST", body: new URLSearchParams({ label: "Not an admin" }), headers: { Origin: root, Cookie: adaCookie } })).text();
  const adaToken = /<pre class="secret">(erga_[^<]+)<\/pre>/.exec(adaMinted)?.[1];
  run = deploy({ ERGA_DEPLOY_TOKEN: adaToken! });
  expect(run.code == 1 && run.out.includes("admin's agent token"), "a non-admin's token is refused, saying it needs an admin's", run.out);
  ok("without a token, or with a non-admin's, the deploy's step stops and says why");

  // Only its owner may make a document the front page: an admin who isn't refused.
  const tool = async (t: string, name: string, args: unknown) => {
    const r = await fetch(`${root}/api/ext/tools/${name}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return { status: r.status, body: await r.json() as { ok: boolean; error?: string } };
  };
  const adaDoc = JSON.parse(((await tool(adaToken!, "create_document", { files: { "index.html": "<h1>Ada's page</h1>" } })).body as unknown as { content: { text: string }[] }).content[0].text) as { id: string; address: string };
  const refused = await tool(token!, "set_setting", { key: "landing_document", value: adaDoc.address });
  expect(!refused.body.ok && /Only its owner \(ada\)/.test(refused.body.error ?? ""), "an admin can't make someone else's document the front page", refused);
  ok("only a document's owner may make it the front page");

  // Restarted, the dev server publishes into the same document again.
  await host.stop();
  await host.start();
  await until(() => /landing page: republished/.test(host.output()), 30_000, "the dev server republishes on restart", () => host.output().slice(-3000));
  let restarted = "";
  await until(async () => (restarted = await (await get("/")).text()).includes("<title>Erga</title>"), 10_000, "back to the repo's landing/", () => restarted.slice(0, 800));
  expect(restarted.includes(`${id}-tester.localhost`), "into the same document", restarted.slice(0, 800));
  ok("restarted, the dev server republishes landing/ into the same document");

  // Unset, the front page is a plain start page (with a hint for admins).
  const reset = await fetch(`${root}/admin/settings`, { method: "POST", headers: { Origin: root }, body: new URLSearchParams({ key: "landing_document", reset: "1" }) });
  expect(reset.ok, "an admin resets landing_document", await reset.text());
  const plain = await (await get("/")).text();
  expect(plain.includes("<h1>Erga</h1>") && plain.includes("landing_document") && !plain.includes("erga-view"), "unset, / is a plain start page, telling an admin how to set one", plain.slice(0, 1500));
  await p.open(`${root}/`, { width: 1100, height: 760, scale: 2 });
  await p.screenshot(join(SHOTS, "landing-unset.png"));
  ok("unset, / is a plain start page");
} finally {
  browser.close();
  await host.dispose();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${checks.length} checks passed (screenshots in ${SHOTS})`);
