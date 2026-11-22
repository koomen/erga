// Sign in: who may sign in, the first sign-in, the account corner, and sign out and in.
//
// Two journeys. The first is on a server of this file's own, because its checks change who may use the whole server:
// the sign-in page with one provider and with two, people that an admin adds before their first sign-in, and the
// access rules (a Google Workspace, a GitHub organization, Anyone's level), how a new account gets its username, and a
// new server's setup page. The
// second is one new person on the shared server: the username step, the account corner, the editor's Share card and pencil, sign out and sign in.
// Sign-ins go through local development's pretend provider (/auth/dev), which takes the same steps as GitHub's and
// Google's answers. The admin is DEV_LOGIN ("tester").
import { agentClosed, expect, journey, servers, test, until, type Page } from "../helpers/fixtures";
import { runTool } from "../helpers/tools";
import {
  corner,
  editorUp,
  getter,
  inFrames,
  inPage,
  newDoc,
  plain,
  servePictures,
  signedOutCookie,
  soon,
  unique,
  where,
} from "./access";
import { clickOn } from "../helpers/press";
import { markOf } from "../helpers/save-mark";

const [s, own] = await Promise.all([servers.main(), servers.of("sign-in")]);

journey("who may sign in, on a server of its own", () => {
  let page: Page, root: string;
  const id = unique("");
  const path = () => new URL(page.url()).pathname;
  /** A sign-in through the pretend provider, which comes back to /documents. */
  const signIn = (q: string) => page.goto(`${root}/auth/dev?${q}&next=/documents`);
  /** The username step: the person chooses `name`, and the account is made. */
  const join = async (name: string) => {
    expect(path()).toBe("/auth/username");
    await page.fill("#username", name);
    await page.click("form.username button");
    await until(() => path() == "/documents", 10_000, `${name}'s account made`);
  };
  /** What /new answers to the person signed in on the page: where it goes, or its status. */
  const makes = async () => {
    const r = await page.request.get(`${root}/new`, { maxRedirects: 0 });
    return r.status() == 302 ? new URL(r.headers().location, root).pathname : String(r.status());
  };

  test("one provider on: the sign-in page goes straight to it; two on: a button for each, readable in light and dark", async ({ tab }) => {
    page = tab.page;
    root = own.root;
    const one = await getter(root)("/auth/sign-in?next=%2Fdocuments");
    expect(one.status).toBe(302);
    expect(one.headers.get("location")).toBe("/auth/github?next=%2Fdocuments");

    expect((await runTool(root, "set_sign_in", { provider: "google", action: "on" })).status).toBe(200);
    await page.goto(`${root}/auth/sign-in?next=%2Fdocuments`);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const buttons = await page.$$eval("a.provider", (as) =>
        as.map((a) => {
          const c = getComputedStyle(a);
          return {
            text: a.textContent!.trim(),
            href: a.getAttribute("href"),
            color: c.color,
            background: c.backgroundColor,
            logo: a.querySelector("svg")?.getBoundingClientRect().width ?? 0,
          };
        })
      );
      expect(buttons.map((b) => [b.text, b.href])).toEqual([
        ["Continue with GitHub", "/auth/github?next=%2Fdocuments"],
        ["Continue with Google", "/auth/google?next=%2Fdocuments"],
      ]);
      for (const b of buttons) {
        expect(b.logo, `${scheme}, ${b.text}: its logo shows`).toBeGreaterThan(0);
        expect(b.color, `${scheme}, ${b.text}: its text shows on its background`).not.toBe(b.background);
      }
    }
    expect(await page.textContent("main h1")).toBe("Sign in to Erga");
    expect(await page.textContent("main")).not.toContain("same account");
    // After Cancel on a provider's page (the callback sends her back here): the page says so, above the same buttons.
    await page.goto(`${root}/auth/sign-in?next=%2Fdocuments&canceled`);
    expect((await page.innerText("main")).split("\n").filter(Boolean)).toEqual([
      "Sign in to Erga",
      "You canceled the sign-in attempt. Try again or choose another way.",
      "Continue with GitHub",
      "Continue with Google",
    ]);
  });

  test("signed out, a private document and an address with no document give the same page; the GitHub button signs in", async () => {
    // A stranger learns nothing from the page: the heading, the address asked for, the buttons back to it.
    const made = (await newDoc(root)).address;
    await page.context().addCookies([{ name: signedOutCookie(own), value: "1", url: root }]);
    const shown = [];
    for (const address of [made, "/nobody/nothing-here"]) {
      await page.goto(`${root}${address}`);
      expect(path()).toBe("/auth/sign-in");
      expect((await page.innerText("main")).split("\n").filter(Boolean)).toEqual([
        "Sign in to open this document",
        `${new URL(root).host}${address}`,
        "Continue with GitHub",
        "Continue with Google",
      ]);
      shown.push((await page.innerHTML("main")).replaceAll(address, "ADDRESS").replaceAll(encodeURIComponent(address), "ADDRESS"));
    }
    expect(shown[1]).toBe(shown[0]);
    // The GitHub button signs in (local development's sign-in) and comes back to the address asked for.
    await page.click("a.provider.github");
    await page.waitForURL(`${root}/nobody/nothing-here`);
    expect((await corner(page)).state).toBe("in");
    expect((await runTool(root, "set_sign_in", { provider: "google", action: "off" })).status).toBe(200);
  });

  test("an admin adds a person by provider account before their first sign-in, with one role, and changes it", async () => {
    const hint = () => page.textContent("#users-hint");
    const add = async (provider: string, handle: string, role: string) => {
      await page.selectOption("form.add-user select[name=provider]", provider);
      await page.fill("form.add-user input[name=handle]", handle);
      await page.selectOption("form.add-user select[name=role]", role);
      await page.click("form.add-user button");
    };
    const ann = `ol.users > li[data-login="ann${id}"] select.role`;
    const annSignsIn = () => signIn(`provider=google&subject=a${id}&handle=ann.${id}@example.net&email=ann.${id}@example.net`);
    await page.goto(`${root}/admin/access?user=tester`);
    // A Google account by its email, with Can view documents: it waits on the Access page.
    await add("google", `ann.${id}@example.net`, "read");
    const waiting = `ol.users > li.waiting:has(.handle:text-is("ann.${id}@example.net"))`;
    await page.locator(waiting).waitFor();
    expect(await page.inputValue(`${waiting} select.role`)).toBe("read");
    // A GitHub login GitHub doesn't know: refused, in place.
    await add("github", `no-such-${id}`, "read");
    await until(async () => (await hint())?.includes("GitHub has no account"), 5000, "an unknown login refused");
    // The dev server's admin (DEV_LOGIN): already an admin, said, not refused.
    await add("github", "tester", "read");
    await until(async () => (await hint()) == "tester is already an admin.", 5000, "tester is already an admin");
    // Ann's first sign-in, with that email verified: her account, with that role (no new documents).
    await annSignsIn();
    await join(`ann${id}`);
    expect(await makes()).toBe("403");
    await page.goto(`${root}/admin/access?user=tester`);
    expect(await page.$(waiting)).toBeNull();
    expect(await page.inputValue(ann)).toBe("read");
    // Her role changed on the page: she may write now.
    // (No Save button: the role saves as it changes, and the save mark says so.)
    const saved = page.waitForResponse((r) => r.url().includes("/api/tools/set_user"));
    await page.selectOption(ann, "write");
    await saved;
    await until(async () => (await page.inputValue(ann)) == "write" && (await markOf(page)) == "saved", 5000, "the role saved");
    expect(await makes()).toMatch(new RegExp(`^/ann${id}/`));
  });

  test("rules: a Workspace with write, a GitHub organization with read; anyone else is refused, and the page says nothing of the rules", async () => {
    const hint = () => page.textContent("#rules-hint");
    const addRule = async (kind: string, value: string, access: "read" | "write") => {
      await page.selectOption("form.add-rule select[name=kind]", kind);
      await page.fill("form.add-rule input[name=value]", value);
      await page.selectOption("form.add-rule select[name=access]", access);
      await page.click("form.add-rule button");
    };
    // No group has a rule yet, and Anyone lets no account in: this server is invite-only. A group gets one of two levels.
    await page.goto(`${root}/admin/access?user=tester`);
    expect(await page.$("ol.rules > li")).toBeNull();
    expect(await page.inputValue("#anyone-access")).toBe("public");
    expect(await page.$$eval("form.add-rule select[name=access] option", (os) => os.map((o) => o.textContent))).toEqual([
      "Can view documents",
      "Can create, edit and comment",
    ]);
    // A Workspace is named by its domain: one that isn't is refused, in place.
    await addRule("workspace", "not a domain", "write");
    await until(async () => (await hint())?.includes("isn't a domain"), 5000, "a bad domain refused");
    await addRule("workspace", "example.org", "write");
    await page.locator(rule("workspace", "example.org")).waitFor();
    await addRule("github_org", "acme", "read");
    await page.locator(rule("github_org", "acme")).waitFor();

    // A Workspace account of example.org (its group): write, so a new document.
    await signIn(AMY(id));
    await join(`amy${id}`);
    expect(await makes()).toMatch(new RegExp(`^/amy${id}/`));
    // The same email domain with no Workspace is a personal account: refused. The page says how she signed in and what
    // to do, and nothing of who may join: no Workspace, no domain, no organization.
    await signIn(BOB(id));
    expect((await page.innerText("main")).split("\n").filter(Boolean)).toEqual([
      "You need permission to join",
      `You signed in with Google as bob.${id}@example.org. Ask an admin of this Erga server to add you, then sign in again. Or sign in with another account.`,
    ]);
    // How a new account gets its username, on the Sign-in page. Until an admin chooses, each new person chooses, as
    // Amy did. The email prefix can't be chosen here, and says why under it. With the keys: Arrow up from "Users
    // choose" passes it, to "GitHub username", which saves by itself.
    const option = (rule: string) => `li.usernames input[value=${rule}]`;
    await page.goto(`${root}/admin/auth?user=tester`);
    expect(await page.isChecked(option("choose"))).toBe(true);
    expect(await page.isDisabled(option("email"))).toBe(true);
    expect(await page.innerText("li.usernames label:has(input[value=email]) .why")).toContain(
      "Now: Google is off; GitHub is on; 2 group rules give access."
    );
    await page.focus(option("choose"));
    await page.keyboard.press("ArrowUp");
    await until(async () => (await page.isChecked(option("github"))) && (await markOf(page)) == "saved", 5000, "the rule saved");
    // A member of acme: read, so no new document. GitHub is the one way in here (Google is off), so Erga names her
    // account by her login, and she is on her documents at once: no username step.
    await signIn(`provider=github&subject=${Date.now()}&handle=Dee-${id}&group=acme`);
    await until(() => path() == "/documents", 10_000, "dee's account made, with no username step");
    expect((await corner(page)).label).toBe(`You (dee-${id})`);
    expect((await page.goto(`${root}/new`))?.status()).toBe(403);
    expect(await page.textContent("main")).toContain("not make or edit documents");
    // Not a member: refused, with the same page.
    await signIn(`provider=github&subject=${Date.now() + 1}&handle=eve-${id}&group=other`);
    expect(await page.innerText("main")).toContain(`You signed in with GitHub as eve-${id}. Ask an admin of this Erga server to add you`);
    expect(await page.innerText("main")).not.toMatch(/acme|example\.org|organization|Workspace/);
  });

  test("Anyone's menu lets a refused person in; a rule removed lets nobody in any more; Users lists only the accounts with a role of their own, and Remove takes it away", async () => {
    // Anyone: Can view documents shared with them, with its menu. Bob (a personal account) may come in now.
    await page.goto(`${root}/admin/access?user=tester`);
    // Amy and Dee came in through their groups: no row. Ann has the role an admin gave her.
    expect(await page.$$eval("ol.users > li[data-login]", (ls) => ls.map((l) => (l as HTMLElement).dataset.login))).toEqual([
      `ann${id}`,
      "tester",
    ]);
    const saved = page.waitForResponse((r) => r.url().includes("/api/tools/set_access"));
    await page.selectOption("#anyone-access", "read");
    await saved;
    await until(
      async () => (await markOf(page)) == "saved" && (await page.textContent("#public-hint")) == "",
      5000,
      "Anyone's level saved"
    );
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    // Ann removed: her own role goes, and her row with it; Anyone decides her access (read: no new document).
    await page.click(`ol.users > li[data-login="ann${id}"] .remove`);
    await page.locator(`ol.users > li[data-login="ann${id}"]`).waitFor({ state: "detached" });
    // The Workspace rule removed: Amy keeps only Anyone's read.
    await page.click(`${rule("workspace", "example.org")} .remove-rule`);
    await page.locator(rule("workspace", "example.org")).waitFor({ state: "detached" });
    await signIn(BOB(id));
    await join(`bob${id}`);
    await signIn(AMY(id));
    await until(() => path() == "/documents", 10_000, "Amy signs in");
    expect(await makes()).toBe("403");
  });

  // (Cut list, brought back.) The values are the pretend GitHub's app (dev/vite-plugin.ts), which its live check accepts.
  test("an app's values typed on the Sign-in page save by themselves; the secret shows as its last 4 characters, with Replace and Remove; the GitHub card shows its new state in place, with the message", async () => {
    const CARD = 'section.server[data-provider="github"]';
    await page.goto(`${root}/admin/auth?user=tester`);
    await page.waitForSelector(CARD);
    // The first card is the mode (the deploy's: OAuth here), then a card for each provider.
    expect(await page.$$eval("section.auth > section", (cs) => cs.map((c) => (c as HTMLElement).dataset.mode ?? c.className).join())).toBe(
      "oauth,provider,provider"
    );
    expect(await page.$$eval("section.server", (cs) => cs.map((c) => (c as HTMLElement).dataset.provider).join())).toBe("github,google");
    const card = () =>
      page.evaluate((sel) => {
        const c = document.querySelector(sel)!;
        return {
          state: c.getAttribute("data-state"),
          id: c.querySelector(".client-id")?.textContent ?? null,
          hint: c.querySelector(".hint")?.textContent ?? "",
          clear: !!c.querySelector("button.clear"),
          stayed: !!(window as unknown as { stayed?: boolean }).stayed,
        };
      }, CARD);
    const before = await card();
    // A mark on this window: still here after each change, so the card came again in place, not with a load.
    await page.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });
    // Google's switch, with the keys: with two providers on, a GitHub username is one person's no more. The rule stays
    // chosen, and says in place that it has no effect; with Google off again, it says nothing.
    const note = () =>
      page
        .locator("li.usernames .why.warn")
        .innerText({ timeout: 100 })
        .catch(() => "");
    const google = 'section.provider[data-provider="google"] input[role=switch]';
    await page.focus(google);
    await page.keyboard.press("Space");
    await soon(note).toBe(
      "Not in effect: new users choose their usernames. Only while GitHub is the only sign-in provider. Now: Google is on."
    );
    expect(await page.isChecked("li.usernames input[value=github]")).toBe(true);
    await page.focus(google);
    await page.keyboard.press("Space");
    await soon(note).toBe("");
    // No Save button. The Client ID alone waits for the secret (the gray circle); with both, they save when the
    // typing pauses.
    expect(await page.locator(`${CARD} button:text-is("Save")`).count()).toBe(0);
    await page.fill(`${CARD} input[name=clientId]`, "Iv1.mockgithubapp0");
    await page.focus(`${CARD} input[name=secret]`);
    expect(await markOf(page)).toBe("saving");
    await page.keyboard.insertText("mock-github-client-secret");
    await soon(card).toEqual({
      state: "working",
      id: "Iv1.mockgithubapp0",
      hint: "GitHub accepts the values, and sign-in uses them now. Sign in with them to check the callback URL.",
      clear: true,
      stayed: true,
    });
    // The secret shows as its last 4 characters only, with Replace and Remove; the form to set other values is closed
    // until Replace, and Escape in it, with nothing typed, closes it again. The page never has the secret.
    expect(await page.textContent(`${CARD} .masked`)).toBe("•••• cret");
    expect(await page.locator(`${CARD} .secret-row button`).allInnerTexts()).toEqual(["Replace", "Remove"]);
    expect(await page.isHidden(`${CARD} form.configure`)).toBe(true);
    expect(await page.content()).not.toContain("mock-github-client-secret");
    await page.click(`${CARD} .replace`);
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name)).toBe("clientId");
    await page.keyboard.press("Escape");
    expect(await page.isHidden(`${CARD} form.configure`)).toBe(true);
    // A sign-in with them, in another tab: the gate's sign-in, GitHub's page (the pretend one, as Ada), the gate's
    // callback, which trades the code and signs her in one time. Then her list shows, and the next page asks no sign-in.
    const tab = await page.context().newPage();
    await tab.goto(`${root}/_edge/sign-in?idp=github&next=/documents`);
    expect(new URL(tab.url()).pathname).toBe("/__github/login/oauth/authorize");
    await tab.click("#authorize");
    await until(() => new URL(tab.url()).pathname == "/documents", 10_000, "signed in, and at her documents");
    await soon(async () => (await corner(tab)).label).toBe("You (Ada)");
    expect((await tab.request.get(`${root}/documents/archived`, { maxRedirects: 0 })).status()).toBe(200);
    await tab.close();
    // Remove asks first: yes.
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await page.click(`${CARD} button.clear`);
    await soon(card).toEqual({ ...before, hint: "Cleared: sign-in uses the deploy's values.", stayed: true });
  });

  test("a new server's setup page (local development shows it with no link): one row is open at a time; GitHub's button makes the app at GitHub, and the row is done", async () => {
    const rows = () =>
      page.$$eval("ol.steps details", (ds) =>
        ds.map(
          (d) => `${(d as HTMLElement).dataset.step} ${(d as HTMLElement).dataset.state}${(d as HTMLDetailsElement).open ? " open" : ""}`
        )
      );
    await page.goto(`${root}/setup`);
    expect(await rows()).toEqual(["github next open", "google next", "admin waiting"]);
    // A click on a row's title opens it, and closes the row that was open.
    await page.click("details[data-step=google] summary");
    expect(await rows()).toEqual(["github next", "google next open", "admin waiting"]);
    await page.click("details[data-step=github] summary");
    // The button posts the app's manifest to GitHub (the pretend one); Create comes back here, and the server keeps the app.
    await page.click("details[data-step=github] button");
    expect(new URL(page.url()).pathname).toBe("/__github/settings/apps/new");
    await page.click("#create");
    await until(() => new URL(page.url()).pathname == "/setup", 10_000, "back on the setup page");
    expect(await rows()).toEqual(["github done", "google optional", "admin next open"]);
    expect(await page.content()).not.toContain("mock-github-client-secret");
  });
});

/** A rule's row on the Access page, by its kind and (for a group) its name. */
const rule = (kind: string, value = "") => `ol.rules > li[data-kind="${kind}"]${value ? `:has(.title:text-is("${value}"))` : ""}`;
/** The pretend Google's answers: Amy, of the Workspace example.org (her group); Bob, a personal account with the same email domain. */
const AMY = (id: string) => `provider=google&subject=g${id}&handle=amy.${id}@example.org&email=amy.${id}@example.org&group=example.org`;
const BOB = (id: string) => `provider=google&subject=h${id}&handle=bob.${id}@example.org&email=bob.${id}@example.org`;

journey("a new person signs in, uses the account corner, signs out and signs in", () => {
  let page: Page, root: string;
  const sub = unique("g"),
    name = unique("nia");
  const PICTURE = "https://lh3.googleusercontent.com/a/nia";
  // (Her picture's address as Google's sign-in gives it: at the pages' size.)
  const signIn = () =>
    `${root}/auth/dev?provider=google&subject=${sub}&handle=${encodeURIComponent(`Nia.Ray.${sub}@example.com`)}&email=${encodeURIComponent(`nia.${sub}@example.com`)}&name=Nia&picture=${encodeURIComponent(`${PICTURE}=s64-c`)}&next=/documents`;
  const path = () => new URL(page.url()).pathname;
  /** Her document: its editor address (a path, with ?edit). */
  let at: string;
  const visible = (sel: string) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && getComputedStyle(el).visibility != "hidden" && getComputedStyle(el).opacity == "1";
    }, sel);

  test("the first sign-in asks for a username, checks it as it is typed, and makes the account", async ({ tab }) => {
    page = tab.page;
    root = s.root;
    await servePictures(page);
    await agentClosed(page);
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto(signIn());
    expect(path()).toBe("/auth/username");
    // Offered from the provider's name, made valid.
    expect(await page.inputValue("#username")).toBe(`nia-ray-${sub}`);
    const hint = () => page.textContent("#username-hint");
    await page.fill("#username", "admin");
    await until(async () => (await hint())?.includes("reserved"), 5000, "a reserved name is refused as it's typed");
    await page.fill("#username", "tester");
    await until(async () => (await hint())?.includes("taken"), 5000, "a name in use is refused as it's typed");
    // Sent anyway: the page says why, and nothing is made.
    await page.click("form.username button");
    await until(async () => path() == "/auth/username" && (await hint())?.includes("taken"), 5000, "the server refuses it too");
    await page.fill("#username", name);
    await until(async () => (await hint())?.includes("is free"), 5000, "a free name is free");
    await page.click("form.username button");
    await until(() => path() == "/documents", 10_000, "made, and on to where they were going");
    await soon(async () => (await corner(page)).label).toBe("You (Nia)");
  });

  test("on her documents list, her picture in the upper right opens her menu; Escape closes it; with no picture, her initial", async () => {
    let c = await corner(page);
    expect(c.state).toBe("in");
    expect(c.img).toBe(`${PICTURE}=s64-c`);
    expect(c.rect!.x + c.rect!.w).toBeGreaterThan(1100 - 24);
    expect(c.rect!.y).toBeLessThan(24);
    await clickOn(page, "[data-erga-account] button");
    c = await corner(page);
    expect(c.open).toBe(true);
    expect(c.who).toContain(name);
    // She is no admin: her menu has no admin pages. It ends with the way out.
    const links = c.links.map((l) => l.href);
    expect(links).toEqual(expect.arrayContaining(["/documents", "#settings", "#feedback"]));
    expect(links).not.toContain("/admin");
    expect(links.at(-1)).toBe("/auth/logout");
    await page.keyboard.press("Escape");
    await soon(async () => (await corner(page)).open).toBe(false);
    await page.evaluate(() => document.querySelector("[data-erga-account] img")?.dispatchEvent(new Event("error")));
    c = await corner(page);
    expect(c.img).toBeNull();
    expect(c.initial).toBe("N");
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-erga-account] button")!).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)"
    );
  });

  test("dark, the menu opens; at phone width the corner fits clear of the page's header, and its menu stays on screen", async () => {
    await page.emulateMedia({ colorScheme: "dark" });
    await clickOn(page, "[data-erga-account] button");
    expect((await corner(page)).open).toBe(true);
    await page.keyboard.press("Escape");
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 760 });
    const c = await corner(page);
    expect(c.rect!.x + c.rect!.w).toBeLessThanOrEqual(390 - 12);
    const overlaps = () =>
      page.evaluate(() => {
        const a = document.querySelector("[data-erga-account] button")!.getBoundingClientRect();
        return [...document.querySelectorAll("main header > *")].some((e) => {
          const b = e.getBoundingClientRect();
          return b.right > a.left && b.left < a.right && b.bottom > a.top && b.top < a.bottom;
        });
      });
    expect(await overlaps(), "overlaps the header").toBe(false);
    await clickOn(page, "[data-erga-account] button");
    expect(
      await page.evaluate(() => {
        const r = document.querySelector(".erga-account-menu")!.getBoundingClientRect();
        return r.width > 0 && r.left >= 0 && r.right <= innerWidth;
      })
    ).toBe(true);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1100, height: 720 });
  });

  test("her new document is under her username; in its editor her picture, far right, opens the menu, which stays open", async () => {
    await page.goto(`${root}/new`);
    await until(() => path().startsWith(`/${name}/`), 10_000, "a new document under the username");
    at = await where(page);
    await editorUp(page);
    // Its controls fade in: wait for where they end.
    await soon(() =>
      page.evaluate(() => {
        const b = document.querySelector("#me .avatar")!,
          r = b.getBoundingClientRect();
        return [r.right > 1100 - 30 && r.top < 30, b.querySelector("img")?.getAttribute("src")];
      })
    ).toEqual([true, `${PICTURE}=s64-c`]);
    // A press on the picture or the logo is a click: the browser doesn't drag either away.
    expect(
      await page.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>("#me .avatar img")!,
          brand = document.getElementById("nav-brand")!;
        return { img: img.draggable, imgDrag: getComputedStyle(img).getPropertyValue("-webkit-user-drag"), brand: brand.draggable };
      })
    ).toEqual({ img: false, imgDrag: "none", brand: false });
    await clickOn(page, "#me .avatar");
    const menu = () =>
      page.evaluate(() => ({
        hidden: document.getElementById("account")!.hidden,
        expanded: document.querySelector("#me .avatar")!.getAttribute("aria-expanded"),
        links: [...document.querySelectorAll<HTMLAnchorElement>("#account a:not([hidden])")].map((a) => a.getAttribute("href")),
      }));
    const open = await menu();
    expect([open.hidden, open.expanded]).toEqual([false, "true"]);
    expect(open.links).toEqual(expect.arrayContaining(["/documents", "#settings", "#feedback", "/auth/logout"]));
    expect(open.links).not.toContain("/admin");
    // Stays open: the same after the frames that follow the click.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0)))));
    expect((await menu()).hidden).toBe(false);
    await page.keyboard.press("Escape");
    await soon(() => page.evaluate(() => document.getElementById("account")!.hidden)).toBe(true);
    // The pencil beside it is on, and goes to the viewer.
    expect(
      await page.evaluate(() => {
        const e = document.getElementById("btn-edit")!;
        return { pressed: e.getAttribute("aria-pressed"), hidden: e.hidden, href: e.getAttribute("href") };
      })
    ).toEqual({ pressed: "true", hidden: false, href: plain(at) });
  });

  test("the owner adds someone in the Share card, sees them with their role and picture, and takes them off", async () => {
    // Someone with no account on this server (the shared server has an "ada" once another journey signs her in).
    const ada = unique("ada");
    const people = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#sharing-list li")].map((li) => ({
          who: li.querySelector(".who")!.firstChild!.textContent,
          note: li.querySelector(".who small")?.textContent ?? null,
          role: li.querySelector("select")?.value ?? null,
          picture: li.querySelector(".face img")?.getAttribute("src") ?? null,
        }))
      );
    await clickOn(page, "#btn-share");
    await until(
      () => page.evaluate(() => !document.getElementById("sharing")!.hidden && !!document.querySelector("#sharing-list li")),
      5000,
      "the Share button opens who has the document"
    );
    await page.evaluate((ada) => {
      const f = document.getElementById("sharing-add") as HTMLFormElement;
      (f.elements.namedItem("who") as HTMLInputElement).value = ada;
      (f.elements.namedItem("role") as HTMLSelectElement).value = "viewer";
      f.requestSubmit();
    }, ada);
    // Users share publicly here: the card offers anyone with the link (with the switch off, only Copy link stays).
    expect(await page.isVisible("#sharing-anyone")).toBe(true);
    // Each person shows their own picture, as the header's avatar does: the owner hers; ada, with no account, none.
    // The row shows at once, before the server answers; its answer adds that she can't sign in yet. (The step read the
    // row once, at whichever of the two it found: on GitHub's machine the answer came first, one run in 80.)
    await soon(async () => (await people()).slice(1)).toEqual([{ who: ada, note: "can't sign in yet", role: "viewer", picture: null }]);
    expect((await people())[0]).toMatchObject({ note: "you", picture: `${PICTURE}=s64-c` });
    await page.evaluate(
      (ada) =>
        (
          [...document.querySelectorAll("#sharing-list li")]
            .find((li) => li.querySelector(".who")!.firstChild!.textContent == ada)!
            .querySelector(".remove") as HTMLElement
        ).click(),
      ada
    );
    await soon(async () => (await people()).length).toBe(1);
    // The controls, left to right up to her avatar: new document (+), full screen, then the editor's own (share,
    // document settings), edit, share with an agent, Documents.
    expect(
      await page.evaluate(() => [...document.querySelectorAll(".chrome-top .icon-btn:not([hidden])")].map((e) => e.id).join(" "))
    ).toBe("btn-new btn-full btn-share btn-settings btn-edit btn-agent-share btn-documents");
    await page.keyboard.press("Escape");
  });

  test("the pencil switches between viewing and editing without a reload, the document where it was; Back goes to the viewer", async () => {
    const h1 = async () =>
      (
        await inPage<number | null>(
          page,
          `document.querySelector("h1") ? Math.round(document.querySelector("h1").getBoundingClientRect().top) : null`
        )
      ).find((t) => t != null) ?? null;
    // Neither the document nor anything around it bounces past its ends (macOS's rubber band), so the controls never move.
    const still = `getComputedStyle(document.documentElement).overscrollBehaviorY`;
    const bounce = async () =>
      [(await page.evaluate(still)) as string, ...(await inFrames<string>(page, still)), ...(await inPage<string>(page, still))].filter(
        (v) => v != null
      );
    const editingTop = await until(h1, 5000, "the page shows in the editor");
    for (const v of await bounce()) expect(v, "editing, overscroll").toBe("none");
    await page.evaluate(() => {
      (window as any).__samePage = true;
    });
    await clickOn(page, "#btn-edit");
    await until(
      async () => (await where(page)) == plain(at) && (await visible(".erga-view-buttons")) && !(await visible("#erga-editor")),
      5000,
      "the pencil goes back to the viewer"
    );
    await until(async () => (await h1()) != null, 5000, "the viewer's page shows");
    const viewing = await bounce();
    expect(viewing.length).toBeGreaterThanOrEqual(3);
    for (const v of viewing) expect(v, "viewing, overscroll").toBe("none");
    expect(await visible(".erga-crumbs"), "viewing, the viewer's breadcrumbs").toBe(true);
    expect(await page.evaluate(() => document.getElementById("doc-title")!.checkVisibility()), "viewing, the editor's title").toBe(false);
    expect(await h1()).toBe(editingTop);
    await clickOn(page, ".erga-edit-button");
    await until(
      async () =>
        (await where(page)) == at &&
        (await visible("#erga-editor")) &&
        (await page.evaluate(() => document.getElementById("doc-title")!.checkVisibility())),
      5000,
      "the pencil goes back into the editor"
    );
    expect(await page.evaluate(() => (window as any).__samePage === true), "neither reloaded the page").toBe(true);
    await page.evaluate(() => history.back());
    await until(async () => (await where(page)) == plain(at) && (await visible(".erga-view-buttons")), 5000, "Back goes to the viewer too");
  });

  test("the next sign-in asks for no username; Sign out leaves nobody signed in, and Sign in comes back to the same page", async () => {
    await page.goto(signIn());
    await until(() => path() == "/documents", 10_000, "no username step the second time");
    await soon(async () => (await corner(page)).label).toBe("You (Nia)");
    // (Sign-out loads the gate's sign-out on the documents' site, in a hidden frame of its page.)
    const gate: string[] = [];
    page.on("response", (r) => void (r.url().includes("/_edge/sign-out") && gate.push(`${r.status()} ${r.url()}`)));
    await clickOn(page, "[data-erga-account] button");
    await clickOn(page, `.erga-account-menu a[href="/auth/logout"]`);
    await until(() => path() == "/", 10_000, "signing out goes to the homepage");
    // The gate's cookies are gone from the browser, here and on the documents' site (another site: <id>.localhost).
    expect(gate).toEqual([`200 http://accept.localhost:${new URL(root).port}/_edge/sign-out`]);
    expect((await page.context().cookies()).filter((c) => /^(erga|member)_\d+$/.test(c.name))).toEqual([]);
    // Signed out: a person in a circle, whose menu has only Sign in.
    await page.goto(`${root}/nobody-here`);
    let c = await corner(page);
    expect([c.state, c.label, c.img]).toEqual(["out", "Sign in", null]);
    await clickOn(page, "[data-erga-account] button");
    c = await corner(page);
    expect(c.open).toBe(true);
    expect(c.links).toEqual([{ text: "Sign in", href: "/auth/sign-in?next=%2Fnobody-here" }]);
    // Dark, on a phone, it opens too.
    await page.keyboard.press("Escape");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 760 });
    await clickOn(page, "[data-erga-account] button");
    expect((await corner(page)).open).toBe(true);
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1100, height: 720 });
    await clickOn(page, ".erga-account-sign-in");
    await until(async () => (await corner(page)).state == "in", 10_000, "signed in again");
    expect(path()).toBe("/nobody-here");
  });
});
