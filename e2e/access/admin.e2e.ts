// The admin pages: one journey of an admin (DEV_LOGIN, "tester"), on a server of this file's own, because it changes
// the list of users, the settings and the access rules of the whole server, and reads the whole server's counts.
// The path: the admin pages as one page. A link shows the next page in place, styled. Users, Settings, Access and the
// Changelog follow changes that an agent makes with an admin token, with no reload. Feedback sent from the account
// menu comes to the Feedback page, with its issue on the pretend GitHub; the page's switch turns Send feedback off and on. Ops
// shows the server's own deploys: Deploy on a commit asks the server's deployer, played here by the deployer's own code,
// and its job shows as it runs. Analytics shows the day's counts. Then the
// editor (the admin pages' bars look as its bars, and Send feedback works from a document), and the pages in dark mode.
import * as Effect from "effect/Effect";
import { readControl, startOf, takeAsk, writeLook } from "../../deploy/deployer/control";
import { openJob, writeSpec } from "../../deploy/deployer/instance";
import { deployerSql } from "../helpers/deployer";
import { openEditor } from "../helpers/editor";
import { agentClosed, expect, journey, servers, settle, test, until, type Page } from "../helpers/fixtures";
import { joinRoom } from "../helpers/room";
import { runTool } from "../helpers/tools";
import { editorUp, mint, newDoc, soon, unique } from "./access";
import { clickOn } from "../helpers/press";
import { markCard, markOf, marksSeen, markThere, watchMark } from "../helpers/save-mark";

// (The scripted model: the agent's pane is on the pages.)
// (It runs the release 222222222222: the Ops page's live commit.)
const own = await servers.of("admin", { env: { ERGA_AGENT_MODEL: "script", ERGA_VERSION: "2".repeat(12) } });

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
  /** Each of the last 7 days (UTC), as the server counted it. */
  const days = async () =>
    (await runTool(root, "analytics", { days: 7 })).result.days as { date: string; views: number; edits: number; activePeople: number }[];
  /**
   * The day of the first step, which has the views: by the server's clock, not the test's. It is the last day, but for
   * a run that goes past midnight (UTC): then it is the day before, and the last day has no views.
   */
  const theDay = async () => {
    const all = await days();
    return all.find((d) => d.views) ?? all.at(-1)!;
  };
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
    // The Changelog hears a change and asks for its row. The answer comes late: after the next page shows. It once
    // threw there (the Changelog's empty line is not on that page).
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
    // The sidebar: each page is one thing an admin governs, with every setting of it. No Settings page, no Users page.
    expect(await page.locator("#admin-side a .label").allInnerTexts()).toEqual([
      "Analytics",
      "Sign-in",
      "Access",
      "Documents",
      "Agents and models",
      "Feedback",
      "Ops",
      "Changelog",
    ]);
    // A mark on this window, for the steps after: still here after the links, so the pages came in place.
    await page.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });
    await agent("set_setting", { key: "feedback_repository", value: "erga/pretend" });
    await soon(() => asked).toBe(1);
    await go("/admin/agents", "li.provider .about");
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
    await go("/admin/access", "ol.users > li");
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

  test("Feedback, Documents, Agents and models and Access follow an agent's changes: a setting's value, No limit, a rule added and removed, Anyone's level, the public switch", async () => {
    // Feedback's repository is a setting on the Feedback page, with the value that the first step set.
    await go("/admin/feedback", "[data-key=feedback_repository]");
    const repository = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>("[data-key=feedback_repository]");
      return row ? { text: row.innerText, value: row.querySelector<HTMLInputElement>("#set-feedback_repository")?.value } : null;
    });
    expect(repository?.text).toContain("Feedback's repository");
    expect(repository?.value).toBe("erga/pretend");
    await go("/admin/documents", 'li[data-live="setting:delete_docs_after_hours"]');
    const hours = () =>
      page.evaluate(
        () => document.querySelector<HTMLInputElement>('li[data-live="setting:delete_docs_after_hours"] input[name=value]')!.value
      );
    expect(await hours()).not.toBe("7");
    await agent("set_setting", { key: "delete_docs_after_hours", value: 7 });
    await soon(hours).toBe("7");
    // Agents: the daily token limit. The admin picks "No limit" and saves, and the server has no limit; the agent's
    // reset brings the default back to the page.
    const tokens = 'li[data-live="setting:agent_daily_tokens"]';
    await go("/admin/agents", tokens);
    const limit = async () =>
      (await agent<{ settings: { key: string; value: unknown }[] }>("settings")).settings.find((e) => e.key == "agent_daily_tokens")!.value;
    // (No Save button: the choice saves as it changes.)
    await page.selectOption(`${tokens} select.mode`, { label: "No limit" });
    await soon(limit).toBe(null);
    await agent("set_setting", { key: "agent_daily_tokens", reset: true });
    await soon(() => page.evaluate((s) => document.querySelector<HTMLSelectElement>(`${s} select.mode`)!.value, tokens)).toBe("after");

    // Access: a rule the agent adds comes in at its place; Anyone's level and sharing publicly, set by the agent, show so.
    await go("/admin/access", "ol.users > li");
    const org = unique("org");
    const rules = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("ol.rules > li .title")].map((t) => t.innerText));
    /** Everyone else, as the page shows it: Anyone's level, and the switch. */
    const everyone = () =>
      page.evaluate(() => {
        const box = document.getElementById("public-sharing") as HTMLInputElement;
        return `${(document.getElementById("anyone-access") as HTMLSelectElement).value} ${box.checked ? "on" : "off"}${box.disabled ? " disabled" : ""}`;
      });
    await agent("set_access", { action: "add", kind: "github_org", value: org, access: "read" });
    await soon(rules).toContain(org);
    // Local development starts with both on. Anyone at No access: the switch is off with it, and can't turn on.
    expect(await everyone()).toBe("public on");
    await agent("set_access", { action: "anyone", level: "none" });
    await soon(everyone).toBe("none off disabled");
    await agent("set_access", { action: "anyone", level: "public" });
    await soon(everyone).toBe("public off");
    await agent("set_access", { action: "public", on: true });
    await soon(everyone).toBe("public on");
    const id = (await agent<{ rules: { id: number; value: string }[] }>("people")).rules.find((r) => r.value == org)!.id;
    await agent("set_access", { action: "remove", id });
    await soon(rules).not.toContain(org);
    expect(await stayed()).toBe(true);
  });

  test("a setting saves by itself, with no Save button: the mark is the circle, then the check; a refused value stays in its field, with the red x and Try again", async () => {
    const row = 'li[data-live="setting:max_file_mb"]',
      field = `${row} input[name=value]`;
    await go("/admin/documents", row);
    const onServer = async () =>
      (await agent<{ settings: { key: string; value: unknown }[] }>("settings")).settings.find((e) => e.key == "max_file_mb")!.value;
    expect(await page.locator('main button:text-is("Save")').count()).toBe(0);
    // Before a change there is no mark.
    expect(await markOf(page)).toBe("saved");
    expect(await markThere(page)).toBe(false);
    await watchMark(page);
    // Typed with real keys: the circle at the first key; saved when the typing pauses, with the focus still in the field.
    await page.click(field);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("6");
    expect(await markOf(page)).toBe("saving");
    await soon(onServer).toBe(6);
    await soon(() => markOf(page)).toBe("saved");
    expect(await marksSeen(page)).toEqual(["saving", "saved"]);
    expect(await page.evaluate((f) => document.activeElement == document.querySelector(f), field)).toBe(true);
    // The server refuses the next save. The focus leaves the field: the red x, the reason under the field, and the
    // person's value still in it; the server keeps the old one.
    await page.route(
      "**/api/tools/set_setting*",
      // (An answer that refuses, with no failed request: the browser logs none.)
      (route) => route.fulfill({ json: { ok: false, error: "The server is busy: try again." } }),
      { times: 1 }
    );
    await page.keyboard.type("4");
    await page.keyboard.press("Tab");
    await soon(() => markOf(page)).toBe("error");
    // The mark is left of the buttons' bar: it touches the bar's left side.
    expect(
      await page.evaluate(() => {
        const m = document.querySelector("#save-state .save-mark")!.getBoundingClientRect(),
          bar = document.querySelector(".erga-view-buttons")!.getBoundingClientRect();
        return m.width > 0 && Math.abs(bar.left - m.right) <= 1;
      })
    ).toBe(true);
    expect(await page.inputValue(field)).toBe("64");
    expect(await page.innerText(`${row} .hint`)).toBe("The server is busy: try again.");
    expect(await onServer()).toBe(6);
    // A click on the red x: its card says what failed, in place. Try again saves the value.
    expect(await markCard(page)).toBeNull();
    await page.click("#save-state .save-mark");
    await soon(() => markCard(page)).toBe(
      "Largest file not saved\n\nThe server is busy: try again. The field keeps your value.\n\nTry again"
    );
    await page.click("#save-card .save-retry");
    await soon(onServer).toBe(64);
    await soon(() => markOf(page)).toBe("saved");
    expect(await page.innerText(`${row} .hint`)).toBe("");
    await agent("set_setting", { key: "max_file_mb", reset: true });
    await soon(() => page.inputValue(field)).not.toBe("64");
  });

  test("the Changelog shows each change at the top as it is made", async () => {
    await go("/admin/changes", "ol.changes > li");
    const top = () => page.evaluate(() => document.querySelector<HTMLElement>("ol.changes > li")!.innerText);
    const other = unique("u");
    await agent("set_user", { action: "add", provider: "github", handle: other, role: "read" });
    await soon(top).toContain(other);
    // A group rule's change says which group and its access (it showed as a setting before: "access never → never").
    const group = unique("org");
    await agent("set_access", { action: "add", kind: "github_org", value: group, access: "read" });
    await soon(top).toContain(`${group} added: Can view documents`);
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

  test("the Feedback page's switch: off, a signed-in person has no Send feedback and the server takes no message; on again, it is back", async () => {
    // (The Feedback page is open, from the step before.) A click on the switch saves it, with no Save button.
    const flip = async () => {
      const saved = page.waitForResponse((r) => r.url().includes("/api/tools/set_setting"));
      await clickOn(page, "li[data-key=feedback] .switch .track");
      await saved;
    };
    expect(await page.isChecked("#set-feedback")).toBe(true);
    await flip();
    // The page of someone signed in who is no admin, as the server gives it: their account menu has no Send feedback.
    const list = async () => (await fetch(`${root}/documents?user=reader01`)).text();
    const off = await list();
    expect(off).toContain('<a href="#settings">Settings</a>');
    expect(off).not.toContain("#feedback");
    const refused = await runTool(root, "send_feedback", { text: "Not now" }, { user: "reader01" });
    expect([refused.status, refused.error]).toEqual([403, "Feedback is off on this server."]);
    // The admin's page: the switch is off, and the message kept before stays.
    expect(await page.isChecked("#set-feedback")).toBe(false);
    expect(await page.locator(".feedback li").count()).toBe(1);
    // On again: the link is back in that person's page (the editor's menu sends feedback, two steps on).
    await flip();
    expect(await list()).toContain('<a href="#feedback">Send feedback</a>');
    expect(await stayed()).toBe(true);
  });

  test("Ops: Deploy on a commit asks the server's deployer; its job shows as it runs and when it ends, with its log; the switch turns auto-deploy on", async () => {
    const sql = deployerSql(own!);
    const run = Effect.runPromise;
    const sha = (n: number) => String(n).repeat(40);
    // The instance's spec, and its deployer's look at GitHub: the head has a release, and the server runs the commit before it.
    await run(
      writeSpec(sql, {
        repo: "github.com/example/erga",
        branch: "main",
        target: {
          kind: "cloudflare",
          account: "0123456789abcdef0123456789abcdef",
          worker: "erga",
          database: "erga",
          app: { kind: "domain", zoneName: "example.com", hostname: "example.com" },
          pages: { kind: "zone", zoneName: "example-pages.com" },
        },
        settings: {},
        secrets: [],
      })
    );
    const at = Date.now();
    const commits = [3, 2, 1].map((n) => ({
      sha: sha(n),
      title: `Change ${n}`,
      at: at - (4 - n) * 3_600_000,
      release: "released" as const,
    }));
    await run(writeLook(sql, { head: sha(3), error: null, commits }));
    await go("/admin/ops", `.ops-view .row[data-sha="${sha(3)}"]`);
    const text = (selector: string) => page.evaluate((s) => document.querySelector<HTMLElement>(s)?.innerText ?? "", selector);
    expect(await text(`.row[data-sha="${sha(2)}"] .dep.live`)).toContain("live");
    // The head's Deploy asks first; its answer goes to the deployer, which has no address: the page says that it waits.
    await clickOn(page, `.row[data-sha="${sha(3)}"] [data-deploy]`);
    await soon(() => text(".confirm:popover-open")).toContain("Deploy 3333333 Change 3 to");
    await clickOn(page, ".confirm [data-go]");
    await soon(() => text(".job.running")).toContain("asked by tester");
    // The deployer's look: it takes the lock with the ask's job, takes the ask, and deploys. The page follows by itself.
    const ask = (await run(readControl(sql)))!.ask!;
    expect(ask).toMatchObject({ kind: "deploy", sha: sha(3), by: "tester" });
    const job = await run(openJob(sql, startOf(ask)));
    expect(await run(takeAsk(sql, ask))).toBe(true);
    job.commit(sha(3));
    job.line("Worker: done");
    expect(await job.end({ at: "done" })).toBeNull();
    await soon(() => text("a.job.ok"), 5000).toContain("from the app, by tester");
    await clickOn(page, "a.job.ok");
    await soon(() => text(".logs")).toContain("Worker: done");
    // The switch saves by itself, and the deployer reads it at its next look.
    await clickOn(page, 'a.tab[href="/admin/ops"]');
    await page.waitForSelector("#auto-deploy");
    await clickOn(page, "li:has(#auto-deploy) .switch .track");
    await soon(async () => (await run(readControl(sql)))?.auto).toBe(true);
    expect(await stayed()).toBe(true);
  });

  // (Cut list, brought back.) The counts are those of the first step: nothing after it opened or edited a document.
  test("Analytics: the day's people, views and edits, the lists ten at a time with Load more, 7 days in place; nobody else sees the page", async () => {
    // The counts land after each answer, and the edit when its version is cut: the admin is the 13th active person.
    await soon(theDay, 10_000).toMatchObject({ views: VIEWS, edits: 1, activePeople: 13 });
    const { date } = await theDay();
    await go("/admin", "[data-chart]");
    expect(await page.locator(".admin-side a[aria-current=page]").innerText()).toBe("Analytics");
    const big = (chart: string) => page.locator(`[data-chart="${chart}"] [data-big]`).innerText();
    // The people of the page's last day (that day's 13; past midnight, the new day's); the views and edits of all its days.
    const last = await page.locator("#chart-people-svg > g[data-date]").last().getAttribute("data-date");
    const people = (await days()).find((d) => d.date == last)!.activePeople;
    expect([await big("people"), await big("views"), await big("edits")]).toEqual([String(people), String(VIEWS), "1"]);
    expect(await page.locator("#chart-views-svg > g").count()).toBe(30);
    expect(await page.locator(`#chart-views-svg > g[data-date="${date}"] title`).textContent()).toMatch(new RegExp(`: ${VIEWS} views$`));
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
    const editor = await looks(page, { left: "#nav-documents", right: ".chrome-top" });
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
