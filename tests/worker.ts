#!/usr/bin/env bun
// The front door's own routes (front.ts), against a Worker running locally
// (`bun run dev:worker`, with DEV_LOGIN in .dev.vars) or the local host:
// /new makes a blank document, /docs lists it and follows its edits, a
// document nobody edits goes by itself (and looking at it isn't editing
// it), and a deleted one is gone.
//
//   bun tests/worker.ts [http://localhost:5173]
//   bun tests/worker.ts --local        the local host (open.ts), started with scratch data
//
// Each run signs in as a fresh person, so it starts from an empty list.

import { readFileSync } from "fs";
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

/** Makes a document and returns its id. */
async function make(query = ""): Promise<string> {
  const r = await get(`/new${query}`);
  const at = r.headers.get("location") ?? "";
  expect(r.status == 302 && at.startsWith(`/${login}/`), `/new${query} makes a document under /${login}/`, { status: r.status, at });
  return at.split("/")[2];
}

/** A participant in a document's room, as the suite's client joins one. */
function join(id: string, name = "Ada"): Promise<Participant> {
  const doc = { base: `${base}/${login}/${id}`, path: "index.html", roomUrl: `${base.replace(/^http/, "ws")}/${login}/${id}/api/room`, roomName: "doc", headersFor: () => ({ Cookie: cookie }) } as unknown as Doc;
  return Participant.join(doc, name);
}

const exists = async (id: string) => (await get(`/${login}/${id}`)).status == 200;
const checks: string[] = [];
const ok = (what: string) => { checks.push(what); console.log(`ok   ${what}`); };

try {
  expect((await docs()).includes("No documents yet"), "a new person's list is empty");
  ok("a new person's list is empty");

  // /new: a blank document, listed as unedited.
  const blank = await make();
  expect((await (await get(`/${login}/${blank}/doc/index.html`)).text()) == template("doc"), "/new is a copy of templates/doc");
  let list = await docs();
  expect(list.includes(`href="/${login}/${blank}"`) && list.includes(">Untitled<") && list.includes("Unedited"), "the list shows it, untitled and unedited", list);
  ok("/new makes a blank document, listed as unedited");
  expect((await (await get(`/${login}/${await make("?from=demo")}/doc/index.html`)).text()) == template("demo"), "/new?from=demo copies the demo");
  ok("/new?from=demo copies the demo");

  // Opening it, being in its room and moving a caret aren't edits.
  expect(await exists(blank), "the editor opens it");
  const ada = await join(blank);
  ada.setCursor(10);
  await sleep(1500);
  expect((await docs()).includes("Unedited"), "still unedited after opening it and moving a caret");
  ok("opening a document and moving a caret don't count as editing it");

  // An edit does: the list takes its heading as the title, and it stays.
  ada.edit((t) => { const i = t.toString().indexOf("<h1>Untitled"); t.delete(i + 4, 8); t.insert(i + 4, "Field &amp; notes"); });
  await until(async () => (list = await docs()).includes(">Field &amp; notes<"), 5000, "the list shows the new title", () => list);
  // The title and the edit's time are recorded separately, so the mark can go a moment after the title changes.
  await until(async () => !(list = await docs()).slice(list.indexOf(`/${login}/${blank}"`)).split("</li>")[0].includes("Unedited"), 5000, "an edited document isn't marked unedited", () => list);
  ok("an edit retitles the document in the list, and keeps it");

  // Nobody edits it: it goes on time. One that's edited, or open, stays.
  const [gone, kept, open] = [await make("?unedited=2000"), await make("?unedited=2000"), await make("?unedited=2000")];
  const bo = await join(kept, "Bo"), cy = await join(open, "Cy");
  bo.insertAfter("<p>", "Bo was here. ");
  await sleep(4000);
  expect(!(await exists(gone)), "the unedited document is gone");
  expect(await exists(kept), "the edited one stays");
  expect(await exists(open), "the one someone has open stays (for now)");
  list = await docs();
  expect(!list.includes(`/${login}/${gone}"`) && list.includes(`/${login}/${kept}"`), "the list follows", list);
  ok("an unedited document is deleted on time; edited or open ones stay");
  for (const p of [ada, bo, cy]) p.destroy();

  // The page runs on the document's own origin: the editor names it, with a token that opens the document's files there.
  // (Browsers send <anything>.localhost to this machine; Bun's fetch doesn't, so it's told the host instead.)
  const pagesFetch = (u: string) => { const url = new URL(u); return url.hostname.endsWith(".localhost") ? fetch(u.replace(url.host, `localhost:${url.port}`), { headers: { Host: url.host } }) : fetch(u); };
  const editorHtml = await (await get(`/${login}/${blank}`)).text();
  const pagesUrl = /<meta name="erga-pages" content="([^"]+)">/.exec(editorHtml)?.[1] ?? "";
  const pages = pagesUrl ? new URL(pagesUrl) : null;
  expect(!!pages && pages.hostname.startsWith(`${blank}-${login}.`) && pages.origin != new URL(base).origin, "the editor names the document's own origin", pagesUrl);
  const frameDoc = await pagesFetch(pagesUrl);
  expect(frameDoc.status == 200 && (frameDoc.headers.get("content-security-policy") ?? "").includes(`frame-ancestors ${new URL(base).origin}`), "which serves the page editor's frame, only to this site", frameDoc.headers.get("content-security-policy"));
  expect((await (await pagesFetch(`${pagesUrl}doc/index.html`)).text()) == (await (await get(`/${login}/${blank}/doc/index.html`)).text()), "and the document's files, without a cookie");
  const forged = pagesUrl.replace(/\/t\/([^/.]+)\.[^/]+\//, "/t/$1.forged/");
  expect((await pagesFetch(`${forged}doc/index.html`)).status == 403, "a forged token opens nothing");
  expect((await pagesFetch(`${pages!.origin.replace(blank, "aaaaaaaa")}${pages!.pathname}doc/index.html`)).status == 403, "nor does a good one, at another document's origin");
  expect((await pagesFetch(`${pages!.origin}/docs`)).status == 404, "and none of this site's own pages are there");
  ok("a document's page runs on its own origin, whose files open only with the editor's token");

  // Another site can't make documents for you: its link gets a button instead, which posts from here.
  const before = await docs();
  const linked = await get("/new?from=demo", { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(linked.status == 200 && (await linked.text()).includes(`<form method="post" action="/new?from=demo">`), "a link from another site asks first");
  expect((await docs()) == before, "and makes nothing");
  expect((await get("/new", { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status == 200, "a form from another site asks too");
  const posted = await get("/new?from=demo", { method: "POST", headers: { Origin: new URL(base).origin } });
  expect(posted.status == 302 && (posted.headers.get("location") ?? "").startsWith(`/${login}/`), "the button makes the document");
  ok("another site's link or form to /new asks first; the button makes it");

  // Signing in never sends you off the site, however the address is dressed up.
  for (const next of ["//elsewhere.example", "/\\elsewhere.example", "/\t/elsewhere.example", "https://elsewhere.example"]) {
    const r = await fetch(`${base}/auth/github?as=${login}&next=${encodeURIComponent(next)}`, { redirect: "manual" });
    expect(r.headers.get("location") == "/", `sign-in won't go to ${JSON.stringify(next)}`, r.headers.get("location"));
  }
  ok("sign-in's next= stays on the site");

  // Deleting: only from this site's pages, and then it's gone.
  const form = (headers: Record<string, string>) => get("/docs/delete", { method: "POST", body: new URLSearchParams({ id: kept }), headers });
  expect((await form({})).status == 403, "a delete without an Origin is refused");
  expect((await form({ Origin: new URL(base).origin })).status == 303, "a delete from the list goes through");
  expect(!(await exists(kept)) && !(await docs()).includes(`/${login}/${kept}"`), "the deleted document is gone, and off the list");
  ok("a document deleted from the list is gone");
} catch (e) {
  console.error(`FAIL ${(e as Error).message}`);
  await local?.dispose();
  process.exit(1);
}
await local?.dispose();
console.log(`\n${checks.length} passed`);
process.exit(0);
