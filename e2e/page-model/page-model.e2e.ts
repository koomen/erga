// A page calls a model as its visitor (window.ergaLLM, agents/page-llm.ts): who may, and the limits. The owner turns
// the model on in Document settings, and the page's script gets the model's text. The admin's daily spend limit stops
// all pages' calls, and the admin's switch for guests gives every signed-out visitor "sign_in". Someone signed out may
// call the model only where the owner lets all viewers; else the call gets "sign_in", and the viewer shows one sign-in
// dialog, which comes back to the page. The homepage's pages have the model too, for a visitor signed out: from its
// own pages only, with the page's token, up to the visitor's hour. The model is the scripted one: no real model.
//
// The admin's settings and the day's use are the whole server's, and other files use the server before this one. So
// the spend limit's step reads the day's use first, and each journey puts the settings back at its end.
import { expect, journey, servers, test, type Page } from "../helpers/fixtures";
import {
  ask,
  askIn,
  call,
  haikuCost,
  homeWithEssay,
  newDoc,
  owner,
  pageLlmOf,
  publish,
  resetSetting,
  row,
  setLanding,
  setting,
  signInOpen,
  signInState,
  signOut,
  status,
  tokenIn,
  usage,
  usd,
  useToday,
} from "./model";
import { clickInPage, clickOn } from "../helpers/press";

const s = await servers.main();

journey("a document's page calls the model: its owner, the admin's limits, then someone signed out", () => {
  /** The document's tab, and the admin's tab on the Settings page (the same browser). */
  let page: Page, admin: Page;
  let doc: Awaited<ReturnType<typeof newDoc>>;
  test.afterAll(async () => {
    for (const key of ["page_llm_daily_usd", "page_llm_guests"]) await resetSetting(s, key);
  });

  test("off at first; the owner turns it on in Document settings, and the page's script gets the model's text", async ({ tab }) => {
    page = tab.page;
    doc = await newDoc(s);
    await page.goto(`${doc.address}?edit`); // page load 1: the editor, with the page in its frame
    expect(await status(page)).toEqual({ on: false, model: null, signedIn: true });
    expect((await ask(page, "Hi")).code).toBe("off");
    // The owner ticks it in Document settings: Haiku, as it starts.
    await expect.poll(() => page.evaluate(() => document.body.classList.contains("erga-editor-ready"))).toBe(true);
    await clickOn(page, "#btn-settings");
    await page.locator("#ds-llm-on").waitFor();
    expect(await page.locator("#ds-llm-on").isChecked()).toBe(false);
    expect(await page.locator("#ds-llm-model").inputValue()).toBe("haiku");
    // Who may call it: only while it is on; signed-in viewers, as it starts.
    expect(await page.locator("#ds-llm-who").isVisible()).toBe(false);
    await page.locator("#ds-llm-on").click();
    await expect.poll(() => pageLlmOf(s, doc.id)).toMatchObject({ on: true, model: "haiku", who: "signed_in" });
    await expect.poll(() => page.locator("#ds-llm-who").isVisible()).toBe(true);
    expect(await page.locator("#ds-llm-who").inputValue()).toBe("signed_in");
    await page.locator("#ds-llm-who").selectOption("all");
    await expect.poll(() => pageLlmOf(s, doc.id)).toMatchObject({ on: true, model: "haiku", who: "all" });
    expect(await status(page)).toEqual({ on: true, model: "Haiku 5.5", signedIn: true });
    expect(await ask(page, '@script [{"text": "Hello from the model."}]')).toEqual({ text: "Hello from the model." });
    // Off again: "off". Then on, for the steps after.
    await owner(s, "share_document", { document: doc.id, page_llm: false });
    expect((await ask(page, "Hi")).code).toBe("off");
    await owner(s, "share_document", { document: doc.id, page_llm: true });
    expect(await pageLlmOf(s, doc.id)).toMatchObject({ on: true, who: "all" });
  });

  test("the daily spend limit stops pages' calls at today's estimated cost; the view shows the use; 0 turns them off", async () => {
    // Today's use so far on this server: the calls of the step before, and other files'. All were Haiku's.
    const before = await useToday(s);
    const cost = haikuCost(before.inputTokens, before.outputTokens);
    expect(before.costUsd, "today's calls were all Haiku's").toBe(Math.round(cost * 1000) / 1000);
    // The admin page: the limit, $5 at first.
    admin = await page.context().newPage();
    await admin.goto(`${s.root}/admin/settings`); // page load 2: the Settings page, in a tab of its own
    const limit = row(admin, "page_llm_daily_usd");
    expect(await limit.locator(".key").innerText()).toBe("Pages' models: daily spend limit");
    expect(await limit.locator("input[name=value]").inputValue()).toBe("5");
    expect(await limit.locator(".unit").innerText()).toBe("US$");
    expect(await usage(admin)).toContain(`${usd(cost)} of $5.00 today (${before.limitUsed})`);
    // The admin sets the next cent above today's cost. With no cost before, that is one cent: what 20,000 of Haiku
    // 5.5's output tokens cost ($0.50 for a million).
    const to = (Math.floor(cost * 100 + 1e-6) + 1) / 100;
    const tokens = Math.ceil((to - cost) * 2_000_000 - 1e-6) + (cost > 0 ? 1 : 0);
    await limit.locator("input[name=value]").fill(String(to));
    await limit.locator(".save").click();
    await expect.poll(() => setting(s, "page_llm_daily_usd")).toBe(to);
    // One call that uses all of it; the next gets "limit".
    expect(await ask(page, `@script [{"text": "One.", "tokens": ${tokens}}]`)).toEqual({ text: "One." });
    const stopped = await ask(page, '@script [{"text": "Two."}]');
    expect(stopped.code).toBe("limit");
    expect(stopped.message).toContain("spend limit for today");
    // The view: one call more, its tokens and cost, all of the limit, and the document (two calls: one in the step before).
    await admin.reload(); // page load 3
    const shown = await usage(admin);
    expect(shown).toContain(`${usd(to)} of $${to.toFixed(2)} today (100%)`);
    expect(shown).toContain("Pages' calls stop until midnight UTC.");
    const n = (x: number) => x.toLocaleString("en-US");
    expect((await admin.locator(".use-totals").innerText()).split(/\s*\n\s*/)).toEqual([
      "Calls",
      n(before.calls + 1),
      "Input tokens",
      n(before.inputTokens),
      "Output tokens",
      n(before.outputTokens + tokens),
      "Estimated cost",
      usd(to),
    ]);
    const mine = admin.locator(".use-docs tbody tr", { has: admin.locator(`a[href^="${doc.path}"]`) });
    expect((await mine.locator("td").allInnerTexts()).join(" ")).toBe(`2 0 ${n(tokens)} ${usd(haikuCost(0, tokens))}`);
    // The admin's agent reads the same.
    expect(await useToday(s)).toMatchObject({
      calls: before.calls + 1,
      inputTokens: before.inputTokens,
      outputTokens: before.outputTokens + tokens,
      costUsd: to,
      limitUsd: to,
      limitUsed: "100%",
    });
    // 0: pages' models are off.
    await limit.locator("input[name=value]").fill("0");
    await limit.locator(".save").click();
    await expect.poll(() => setting(s, "page_llm_daily_usd")).toBe(0);
    await admin.reload(); // page load 4
    expect(await usage(admin)).toContain("Pages' models are off");
    expect(await status(page)).toMatchObject({ on: false });
    expect((await ask(page, "Hi")).code).toBe("off");
    // The limit of the start again, for the steps after.
    await resetSetting(s, "page_llm_daily_usd");
    expect(await status(page)).toMatchObject({ on: true });
  });

  test("all viewers: someone signed out may call the model of a document that anyone may open", async () => {
    await owner(s, "share_document", { document: doc.id, login: "*", role: "viewer" });
    await signOut(page, s);
    await page.goto(`${doc.address}#part`); // page load 5: the viewer, signed out
    expect(await status(page)).toEqual({ on: true, model: "Haiku 5.5", signedIn: false });
    expect(await ask(page, '@script [{"text": "Hello, guest."}]')).toEqual({ text: "Hello, guest." });
    expect((await signInState(page)).open).toBeFalsy();
  });

  test("the admin's switch for guests, off: someone signed out gets sign_in, where the owner lets all viewers call the model", async () => {
    // The admin turns the switch off on the Settings page. (Signed in: with no cookie, a browser is the server's own person.)
    await page.context().clearCookies();
    const guests = admin.locator("#set-page_llm_guests");
    expect(await row(admin, "page_llm_guests").locator(".key").innerText()).toBe("Guests can call pages' models");
    expect(await guests.isChecked()).toBe(true);
    await guests.click();
    await expect.poll(() => setting(s, "page_llm_guests")).toBe(false);
    // Signed in: the model still answers. Signed out: sign_in, and the dialog.
    expect(await ask(page, '@script [{"text": "Hello, Ada."}]')).toEqual({ text: "Hello, Ada." });
    await signOut(page, s);
    expect((await ask(page, '@script [{"text": "Hello, guest."}]')).code).toBe("sign_in");
    await expect.poll(() => signInOpen(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => signInOpen(page)).toBe(false);
    // On again: a guest may call it again.
    await page.context().clearCookies();
    await guests.click();
    await expect.poll(() => setting(s, "page_llm_guests")).toBe(true);
    await signOut(page, s);
    expect(await ask(page, '@script [{"text": "Hello again, guest."}]')).toEqual({ text: "Hello again, guest." });
    await admin.close();
  });

  test("signed-in viewers only: each call gets sign_in, and the viewer shows one sign-in dialog, which comes back to the page", async () => {
    await owner(s, "share_document", { document: doc.id, page_llm_who: "signed_in" });
    const frame = page.frameLocator("#frame");
    // Three calls at once: each gets sign_in, and the viewer (not the page) shows one dialog.
    const codes = await frame
      .locator("body")
      .evaluate(() =>
        Promise.all([1, 2, 3].map(() => window.ergaLLM!.ask({ messages: [{ role: "user", content: "Hi" }] }).catch((e) => e.code)))
      );
    expect(codes).toEqual(["sign_in", "sign_in", "sign_in"]);
    const open = {
      hosts: 1,
      open: true,
      choices: [["Continue with GitHub", `/auth/github?next=${encodeURIComponent(`${doc.path}#part`)}`]],
    };
    await expect.poll(() => signInState(page)).toEqual(open);
    // Escape closes it; so do its close button and a click outside it.
    await page.keyboard.press("Escape");
    await expect.poll(() => signInOpen(page)).toBe(false);
    expect((await ask(page, "Hi")).code).toBe("sign_in");
    await expect.poll(() => signInState(page)).toEqual(open);
    await page.locator("erga-sign-in").getByRole("button", { name: "Close" }).click();
    await expect.poll(() => signInOpen(page)).toBe(false);
    // The page's own Sign in button: ergaLLM.signIn() shows the same dialog.
    await frame.locator("body").evaluate(() => {
      const b = document.body.appendChild(document.createElement("button"));
      b.id = "sign-in-test";
      b.textContent = "Sign in";
      b.onclick = () => window.ergaLLM!.signIn();
    });
    await clickInPage(page, frame.locator("#sign-in-test"));
    await expect.poll(() => signInOpen(page)).toBe(true);
    await page.mouse.click(5, page.viewportSize()!.height - 5);
    await expect.poll(() => signInOpen(page)).toBe(false);
    // Continue with GitHub: Erga's sign-in, which comes back to the same page and place. (The journey ends at the
    // request: the sign-in itself does not load.)
    await clickInPage(page, frame.locator("#sign-in-test"));
    await expect.poll(() => signInOpen(page)).toBe(true);
    await page.route("**/auth/github*", (route) => route.abort("aborted"));
    const signIn = page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).pathname == "/auth/github");
    await page.locator("erga-sign-in a.provider.github").click();
    expect(new URL((await signIn).url()).searchParams.get("next")).toBe(`${doc.path}#part`);
  });
});

journey("the homepage's model, for a visitor signed out", () => {
  let home: string;
  // The homepage is the whole server's: the files after this one get a fresh one.
  test.afterAll(async () => void (await setLanding(s)));

  test("it refuses a call from elsewhere, without its page's token, or over the visitor's hour", async () => {
    home = await homeWithEssay(s);
    const token = await tokenIn(s, "/essays/essay.html");
    expect(token).toBeTruthy();
    expect(await tokenIn(s, "/")).toBeTruthy();
    const ip = { "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 250)}` };
    // From the page: answered.
    expect(await call(s, { document: home, token }, ip)).toEqual({ status: 200, text: "Hi." });
    // From another site: Origin, or the browser's Sec-Fetch-Site.
    expect((await call(s, { document: home, token }, { ...ip, Origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await call(s, { document: home, token }, { ...ip, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    // No token, or one that is not this server's.
    expect(await call(s, { document: home }, ip)).toMatchObject({ status: 403, error: "Reload this page to use its model." });
    expect((await call(s, { document: home, token: token!.replace(/\.[\w-]+$/, ".AAAA") }, ip)).status).toBe(403);
    expect((await call(s, { document: home, token: "AAAA.AAAA" }, ip)).status).toBe(403);
    // Signed-in viewers only (share_document page_llm_who): sign_in, even from the page.
    await owner(s, "share_document", { document: home, page_llm_who: "signed_in" });
    expect(await call(s, { document: home, token }, ip)).toMatchObject({ status: 401, code: "sign_in" });
    await owner(s, "share_document", { document: home, page_llm_who: "all" });
    // Another document's model: signed out, only where it is shared with anyone and open to all viewers.
    const other = await publish(s, { "index.html": "<h1>Other</h1>" });
    await owner(s, "share_document", { document: other, page_llm: true });
    await owner(s, "share_document", { document: other, login: "*", role: "viewer" });
    expect(await call(s, { document: other, token }, ip)).toMatchObject({ status: 401, code: "sign_in" });
    // Open to all viewers: still not with the homepage's token, which is for its own document.
    await owner(s, "share_document", { document: other, page_llm_who: "all" });
    expect(await call(s, { document: other, token }, ip)).toMatchObject({ status: 403, error: "Reload this page to use its model." });
    // One answer that used the visitor's whole hour (PAGE_LLM_LIMITS.guest.tokens: 30,000); then "limit".
    const long = { document: home, token, messages: [{ role: "user", content: '@script [{"text": "Long.", "tokens": 30000}]' }] };
    expect(await call(s, long, ip)).toEqual({ status: 200, text: "Long." });
    expect(await call(s, { document: home, token }, ip)).toMatchObject({ status: 429, code: "limit" });
    // Another visitor (another IP address) still may.
    expect(await call(s, { document: home, token }, { "cf-connecting-ip": "198.51.100.7" })).toEqual({ status: 200, text: "Hi." });
  });

  test("every page of the homepage's project has ergaLLM, which answers where page_llm is on", async ({ tab }) => {
    const p = tab.page;
    await owner(s, "share_document", { document: home, page_llm: false });
    await signOut(p, s);
    await p.goto(`${s.root}/`); // page load 1: the homepage
    expect(await p.locator("h1").textContent()).toBe("Home with an essay");
    expect((await askIn(p, "Hi")).code).toBe("off");
    await p.goto(`${s.root}/essays/essay.html`); // page load 2: a page in a folder
    expect(await p.locator("h1").textContent()).toBe("The essay");
    // Before the page's own scripts.
    expect(await p.evaluate(() => (window as unknown as { early: boolean }).early)).toBe(true);
    expect(await p.evaluate(() => window.ergaLLM!.status())).toEqual({ on: false, model: null, signedIn: false });
    expect((await askIn(p, "Hi")).code).toBe("off");
    await owner(s, "share_document", { document: home, page_llm: true });
    expect(await askIn(p, '@script [{"text": "Hello from the essay."}]')).toEqual({ text: "Hello from the essay." });
    await p.goto(`${s.root}/`); // page load 3: the homepage again
    expect(await askIn(p, '@script [{"text": "Hello from home."}]')).toEqual({ text: "Hello from home." });
  });
});
