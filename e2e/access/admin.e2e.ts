// The admin pages: one journey of an admin (DEV_LOGIN, "tester"), on a server of this file's own, because it changes
// the list of users, the settings and the access rules of the whole server, and reads the whole server's counts.
// The path: the admin pages as one page. A link shows the next page in place, styled. Users, Settings, Access and the
// Change log follow changes that an agent makes with an admin token, with no reload. Feedback sent from the account
// menu comes to the Feedback page, with its issue on the pretend GitHub. Analytics shows the day's counts. Then the
// editor (the admin pages' bars look as its bars, and Send feedback works from a document), and the pages in dark mode.
import { openEditor } from "../helpers/editor";
import { expect, journey, servers, settle, test, until, type Page } from "../helpers/fixtures";
import { runTool } from "../helpers/tools";
import { agentClosed, clickOn, editorUp, joinRoom, mint, newDoc, soon, unique } from "./access";

// (The scripted model: the agent's pane is on the pages.)
const own = await servers.of("admin", { env: { ERGA_AGENT_MODEL: "script" } });

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
}

/** Each bar's and the agent's glass, and their boxes, by the selectors in the page (the editor's, or an app page's). */
const looks = (page: Page, sel: { left: string; right: string }) =>
  page.evaluate((sel) => {
    const look = (s: string) => {
      const el = document.querySelector(s)!,
        c = getComputedStyle(el),
        r = el.getBoundingClientRect();
      return {
        background: c.backgroundImage + " " + c.backgroundColor,
        shadow: c.boxShadow,
        border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
        radius: c.borderTopLeftRadius,
        blur: c.backdropFilter,
        box: [r.top, r.height].map((v) => Math.round(v * 2) / 2),
      };
    };
    const fab = document.querySelector(".agent-fab")!.getBoundingClientRect();
    return { left: look(sel.left), right: look(sel.right), agent: look(".agent-glass"), fab: [fab.left, fab.width, fab.height] };
  }, sel);
const APP = { left: ".erga-crumbs", right: ".erga-view-buttons" };

journey("an admin on the admin pages", () => {
  let page: Page;
  const root = own?.root;
  /** The admin pages' bars and agent, in light mode. */
  let admin: Awaited<ReturnType<typeof looks>>;
  /** An agent with an admin token: a change made elsewhere. */
  let token: string;
  const agent = async <T = any>(name: string, args: Record<string, unknown> = {}) => {
    const r = await runTool<T>(root, name, args, { token });
    expect(r.status, `${name}: ${r.error}`).toBe(200);
    return r.result!;
  };
  const READERS = Array.from({ length: 12 }, (_, i) => `reader${String(i + 1).padStart(2, "0")}`);
  /** How many more times each of the last three readers opens the document: they are the most active, in this order. */
  const AGAIN = { reader12: 3, reader11: 2, reader10: 1 };
  const VIEWS = 12 + 3 + 2 + 1;
  /** Today's numbers, as the server counted them. */
  const today = async () =>
    (await runTool(root, "analytics", { days: 7 })).result.days.at(-1) as { views: number; edits: number; activePeople: number };
  /** The issues the pretend GitHub opened in the server's pretend repository. */
  const issues = async (): Promise<Issue[]> => (await fetch(`${root}/__github/api/repos/erga/pretend/issues`)).json();
  /** A link of the sidebar shows another admin page in place: its path, and what the page has. */
  const go = async (path: string, shows: string) => {
    await page.click(`.admin-side a[href="${path}"]`);
    await page.waitForSelector(shows);
  };
  /** The mark on this window is still here: the pages came in place, not with a load. */
  const stayed = () => page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed === true);
  /** A design token's colour on the page. */
  const tokenColour = (name: string) =>
    page.evaluate((name) => {
      const el = document.body.appendChild(document.createElement("i"));
      el.style.color = `var(${name})`;
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    }, name);
  /** Types the lines in the open feedback dialog with real keys, sends them, and closes the thanks. */
  const sendFeedback = async (lines: string[]) => {
    await page.waitForSelector("#erga-feedback[open] textarea");
    // The text box has the keys at once.
    expect(await page.evaluate(() => document.activeElement?.matches("#erga-feedback textarea"))).toBe(true);
    for (const [i, line] of lines.entries()) {
      if (i) await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(line);
    }
    await clickOn(page, "#erga-feedback .send");
    await soon(() => page.evaluate(() => document.querySelector<HTMLElement>("#erga-feedback .thanks")!.innerText)).toContain(
      "Thanks, sent."
    );
    await clickOn(page, "#erga-feedback .done");
    await soon(() => page.evaluate(() => document.querySelector<HTMLDialogElement>("#erga-feedback")!.open)).toBe(false);
  };

  // A page shown in place once kept the first page's style: API keys showed its rows without their look.
  test("a link from one admin page to another shows the new page styled, in place", async ({ tab }) => {
    page = tab.page;
    tab.strict = true;
    token = await mint(root, null, { label: "Admin's agent", scope: "admin" });
    // For the Analytics step, later: twelve people read a shared document, and the admin edits it in its room (one
    // edit, counted when its version is cut: the last person who may edit leaves). Each reader opens it one time,
    // the oldest account first; then the last three open it again (AGAIN).
    const doc = await newDoc(root);
    expect((await runTool(root, "share_document", { document: doc.id, login: "*", role: "viewer" })).ok).toBe(true);
    const writer = await joinRoom(`${root}/d/${doc.id}`, "tester");
    writer.insertAfter("<p>", "Ship it. ");
    await until(
      async () => (await (await fetch(`${root}/d/${doc.id}/doc/index.html`)).text()).includes("Ship it."),
      5000,
      "the edit in the room"
    );
    writer.leave();
    const opens = async (login: string) => expect((await fetch(`${root}${doc.address}?user=${login}`)).status).toBe(200);
    for (const login of READERS) await opens(login);
    await Promise.all(Object.entries(AGAIN).flatMap(([login, n]) => Array.from({ length: n }, () => opens(login))));

    await page.setViewportSize({ width: 1200, height: 760 });
    await agentClosed(page);
    // The Change log hears a change and asks for its row. The answer comes late: after the next page shows. It once
    // threw there (the Change log's empty line is not on that page).
    let asked = 0,
      release!: () => void;
    const late = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/api/news/rows*", async (route) => {
      asked++;
      await late;
      await route.continue();
    });
    await page.goto(`${root}/admin/changes`);
    await settle(page);
    admin = await looks(page, APP);
    // A mark on this window, for the steps after: still here after the links, so the pages came in place.
    await page.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });
    await agent("set_setting", { key: "feedback_repository", value: "erga/pretend" });
    await soon(() => asked).toBe(1);
    await go("/admin/api-keys", "li.provider .about");
    const answered = page.waitForResponse("**/api/news/rows*");
    release();
    await answered;
    await page.unroute("**/api/news/rows*");
    expect(
      await page.evaluate(() => {
        const name = getComputedStyle(document.querySelector("li.provider .key")!),
          row = getComputedStyle(document.querySelector("ol.rows > li.provider")!);
        return { weight: name.fontWeight, row: row.display, columns: row.gridTemplateColumns.split(" ").length };
      })
    ).toEqual({ weight: "600", row: "grid", columns: 2 });
    await go("/admin/auth", ".switch .track");
    // A switch is the editor's blue when on and its grey when off (the app's tokens --caret and --rule).
    const colours = await page.evaluate(() => {
      // One switch, on and then off (in the page only: no change event, so nothing is sent), without its transition.
      const input = document.querySelector<HTMLInputElement>(".switch input:checked")!,
        track = input.nextElementSibling as HTMLElement;
      track.style.transition = "none";
      const on = getComputedStyle(track).backgroundColor;
      input.checked = false;
      const off = getComputedStyle(track).backgroundColor;
      input.checked = true;
      track.style.transition = "";
      return { width: getComputedStyle(track).width, on, off };
    });
    expect(colours).toEqual({ width: "34px", on: await tokenColour("--caret"), off: await tokenColour("--rule") });
    await go("/admin/users", "ol.users > li");
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("ol.users > li")!).display)).toBe("grid");
    // The bars and the agent stay as they were, on the page that came in place.
    expect(await looks(page, APP)).toEqual(admin);
    expect(await stayed()).toBe(true);
  });

  test("Users follows an agent's changes as they are made: a person added, their role, the person removed", async () => {
    // The same list all along: a reload, even in place, would make the list again without this mark.
    await page.evaluate(() => {
      document.querySelector<HTMLElement>("ol.users")!.dataset.mark = "same";
    });
    const login = unique("u");
    /** Their row as shown (someone added who hasn't signed in yet): its live key and role, or "" when there's none. */
    const row = () =>
      page.evaluate((login) => {
        const li = [...document.querySelectorAll<HTMLElement>("ol.users > li")].find(
          (li) => li.querySelector<HTMLElement>(".title")!.innerText == login
        );
        return li ? `${li.dataset.live} ${li.querySelector<HTMLSelectElement>("select.role")!.value}` : "";
      }, login);
    const added = await agent<{ person: { person: number } }>("set_user", {
      action: "add",
      provider: "github",
      handle: login,
      role: "read",
    });
    const person = added.person.person;
    await soon(row).toBe(`person:${person} read`);
    await agent("set_user", { action: "role", person, role: "write" });
    await soon(row).toBe(`person:${person} write`);
    await agent("set_user", { action: "remove", person });
    await soon(row).toBe("");
    expect(await page.evaluate(() => document.querySelector<HTMLElement>("ol.users")!.dataset.mark)).toBe("same");
  });

  test("Settings and Access follow an agent's changes: a setting's value, a rule added and removed, the public switch", async () => {
    await go("/admin/settings", 'li[data-live="setting:delete_docs_after_hours"]');
    // Feedback's repository is a setting on this page, with the value that the first step set.
    const repository = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>("[data-key=feedback_repository]");
      return row ? { text: row.innerText, value: row.querySelector<HTMLInputElement>("#set-feedback_repository")?.value } : null;
    });
    expect(repository?.text).toContain("Feedback's repository");
    expect(repository?.value).toBe("erga/pretend");
    const hours = () =>
      page.evaluate(
        () => document.querySelector<HTMLInputElement>('li[data-live="setting:delete_docs_after_hours"] input[name=value]')!.value
      );
    expect(await hours()).not.toBe("7");
    await agent("set_setting", { key: "delete_docs_after_hours", value: 7 });
    await soon(hours).toBe("7");

    // Access: a rule the agent adds comes in at its place; sharing publicly, switched by the agent, shows switched.
    await go("/admin/access", "ol.rules > li");
    const org = unique("org");
    const rules = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("ol.rules > li .title")].map((t) => t.innerText));
    const isPublic = () => page.evaluate(() => (document.getElementById("public-sharing") as HTMLInputElement).checked);
    await agent("set_access", { action: "add", kind: "github_org", value: org, access: "read" });
    await soon(rules).toContain(org);
    const on = await isPublic();
    await agent("set_access", { action: "public", on: !on });
    await soon(isPublic).toBe(!on);
    await agent("set_access", { action: "public", on });
    await soon(isPublic).toBe(on);
    const id = (await agent<{ rules: { id: number; value: string }[] }>("people")).rules.find((r) => r.value == org)!.id;
    await agent("set_access", { action: "remove", id });
    await soon(rules).not.toContain(org);
    expect(await stayed()).toBe(true);
  });

  test("the Change log shows each change at the top as it is made", async () => {
    await go("/admin/changes", "ol.changes > li");
    const top = () => page.evaluate(() => document.querySelector<HTMLElement>("ol.changes > li")!.innerText);
    const other = unique("u");
    await agent("set_user", { action: "add", provider: "github", handle: other, role: "read" });
    await soon(top).toContain(other);
    // A group rule's change says which group and its access (it showed as a setting before: "access never → never").
    const group = unique("org");
    await agent("set_access", { action: "add", kind: "github_org", value: group, access: "read" });
    await soon(top).toContain(`${group} added: Can authenticate`);
  });

  test("Send feedback in the account menu: type, Send, thanks; the issue on GitHub has no name; the Feedback page lists it with its issue", async () => {
    await clickOn(page, "[data-erga-account] button");
    await clickOn(page, "#erga-account-menu a[href='#feedback']");
    await page.waitForSelector("#erga-feedback[open]");
    // The menu closes behind it.
    expect(await page.evaluate(() => document.getElementById("erga-account-menu")!.hidden)).toBe(true);
    expect(await page.textContent("#erga-feedback")).toContain("Your text goes to Erga's issue list on GitHub, without your name.");
    const first = `The documents list should sort by name, and keep the order I chose ${Date.now()}`,
      text = `${first}\nAnd remember it.`;
    await sendFeedback(text.split("\n"));
    // The issue: the first line as its title, the text and the feedback's id as its body, the label; no name, no page.
    const issue = await until(
      async () => (await issues()).find((i) => i.body.startsWith(text)),
      10_000,
      "the pretend GitHub has the issue"
    );
    expect(issue!.title).toBe(first.slice(0, 59).trimEnd() + "…");
    expect(issue!.body).toMatch(new RegExp(`^${text}\\n\\n---\\nFeedback fb-[a-z0-9]{8}$`));
    expect(issue!.labels).toEqual([{ name: "feedback" }]);
    expect(JSON.stringify(issue)).not.toMatch(/tester|\/admin/);

    // The admins' Feedback page: the text, the page it came from, the issue's link.
    await go("/admin/feedback", `.feedback li:has-text("${first}")`);
    const row = await page.evaluate((first) => {
      const li = [...document.querySelectorAll<HTMLElement>(".feedback li")].find((l) => l.innerText.includes(first))!;
      return {
        text: li.querySelector<HTMLElement>(".text")!.innerText,
        page: li.querySelector(".page")?.textContent,
        issue: li.querySelector<HTMLAnchorElement>("a.issue")?.textContent,
        href: li.querySelector<HTMLAnchorElement>("a.issue")?.getAttribute("href"),
      };
    }, first);
    expect(row).toEqual({
      text,
      page: "/admin/changes",
      issue: `#${issue!.number}`,
      href: expect.stringMatching(new RegExp(`/__github/erga/pretend/issues/${issue!.number}$`)),
    });
    expect(await stayed()).toBe(true);
  });

  // (Cut list, brought back.) The counts are those of the first step: nothing after it opened or edited a document.
  test("Analytics: the day's people, views and edits, the lists ten at a time with Load more, 7 days in place; nobody else sees the page", async () => {
    // The counts land after each answer, and the edit when its version is cut: the admin is the 13th active person.
    await soon(today, 10_000).toMatchObject({ views: VIEWS, edits: 1, activePeople: 13 });
    await go("/admin", "[data-chart]");
    expect(await page.locator(".admin-side a[aria-current=page]").innerText()).toBe("Analytics");
    const big = (chart: string) => page.locator(`[data-chart="${chart}"] [data-big]`).innerText();
    expect([await big("people"), await big("views"), await big("edits")]).toEqual(["13", String(VIEWS), "1"]);
    expect(await page.locator("#chart-views-svg > g").count()).toBe(30);
    expect(await page.locator("#chart-views-svg > g[data-date] title").last().textContent()).toMatch(new RegExp(`: ${VIEWS} views$`));
    // The most active: reader12 first, with 4 views; then by name. Ten, then the other three with Load more.
    const logins = (list: string) =>
      page.locator(`ol.people-rows[data-list="${list}"] > li`).evaluateAll((lis) => lis.map((li) => (li as HTMLElement).dataset.login));
    const more = (list: string) => page.locator(`button.more[data-list="${list}"]`);
    const active = await logins("active");
    expect(active.slice(0, 3)).toEqual(["reader12", "reader11", "reader10"]);
    expect(active.length).toBe(10);
    expect(await page.locator('ol.people-rows[data-list="active"] > li[data-login="reader12"] [data-n="views"]').innerText()).toBe(
      "4 views"
    );
    await more("active").click();
    await soon(async () => (await logins("active")).length).toBe(13);
    const all = await logins("active");
    expect(all.slice(0, 10)).toEqual(active);
    expect(all.slice(10)).toEqual(["reader08", "reader09", "tester"]);
    expect(await more("active").isHidden()).toBe(true);
    // The newest: the readers, the last first; Load more brings the first two and the admin.
    const newest = await logins("newest");
    expect(newest).toEqual(READERS.slice(2).reverse());
    await more("newest").click();
    await soon(() => logins("newest")).toEqual([...newest, "reader02", "reader01", "tester"]);
    expect(await more("newest").isHidden()).toBe(true);
    // 7 days: seven bars, in place.
    await page.locator('nav.range a:text("7 days")').click();
    await soon(() => page.locator("#chart-views-svg > g").count()).toBe(7);
    expect(new URL(page.url()).search).toBe("?days=7");
    expect(await page.locator('nav.range a[aria-current="page"]').innerText()).toBe("7 days");
    expect(await stayed()).toBe(true);
    // A reader is no admin: no page, and no numbers for their agent.
    expect((await fetch(`${root}/admin?user=reader01`)).status).toBe(404);
    expect((await runTool(root, "analytics", {}, { user: "reader01" })).ok).toBe(false);
  });

  // The admin pages' bars once had the glass for a coloured page: untinted, with the full shadow.
  test("the admin pages' bars and agent have the editor's look on a white document; the editor's avatar menu sends feedback too", async ({
    tab,
  }) => {
    await openEditor(tab, own, "top/white");
    await editorUp(page);
    const editor = await looks(page, { left: "#nav-docs", right: ".chrome-top" });
    // A white document's glass: tinted.
    expect(editor.left.background).toContain("0.035");
    expect(admin).toEqual(editor);
    await clickOn(page, "#me .avatar");
    await clickOn(page, "#account-feedback");
    const text = `From the editor ${Date.now()}`;
    await sendFeedback([text]);
    const issue = await until(async () => (await issues()).find((i) => i.title == text), 10_000, "the pretend GitHub has the issue");
    expect(issue!.body).toContain(text);
  });

  test("in dark mode: dark glass on the bars, the switch's circle in the page's colour, and a link in the editor's link colour", async () => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${root}/admin/auth`);
    await page.waitForSelector(".switch .track");
    await settle(page);
    const dark = await looks(page, APP);
    expect(dark.left.background).not.toContain("0.035");
    expect(dark.left.border).toContain("rgba(255, 255, 255, 0.12)");
    const bg = await tokenColour("--bg");
    expect(bg).toBe("rgb(24, 24, 27)");
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".switch .track")!, "::after").backgroundColor)).toBe(bg);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>("main.admin-main .steps a")!).color)).toBe(
      await tokenColour("--link")
    );
  });
});
