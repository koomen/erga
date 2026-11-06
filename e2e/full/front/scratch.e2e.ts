// Scratch documents (/scratch): + Scratch on Documents makes one and opens it in the editor at a random address; it
// isn't on the list, an orange Save leads its quick actions (its tip says when it goes, as the tip of + Scratch does), and Save makes it a saved document. Unsaved, it goes on time, edited or
// not. Signed out, /scratch signs in first; another site's link asks first. An agent does the same with its tools.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, settle, test, until } from "../../helpers/fixtures";
import { editor } from "../../helpers/editor";
import { admin, person, resetting, servers, tools } from "./front";
import { runTool } from "../../helpers/tools";
import { ROOT } from "../../helpers/env";
import { signedOut } from "../home/home";

await servers.script();

const SHOTS = join(ROOT, ".e2e/shots/scratch");

test("+ Scratch, whose tip says when a scratch document goes, makes one, off the list, with an orange Save first in its quick actions, whose tip says the same; Save keeps it, at the address of its heading", async ({
  tab,
}) => {
  const p = await person(await servers.script());
  const page = tab.page;
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  // No line under the buttons: + Scratch says when a scratch document goes in its tip, on hover or focus, with Save's card and words.
  const make = page.locator("a.pill.scratch");
  expect(await page.locator(".scratch-note").count()).toBe(0);
  const tipOf = (b: typeof make) =>
    b.evaluate((b) => {
      const s = getComputedStyle(b, "::after");
      return { text: s.content, shown: s.opacity, card: [s.backgroundColor, s.borderRadius, s.fontSize, s.boxShadow].join(" ") };
    });
  const deleted = '"Unsaved scratch docs are deleted in 24h"';
  expect(await make.getAttribute("aria-description")).toBe("Unsaved scratch docs are deleted in 24h");
  expect((await tipOf(make)).shown).toBe("0");
  await page.screenshot({ path: join(SHOTS, "docs.png") });
  await make.hover();
  await expect.poll(async () => (await tipOf(make)).shown).toBe("1");
  const made = await tipOf(make);
  expect(made.text).toBe(deleted);
  await page.screenshot({ path: join(SHOTS, "docs-tip.png") });
  await page.mouse.move(600, 500);
  await expect.poll(async () => (await tipOf(make)).shown).toBe("0");
  await page.keyboard.press("Tab");
  await make.focus();
  await expect.poll(async () => (await tipOf(make)).shown).toBe("1");

  await make.click();
  await page.waitForURL(new RegExp(`/${p.login}/[a-z0-9]{8}\\?edit$`));
  const id = new URL(page.url()).pathname.split("/")[2];
  const ed = editor(page, { address: `${p.base}/${p.login}/${id}`, dir: "", file: "" });
  await ed.loaded();
  // No note over the page: Save is the first of the editor's quick actions, orange, and its tip shows on hover.
  expect(await page.locator("#erga-scratch").count()).toBe(0);
  const save = page.locator("#quick .erga-scratch-save");
  await expect.poll(() => save.isVisible()).toBe(true);
  expect(await save.innerText()).toBe("Save");
  expect(await page.locator("#quick .quick-inner > *:visible").first().getAttribute("class")).toBe("erga-scratch-save");
  expect(await save.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(234, 88, 12)");
  const tip = () =>
    save.evaluate((b) => {
      const s = getComputedStyle(b, "::after");
      return { text: s.content, shown: s.opacity };
    });
  expect((await tip()).shown).toBe("0");
  await save.hover();
  await expect.poll(tip).toEqual({ text: `"Save to your documents list. ${deleted.slice(1)}`, shown: "1" });
  expect((await tipOf(save)).card).toBe(made.card);
  await page.screenshot({ path: join(SHOTS, "tip.png") });
  await page.mouse.move(600, 500);
  // Not on the person's list, nor their agent's.
  expect(await p.docs()).not.toContain(id);
  expect(((await p.tool("list_documents")).result as { id: string }[]).map((d) => d.id)).not.toContain(id);

  // A heading typed, then Save: the note goes, and the address follows the heading, still in the editor.
  await ed.idle();
  await ed.selectAllOf("h1");
  await ed.type("Groceries");
  await ed.shows(`
    # Groceries|

    Start writing here.
  `);
  await settle(page);
  await page.screenshot({ path: join(SHOTS, "scratch.png") });
  await save.click();
  await expect.poll(() => page.locator(".erga-scratch-save").count()).toBe(0);
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/${p.login}/groceries`);
  expect(new URL(page.url()).search).toBe("?edit");
  await page.screenshot({ path: join(SHOTS, "saved.png") });
  const listed = ((await p.tool("list_documents")).result as { id: string; title: string; expires?: string }[]).find((d) => d.id == id);
  expect(listed).toMatchObject({ title: "Groceries" });
  expect(listed?.expires).toBeUndefined();
  expect(p.row(id, await p.docs())).toContain(`href="/${p.login}/groceries?edit"`);

  // Opened again, it is a saved document: no Save.
  await page.goto(`${p.base}/${p.login}/groceries`);
  await settle(page);
  expect(await page.locator(".erga-scratch-save").count()).toBe(0);
});

test("viewed, a scratch document has Save first in the viewer's quick actions; the pencil's editor has it too, and Save there keeps it", async ({
  tab,
}) => {
  const p = await person(await servers.script());
  const page = tab.page;
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  const at = ((await p.get("/scratch")).headers.get("location") ?? "").replace(/\?edit$/, "");
  const id = at.split("/")[2];
  await page.goto(`${p.base}${at}`);
  const view = page.locator(".erga-view-buttons .erga-scratch-save");
  await expect.poll(() => view.isVisible()).toBe(true);
  expect(await page.locator(".erga-view-buttons .quick-inner > *").first().getAttribute("class")).toBe("erga-scratch-save");
  await view.hover();
  await expect.poll(() => view.evaluate((b) => getComputedStyle(b, "::after").opacity)).toBe("1");
  await page.screenshot({ path: join(SHOTS, "viewer.png") });

  await page.locator(".erga-edit-button").click();
  const ed = editor(page, { address: `${p.base}${at}`, dir: "", file: "" });
  await ed.loaded();
  const save = page.locator("#quick .erga-scratch-save");
  await expect.poll(() => save.isVisible()).toBe(true);
  await save.click();
  await expect.poll(() => page.locator(".erga-scratch-save").count()).toBe(0);
  await until(async () => p.row(id, await p.docs()) != "(not listed)", 5000, "the saved document is on the list");
});

test("an unsaved scratch document goes on time, edited or not; a saved one stays", async () => {
  const p = await person(await servers.script());
  /** A scratch document that goes `ms` after it's made (?unedited=, local development only): its id. */
  const scratch = async (ms: number) => {
    const r = await p.get(`/scratch?unedited=${ms}`);
    expect(r.status).toBe(302);
    const at = r.headers.get("location") ?? "";
    expect(at).toMatch(new RegExp(`^/${p.login}/[a-z0-9]{8}\\?edit$`));
    return at.split("/")[2].replace(/\?edit$/, "");
  };
  const [edited, saved] = [await scratch(4000), await scratch(4000)];
  // Edited by the person's agent: a scratch document goes all the same.
  const agent = tools(p.base, await p.token());
  const write = await agent.call("write", {
    document: edited,
    path: "index.html",
    content: "<!doctype html><title>Kept?</title><h1>Kept?</h1>",
  });
  expect(write.status).toBe(200);
  expect((await p.tool("save_document", { document: saved })).status).toBe(200);
  // Made last, so when it's gone the others' time is up too.
  const plain = await scratch(4000);
  await until(async () => !(await p.exists(plain)), 10_000, "the scratch document goes");
  await until(async () => !(await p.exists(edited)), 5000, "the edited scratch document goes");
  expect(await p.exists(saved)).toBe(true);
  expect(p.row(saved, await p.docs())).not.toBe("(not listed)");
});

test("signed out, /scratch signs in first; another site's link asks first and makes nothing", async () => {
  const s = await servers.script();
  const out = await fetch(`${s.root}/scratch`, { redirect: "manual", headers: signedOut(s) });
  expect(out.status).toBe(302);
  expect(out.headers.get("location")).toBe(`/auth/sign-in?next=${encodeURIComponent("/scratch")}`);
  const p = await person(s);
  const linked = await p.get("/scratch", { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(linked.status).toBe(200);
  expect(await linked.text()).toContain(`<form method="post" action="/scratch">`);
});

test("an agent makes a scratch document (create_document, scratch) and saves it (save_document), as its person can", async () => {
  const p = await person(await servers.script());
  const made = await runTool<{ id: string; address: string; expires: string }>(
    p.base,
    "create_document",
    { scratch: true, title: "Notes" },
    { cookie: p.cookie, origin: p.origin }
  );
  expect(made.status).toBe(200);
  const { id, address, expires } = made.result!;
  expect(address).toBe(`/${p.login}/${id}`);
  expect(expires).toContain("unless someone saves it");
  expect(p.row(id, await p.docs())).toBe("(not listed)");
  const saved = await p.tool("save_document", { document: id });
  expect(saved.status).toBe(200);
  expect(saved.result.saved.address).toBe(`/${p.login}/notes`);
  expect(p.row(id, await p.docs())).not.toBe("(not listed)");
  expect((await p.tool("save_document", { document: id })).status).toBe(409);
});

test("scratch documents follow delete_docs_after_hours: one made while it is 7 goes after 7 hours; while it is never, one is never deleted, and the pages say so", async () => {
  const s = await servers.script();
  const a = await admin(s);
  const p = await person(s);
  /** A scratch document's id, and its page as its maker gets it. */
  const scratch = async () => {
    const at = (await p.get("/scratch")).headers.get("location") ?? "";
    const id = at.split("/")[2].replace(/\?edit$/, "");
    return { id, page: await (await p.get(at.replace(/\?edit$/, ""))).text() };
  };
  /** When the agent's answer says it goes (create_document's expires), in hours from now; null if it never goes. */
  const madeFor = async () => {
    const made = await p.tool("create_document", { scratch: true });
    const expires = made.result.expires as string | undefined;
    return expires ? Math.round((Date.parse(expires.split(",")[0]) - Date.now()) / 3_600_000) : null;
  };
  await resetting(s, "delete_docs_after_hours", async () => {
    expect((await a.call("set_setting", { key: "delete_docs_after_hours", value: 7 })).status).toBe(200);
    expect(await p.docs()).toContain(`data-tip="Unsaved scratch docs are deleted in 7h"`);
    expect(await madeFor()).toBe(7);
    expect((await scratch()).page).toContain("Unsaved scratch docs are deleted in 7h");

    expect((await a.call("set_setting", { key: "delete_docs_after_hours", value: null })).status).toBe(200);
    const docs = await p.docs();
    expect(docs).toContain(`data-tip="Not on your documents list until you save it"`);
    expect(docs).not.toContain("Unsaved scratch docs are deleted");
    expect(await madeFor()).toBe(null);
    const never = await scratch();
    expect(never.page).toContain("Save to your documents list.");
    expect(never.page).not.toContain("Unsaved scratch docs are deleted");
    expect(p.row(never.id, docs)).toBe("(not listed)");
  });
});
