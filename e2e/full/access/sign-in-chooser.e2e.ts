// The sign-in page (/auth/sign-in, server/identity/sign-in.ts): with one provider on it goes straight to that one's
// sign-in, keeping where to come back to; with both on, a button for each, its text and logo visible, light and dark.
// From a document's address, signed out, it says what the person will open: the same for a private document and for
// an address with no document.
// It switches Google on, so it has a server of its own.
import { expect, type Page, servers, test } from "../../helpers/fixtures";
import { getter, newDoc } from "./access";
import { runTool } from "../../helpers/tools";

const server = () => servers.of("sign-in-chooser");
await server();

/** The page's provider buttons: text, link, colours and the logo's width. */
const buttonsOf = (page: Page) =>
  page.$$eval("a.provider", (as) =>
    as.map((a) => {
      const s = getComputedStyle(a),
        logo = a.querySelector("svg")?.getBoundingClientRect().width ?? 0;
      return { text: a.textContent!.trim(), href: a.getAttribute("href"), color: s.color, background: s.backgroundColor, logo };
    })
  );

const BOTH = [
  ["Continue with GitHub", "/auth/github?next=%2Fdocs"],
  ["Continue with Google", "/auth/google?next=%2Fdocs"],
];

test("one provider on: /auth/sign-in goes straight to it; both on: a button for each, readable light and dark, and what the person will open", async ({
  tab,
}) => {
  const root = (await server()).root,
    get = getter(root),
    page = tab.page;
  const one = await get("/auth/sign-in?next=%2Fdocs");
  expect(one.status).toBe(302);
  expect(one.headers.get("location")).toBe("/auth/github?next=%2Fdocs");

  const turn = (on: boolean) => runTool(root, "set_sign_in", { provider: "google", action: on ? "on" : "off" });
  expect((await turn(true)).status).toBe(200);
  try {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${root}/auth/sign-in?next=%2Fdocs`);
      const buttons = await buttonsOf(page);
      expect(buttons.map((b) => [b.text, b.href])).toEqual(BOTH);
      for (const b of buttons)
        expect(`${scheme} ${b.text}: ${b.color}, logo ${b.logo > 0}`).toBe(`${scheme} ${b.text}: ${b.color}, logo true`);
      for (const b of buttons) expect(b.color).not.toBe(b.background);
      expect(await page.textContent("main")).not.toContain("same account");
    }
    // Signed out, a private document's address and an address with no document give the same page: the heading, the
    // address asked for, the buttons back to it. A stranger learns nothing from it.
    const made = new URL((await newDoc(root)).at.replace(/[?&]edit=?$/, ""), root).pathname;
    await page.context().addCookies([{ name: `erga_signed_out_${new URL(root).port}`, value: "1", url: root }]);
    const shown = [];
    for (const address of [made, "/nobody/nothing-here"]) {
      await page.goto(`${root}${address}`);
      expect(new URL(page.url()).pathname).toBe("/auth/sign-in");
      const host = new URL(root).host;
      expect((await page.innerText("main")).split("\n").filter(Boolean)).toEqual([
        "Sign in to open this document",
        `${host}${address}`,
        "Continue with GitHub",
        "Continue with Google",
        "New here? The same buttons make your account.",
      ]);
      shown.push((await page.innerHTML("main")).replaceAll(address, "ADDRESS").replaceAll(encodeURIComponent(address), "ADDRESS"));
    }
    expect(shown[1]).toBe(shown[0]);
    await page.context().clearCookies({ name: `erga_signed_out_${new URL(root).port}` });
    await page.goto(`${root}/auth/sign-in?next=%2Fdocs`);
    expect(await page.textContent("main h1")).toBe("Sign in");
    // The GitHub button signs in (local development's sign-in) and comes back to /docs.
    await page.click("a.provider.github");
    await page.waitForURL(`${root}/docs`);
  } finally {
    await turn(false);
  }
});
