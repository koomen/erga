#!/usr/bin/env bun
// The front door's own routes (front.ts), against a Worker running locally
// (`bun run dev:worker`, with DEV_LOGIN in .dev.vars) or the local host:
// /new makes a blank document, /docs lists it and follows its edits, a
// document nobody edits goes by itself (and looking at it isn't editing
// it), and a deleted one is gone. Documents' addresses (/d/<id>,
// /<owner>/<slug>, and the old ones that redirect), titles and slugs that
// follow the page until they're set, renaming (by API, from /docs and by
// the agent's tools over /api/ext), and open tabs following a rename.
//
//   bun tests/worker.ts [http://localhost:5173]
//   bun tests/worker.ts --local        the local host (open.ts), started with scratch data
//
// Each run signs in as a fresh person, so it starts from an empty list.

import { readFileSync } from "fs";
import { Browser } from "./cdp";
import { startHost } from "./host";
import { Participant } from "./suite/client";
import { expect, sleep, until } from "./suite/harness";
import type { Doc } from "./suite/target";

const local = process.argv[2] == "--local" ? await startHost(null, { env: { ERGA_AGENT_MODEL: "script", ERGA_AGENT_ENV_FILE: "/nonexistent/.env" } }) : null;
const base = (local?.base || process.argv[2] || process.env.ERGA_WORKER_URL || "http://localhost:5173").replace(/\/+$/, "");
const login = `wtest${Date.now().toString(36)}`;
const template = (name: string) => readFileSync(new URL(`../templates/${name}/index.html`, import.meta.url), "utf8");

const signedIn = await fetch(`${base}/auth/github?as=${login}&next=/docs`, { redirect: "manual" });
const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("erga_session="));
if (!cookie) throw new Error(`signing in at ${base}: ${signedIn.status} (is DEV_LOGIN set in .dev.vars?)`);
const get = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string>) } });
const docs = async () => (await get("/docs")).text();
const origin = new URL(base).origin;

interface Name { id: string; owner: string; title: string; slug: string; address: string; titleSet: boolean; slugSet: boolean }
/** A document's title and address, from its host. */
const nameOf = async (id: string): Promise<Name> => (await get(`/d/${id}/api/name`)).json() as Promise<Name>;
/** Renames a document through its host, as the editor does. */
const rename = (id: string, patch: { title?: string; slug?: string }) =>
  get(`/d/${id}/api/name`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });

/** Makes a document and returns its id (its address is /<login>/<slug>: the id comes from its host). */
async function make(query = ""): Promise<string> {
  const r = await get(`/new${query}`);
  const at = r.headers.get("location") ?? "";
  expect(r.status == 302 && at.startsWith(`/${login}/`), `/new${query} makes a document under /${login}/`, { status: r.status, at });
  const name = (await (await get(`${at}/api/name`)).json()) as Name;
  expect(name.address == at, "/new sends you to its canonical address", { at, name });
  return name.id;
}

/** A participant in a document's room, as the suite's client joins one. */
function join(id: string, name = "Ada"): Promise<Participant> {
  const doc = { base: `${base}/d/${id}`, path: "index.html", roomUrl: `${base.replace(/^http/, "ws")}/d/${id}/api/room`, roomName: "doc", headersFor: () => ({ Cookie: cookie }) } as unknown as Doc;
  return Participant.join(doc, name);
}

/** Replaces the page's first heading's text. */
const retitle = (p: Participant, from: string, to: string) => p.edit((t) => { const i = t.toString().indexOf(`<h1>${from}`); t.delete(i + 4, from.length); t.insert(i + 4, to); });

const exists = async (id: string) => [200, 302].includes((await get(`/d/${id}`)).status);
const location = async (path: string) => { const r = await get(path); return r.status == 302 ? r.headers.get("location") : `(${r.status})`; };
const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };
const browser = await Browser.launch();

try {
  expect((await docs()).includes("No documents yet"), "a new person's list is empty");
  ok("a new person's list is empty");

  // /new: a blank document, listed as unedited, titled and addressed by its heading.
  const blank = await make();
  let name = await nameOf(blank);
  expect(name.title == "Untitled" && name.slug == "untitled" && !name.titleSet && !name.slugSet, "a blank document is Untitled, at /<you>/untitled", name);
  expect((await (await get(`/${login}/untitled/doc/index.html`)).text()) == template("doc"), "/new is a copy of templates/doc");
  let list = await docs();
  expect(list.includes(`href="/${login}/untitled"`) && list.includes(">Untitled<") && list.includes("Unedited"), "the list shows it, untitled and unedited", list);
  ok("/new makes a blank document at /<you>/untitled, listed as unedited");
  const demo = await make("?from=demo");
  expect((await (await get(`/d/${demo}/doc/index.html`)).text()) == template("demo"), "/new?from=demo copies the demo");
  ok("/new?from=demo copies the demo");

  // Addresses: /d/<id>, /<you>/<id> and a differently cased owner all lead to the canonical one, which is the editor.
  expect(await location(`/d/${blank}`) == `/${login}/untitled`, "/d/<id> redirects to /<you>/<slug>", await location(`/d/${blank}`));
  expect(await location(`/${login}/${blank}?user=Ada`) == `/${login}/untitled?user=Ada`, "/<you>/<id> redirects there, keeping the query");
  expect(await location(`/${login.toUpperCase()}/untitled`) == `/${login}/untitled`, "so does a differently cased owner");
  const editorHtml = await (await get(`/${login}/untitled`)).text();
  expect(editorHtml.includes(`<meta name="erga-base" content="/d/${blank}">`) && editorHtml.includes("<title>Untitled</title>"), "the canonical address is the editor, which talks to /d/<id>", editorHtml.slice(0, 400));
  expect((await get(`/${login}/nothing-here`)).status == 404 && (await get(`/d/zzzzzzzz`)).status == 404, "an address with no document is a 404");
  for (const sub of [`/d/${blank}/api/doc`, `/${login}/untitled/api/doc`, `/${login}/${blank}/api/doc`]) expect((await get(sub)).ok, `the document's host answers under ${sub}`);
  ok("/d/<id>, /<you>/<id> and the canonical /<you>/<slug> all reach the document");

  // A second blank document can't have the same slug: it gets the next free one.
  const second = await make();
  expect((await nameOf(second)).slug == "untitled-2", "a second Untitled document is at /<you>/untitled-2");
  ok("an automatic slug that's taken gets -2");

  // Opening it, being in its room and moving a caret aren't edits.
  expect(await exists(blank), "the editor opens it");
  const ada = await join(blank);
  ada.setCursor(10);
  await sleep(1500);
  expect((await docs()).includes("Unedited"), "still unedited after opening it and moving a caret");
  ok("opening a document and moving a caret don't count as editing it");

  // An edit does: the title follows the heading, the slug follows the title, and it stays.
  retitle(ada, "Untitled", "Field &amp; notes");
  await until(async () => (list = await docs()).includes(">Field &amp; notes<"), 5000, "the list shows the new title", () => list);
  await until(async () => (await nameOf(blank)).slug == "field-notes", 5000, "the slug follows the title");
  expect(list.includes(`href="/${login}/field-notes"`), "the list links to the new address", list);
  // The title and the edit's time are recorded separately, so the mark can go a moment after the title changes.
  await until(async () => !(list = await docs()).slice(list.indexOf(`/${login}/field-notes"`)).split("</li>")[0].includes("Unedited"), 5000, "an edited document isn't marked unedited", () => list);
  expect(await location(`/${login}/untitled`) == `/${login}/field-notes`, "the old slug redirects to the new one", await location(`/${login}/untitled`));
  expect((await get(`/${login}/untitled/api/doc`)).ok, "and requests under the old address still reach it (an older tab's)");
  ok("an edit retitles the document, its slug follows, and the old address redirects");

  // Set by someone, the title stays put when the heading changes; the slug follows it until set too.
  let r = await rename(blank, { title: "Launch plan" });
  name = (await r.json()) as Name;
  expect(r.ok && name.title == "Launch plan" && name.titleSet && name.slug == "launch-plan" && !name.slugSet, "setting the title moves a following slug with it", name);
  retitle(ada, "Field &amp; notes", "Something else");
  await sleep(2600);
  expect((await nameOf(blank)).title == "Launch plan", "a set title doesn't follow the heading");
  r = await rename(blank, { slug: "Q4 Launch!" });
  name = (await r.json()) as Name;
  expect(r.ok && name.slug == "q4-launch" && name.slugSet, "a set slug is made from what's given", name);
  await rename(blank, { title: "Launch plan, final" });
  expect((await nameOf(blank)).slug == "q4-launch", "and stays when the title changes");
  for (const old of ["untitled", "field-notes", "launch-plan"]) expect(await location(`/${login}/${old}`) == `/${login}/q4-launch`, `/${login}/${old} redirects to the current address`);
  // An empty title goes back to following the heading.
  name = (await (await rename(blank, { title: "" })).json()) as Name;
  expect(name.title == "Something else" && !name.titleSet && name.slug == "q4-launch", "an empty title follows the heading again", name);
  ok("a set title or slug stays put; an empty one follows again; every old address redirects");

  // Explicit slugs that are taken or reserved are refused, saying why.
  r = await rename(second, { slug: "q4-launch" });
  let refusal = ((await r.json()) as { error?: string }).error ?? "";
  expect(r.status == 409 && refusal.includes("already"), "a slug another of your documents has is refused", { status: r.status, refusal });
  r = await rename(second, { slug: "docs" });
  refusal = ((await r.json()) as { error?: string }).error ?? "";
  expect(r.status == 409 && refusal.includes("reserved"), "a reserved slug is refused", { status: r.status, refusal });
  // A slug a document only used to have can be taken: the old address goes to its new owner.
  r = await rename(second, { slug: "field-notes" });
  expect(r.ok && (await location(`/${login}/field-notes`)) == `(200)`, "another document can take a slug that's only in the history");
  ok("a taken or reserved slug is refused; an old one can be taken over");

  // From /docs: the list's rename posts to /docs/rename, through the document's host.
  r = await get("/docs/rename", { method: "POST", body: new URLSearchParams({ id: demo, title: "Demo copy", slug: "my-demo" }), headers: { Origin: origin, Accept: "application/json" } });
  expect(r.ok && (await nameOf(demo)).address == `/${login}/my-demo`, "renaming from the list works", await r.text());
  expect((await get("/docs/rename", { method: "POST", body: new URLSearchParams({ id: demo, title: "x" }) })).status == 403, "but only from this site's pages");
  expect((await docs()).includes(`href="/${login}/my-demo"`), "and the list shows it");
  ok("renaming from /docs works");

  // The agent's tools, as an external agent calls them: get_title and set_title.
  const { token } = (await (await get(`/d/${demo}/api/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as { token: string };
  const tool = async (tool: string, args: unknown) => {
    const res = await fetch(`${base}/d/${demo}/api/ext/tools/${tool}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    const body = (await res.json()) as { ok: boolean; content?: { text?: string }[]; error?: string };
    return { status: res.status, text: body.content?.map((c) => c.text ?? "").join("") ?? body.error ?? "" };
  };
  const guide = await (await fetch(`${base}/d/${demo}/api/ext`, { headers: { Authorization: `Bearer ${token}` } })).text();
  expect(guide.includes("set_title") && guide.includes(`/d/${demo}/api/ext`), "the external agent's guide lists the tools and the stable address", guide.slice(0, 300));
  let t = await tool("get_title", {});
  expect(t.status == 200 && t.text.includes("Title: Demo copy") && t.text.includes(`/${login}/my-demo`), "get_title says the title and address", t);
  t = await tool("set_title", { title: "Agent's pick", slug: "" });
  name = await nameOf(demo);
  expect(t.status == 200 && name.title == "Agent's pick" && name.slug == "agents-pick" && !name.slugSet, "set_title renames it (an empty slug follows the title)", { t, name });
  t = await tool("set_title", { slug: "q4-launch" });
  expect(t.status == 400 && t.text.includes("already"), "set_title is refused a taken slug, saying so", t);
  // Share links from before the directory used /<owner>/<id>: they still work.
  expect((await fetch(`${base}/${login}/${demo}/api/ext/tools`, { headers: { Authorization: `Bearer ${token}` } })).ok, "the API under /<owner>/<id> still answers");
  ok("the agent's get_title and set_title work over /api/ext");

  // Open tabs follow a rename: the title, and the address bar (replaceState, no reload).
  const tab = await browser.page();
  await tab.open(`${base}/auth/github?as=${login}&next=${encodeURIComponent(`/${login}/agents-pick`)}`);
  await until(async () => (await tab.eval<string>(`document.getElementById("doc-title-text")?.textContent ?? ""`)) == "Agent's pick", 10_000, "the editor shows the title");
  await tab.eval(`window.__sameTab = true`);
  await rename(demo, { title: "Renamed elsewhere" });
  await until(async () => (await tab.eval<string>(`location.pathname`)) == `/${login}/renamed-elsewhere`, 5000, "the tab's address follows the rename", async () => tab.eval(`location.pathname`));
  expect((await tab.eval<string>(`document.title`)) == "Renamed elsewhere" && (await tab.eval<string>(`document.getElementById("doc-title-text").textContent`)) == "Renamed elsewhere", "and its title");
  expect(await tab.eval<boolean>(`window.__sameTab === true`), "without reloading");
  // A title following the heading moves the tab too.
  await rename(demo, { title: "", slug: "" });
  const bo = await join(demo, "Bo");
  const heading = /<h1[^>]*>([^<]*)<\/h1>/.exec(bo.text()?.toString() ?? "")?.[1] ?? "";
  bo.edit((y) => { const s = y.toString(), i = s.indexOf(heading, s.indexOf("<h1")); y.delete(i, heading.length); y.insert(i, "Heading moves tabs"); });
  await until(async () => (await tab.eval<string>(`location.pathname`)) == `/${login}/heading-moves-tabs`, 6000, "the tab follows a title that follows the heading", async () => tab.eval(`location.pathname`));
  bo.destroy();
  ok("open tabs follow a rename, by anyone or by an edit to the heading, without reloading");

  // Nobody edits it: it goes on time. One that's edited, or open, stays.
  const [gone, kept, open] = [await make("?unedited=2000"), await make("?unedited=2000"), await make("?unedited=2000")];
  const bo2 = await join(kept, "Bo"), cy = await join(open, "Cy");
  bo2.insertAfter("<p>", "Bo was here. ");
  await sleep(4000);
  expect(!(await exists(gone)), "the unedited document is gone");
  expect(await exists(kept), "the edited one stays");
  expect(await exists(open), "the one someone has open stays (for now)");
  list = await docs();
  const keptName = await nameOf(kept);
  expect(!list.includes(`value="${gone}"`) && list.includes(`href="${keptName.address}"`), "the list follows", list);
  ok("an unedited document is deleted on time; edited or open ones stay");
  for (const p of [ada, bo2, cy]) p.destroy();

  // The page runs on the document's own origin: the editor names it, with a token that opens the document's files there.
  // (Browsers send <anything>.localhost to this machine; Bun's fetch doesn't, so it's told the host instead.)
  const pagesFetch = (u: string) => { const url = new URL(u); return url.hostname.endsWith(".localhost") ? fetch(u.replace(url.host, `localhost:${url.port}`), { headers: { Host: url.host } }) : fetch(u); };
  const editorAt = await (await get((await nameOf(second)).address)).text();
  const pagesUrl = /<meta name="erga-pages" content="([^"]+)">/.exec(editorAt)?.[1] ?? "";
  const pages = pagesUrl ? new URL(pagesUrl) : null;
  expect(!!pages && pages.hostname.startsWith(`${second}-${login}.`) && pages.origin != origin, "the editor names the document's own origin", pagesUrl);
  const frameDoc = await pagesFetch(pagesUrl);
  expect(frameDoc.status == 200 && (frameDoc.headers.get("content-security-policy") ?? "").includes(`frame-ancestors ${origin}`), "which serves the page editor's frame, only to this site", frameDoc.headers.get("content-security-policy"));
  expect((await (await pagesFetch(`${pagesUrl}doc/index.html`)).text()) == (await (await get(`/d/${second}/doc/index.html`)).text()), "and the document's files, without a cookie");
  const forged = pagesUrl.replace(/\/t\/([^/.]+)\.[^/]+\//, "/t/$1.forged/");
  expect((await pagesFetch(`${forged}doc/index.html`)).status == 403, "a forged token opens nothing");
  expect((await pagesFetch(`${pages!.origin.replace(second, "aaaaaaaa")}${pages!.pathname}doc/index.html`)).status == 403, "nor does a good one, at another document's origin");
  expect((await pagesFetch(`${pages!.origin}/docs`)).status == 404, "and none of this site's own pages are there");
  ok("a document's page runs on its own origin, whose files open only with the editor's token");

  // Another site can't make documents for you: its link gets a button instead, which posts from here.
  const before = await docs();
  const linked = await get("/new?from=demo", { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(linked.status == 200 && (await linked.text()).includes(`<form method="post" action="/new?from=demo">`), "a link from another site asks first");
  expect((await docs()) == before, "and makes nothing");
  expect((await get("/new", { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status == 200, "a form from another site asks too");
  const posted = await get("/new?from=demo", { method: "POST", headers: { Origin: origin } });
  expect(posted.status == 302 && (posted.headers.get("location") ?? "").startsWith(`/${login}/`), "the button makes the document");
  ok("another site's link or form to /new asks first; the button makes it");

  // Signing in never sends you off the site, however the address is dressed up.
  for (const next of ["//elsewhere.example", "/\\elsewhere.example", "/\t/elsewhere.example", "https://elsewhere.example"]) {
    const res = await fetch(`${base}/auth/github?as=${login}&next=${encodeURIComponent(next)}`, { redirect: "manual" });
    expect(res.headers.get("location") == "/", `sign-in won't go to ${JSON.stringify(next)}`, res.headers.get("location"));
  }
  ok("sign-in's next= stays on the site");

  // Deleting: only from this site's pages, and then it's gone, addresses and all.
  const form = (headers: Record<string, string>) => get("/docs/delete", { method: "POST", body: new URLSearchParams({ id: kept }), headers });
  expect((await form({})).status == 403, "a delete without an Origin is refused");
  expect((await form({ Origin: origin })).status == 303, "a delete from the list goes through");
  expect(!(await exists(kept)) && !(await docs()).includes(`value="${kept}"`) && (await get(keptName.address)).status == 404, "the deleted document is gone, and off the list");
  ok("a document deleted from the list is gone");
} catch (e) {
  console.error(`FAIL ${(e as Error).message}`);
  browser.close();
  await local?.dispose();
  process.exit(1);
}
browser.close();
await local?.dispose();
console.log(`\n${checks.length} passed`);
process.exit(0);
