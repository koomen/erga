// How a new account gets its username (server/identity/usernames.ts; the setting usernames, a radio on /admin/auth):
// when each rule may be chosen, whom it names, and what a new account gets when its condition holds no more or its
// name is not free. The conditions with no server; the sign-ins on the whole app in memory (tests/helpers/app.ts),
// through local development's pretend provider (/auth/dev).

import { expect, test } from "bun:test";
import { assigned, type UsernameFacts, whyNot } from "../server/identity/usernames.ts";
import { runTool, server } from "./helpers/app.ts";
import { github, google } from "./accounts.test.ts";

const ADMIN = { login: "tester", admin: true };
/** A server as the conditions read it: GitHub alone, no group rule, Anyone at "No access", unless said. */
const facts = (f: Partial<UsernameFacts> = {}): UsernameFacts => ({ ways: ["github"], rules: [], anyone: "none", ...f });
const WORKSPACE = { kind: "workspace" as const, value: "example.org" };
/** One Google Workspace is the one way in. */
const ORG = facts({ ways: ["google"], rules: [WORKSPACE] });
/** A Google account of the Workspace example.org. */
const member = (sub: string, email: string) => ({ ...google(sub, email), groups: ["workspace:example.org"] });

test("github: only while GitHub is the only provider that is on", () => {
  expect(whyNot("github", facts())).toBeNull();
  expect(whyNot("github", facts({ ways: ["github", "google"] }))).toBe("Google is on");
  expect(whyNot("github", facts({ ways: ["google"] }))).toBe("GitHub is off; Google is on");
  expect(whyNot("github", facts({ ways: ["sso"] }))).toBe("this server uses single sign-on");
  // The group rules and Anyone's level change nothing: a GitHub login is one person's, whoever may sign in.
  expect(whyNot("github", facts({ rules: [WORKSPACE, { kind: "github_org", value: "acme" }], anyone: "write" }))).toBeNull();
});

test("email: only while Google is the only provider, one Google Workspace is the only group rule, and Anyone lets no account in", () => {
  expect(whyNot("email", ORG)).toBeNull();
  // Anyone may view public documents: still no account comes in by it.
  expect(whyNot("email", { ...ORG, anyone: "public" })).toBeNull();
  const now = (f: Partial<UsernameFacts>) => whyNot("email", { ...ORG, ...f });
  expect(now({ ways: ["github", "google"] })).toBe("GitHub is on");
  expect(now({ ways: ["github"] })).toBe("Google is off; GitHub is on");
  expect(now({ rules: [] })).toBe("no group rule gives access");
  expect(now({ rules: [WORKSPACE, { kind: "workspace", value: "example.net" }] })).toBe("2 group rules give access");
  expect(now({ rules: [{ kind: "github_org", value: "acme" }] })).toBe("the one group rule is a GitHub organization");
  for (const anyone of ["read", "write"] as const) expect(now({ anyone })).toBe("Anyone can sign in");
  // Each condition that fails is said.
  expect(whyNot("email", facts({ anyone: "write" }))).toBe("Google is off; GitHub is on; no group rule gives access; Anyone can sign in");
});

test("email fits single sign-on, whatever the rules are; users choose, always", () => {
  expect(whyNot("email", facts({ ways: ["sso"], anyone: "write" }))).toBeNull();
  for (const f of [facts(), ORG, facts({ ways: ["sso"] }), facts({ ways: ["github", "google"], anyone: "write" })])
    expect(whyNot("choose", f)).toBeNull();
});

test("whom a rule names: the GitHub login, or a verified address's prefix of the one Workspace; anyone else chooses", () => {
  expect(assigned("github", facts(), github(1, "Ada-L"))).toBe("ada-l");
  expect(assigned("choose", facts(), github(1, "ada"))).toBeNull();
  // The condition holds no more: nobody is named.
  expect(assigned("github", facts({ ways: ["github", "google"] }), github(1, "ada"))).toBeNull();
  expect(assigned("email", ORG, member("g1", "Erin.Smith@example.org"))).toBe("erin-smith");
  expect(
    assigned("email", { ...ORG, rules: [WORKSPACE, { kind: "github_org", value: "acme" }] }, member("g1", "erin@example.org"))
  ).toBeNull();
  // Someone an admin added, outside the Workspace: a personal account, another Workspace, an address of another domain.
  expect(assigned("email", ORG, google("g2", "erin@example.org"))).toBeNull();
  expect(assigned("email", ORG, { ...google("g3", "erin@example.net"), groups: ["workspace:example.net"] })).toBeNull();
  expect(assigned("email", ORG, member("g4", "erin@example.net"))).toBeNull();
  // An address that Google did not verify names nobody.
  expect(
    assigned("email", ORG, { ...member("g5", "erin@example.org"), emails: [{ email: "erin@example.org", verified: false }] })
  ).toBeNull();
  // Single sign-on: the address the gate gives; none, no name.
  const sso = (email: string) => ({
    provider: "sso",
    subject: "s",
    handle: email,
    name: null,
    emails: email ? [{ email, verified: true }] : [],
  });
  expect(assigned("email", facts({ ways: ["sso"] }), sso("pete@example.com"))).toBe("pete");
  expect(assigned("email", facts({ ways: ["sso"] }), sso(""))).toBeNull();
});

/** The username page that a sign-in's answer goes to: its hint, and the name in its field. */
async function step(s: ReturnType<typeof server>, at: Response) {
  expect(at.headers.get("location")).toBe("/auth/username");
  const cookie = at.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const page = await (await s.fetch("/auth/username", { headers: { Cookie: cookie } })).text();
  return { hint: /id="username-hint">(.*?)<\/p>/.exec(page)![1], offered: /name="username" value="([^"]*)"/.exec(page)![1] };
}

test("usernames: github. A new account is its GitHub login, at once; a login that an account holds, or a second provider: its person chooses", async () => {
  const s = server();
  const ids = s.platform.directory.identities;
  const signIn = (subject: number, handle: string) =>
    s.fetch(`/auth/dev?provider=github&subject=${subject}&handle=${handle}&next=/documents`);
  // Until an admin chooses a rule, each new person chooses.
  expect((await step(s, await signIn(500, "zed"))).offered).toBe("zed");
  expect((await runTool(s, "set_setting", { key: "usernames", value: "github" })).status).toBe(200);
  expect((await signIn(501, "Ada")).headers.get("location")).toBe("/documents");
  expect((await ids.find("github", "501"))?.login).toBe("ada");
  // Ada renamed her GitHub account, and another person has the login now: never a second ada, and no silent ada2.
  expect(await step(s, await signIn(502, "ada"))).toEqual({ hint: "The Erga account <b>ada</b> is already taken.", offered: "ada2" });
  expect(await ids.find("github", "502")).toBeNull();
  // A login that is one of Erga's own addresses: its person chooses too.
  expect((await step(s, await signIn(503, "docs"))).offered).toBe("docs2");
  // Google goes on with no admin's change (the deploy's): the rule stays, with no effect. A new person chooses, and the
  // settings say why.
  await s.platform.own.put("auth:providers", { github: true, google: true });
  expect((await step(s, await signIn(504, "bo"))).offered).toBe("bo");
  const now = (await runTool(s, "settings")).result.settings.find((e: { key: string }) => e.key == "usernames");
  expect([now.value, now.inEffect]).toEqual(["github", "choose"]);
  expect(now.note).toBe("Not in effect now (Google is on): new users choose their usernames.");
  // Google goes off again: the rule applies again.
  await s.platform.own.put("auth:providers", { github: true, google: false });
  expect((await signIn(504, "bo")).headers.get("location")).toBe("/documents");
  // The accounts made before keep their usernames, whatever the rule is now.
  await runTool(s, "set_setting", { key: "usernames", value: "choose" });
  expect((await signIn(501, "ada-renamed")).headers.get("location")).toBe("/documents");
  expect((await ids.find("github", "501"))?.login).toBe("ada");
  // An admin turns Google on while the rule is github: the server asks first, with what will happen, and nothing
  // changed. To proceed turns Google on, and the rule is choose.
  await runTool(s, "set_setting", { key: "usernames", value: "github" });
  const google = { provider: "google", action: "on" };
  expect(await runTool(s, "set_sign_in", google)).toMatchObject({
    status: 428,
    error:
      "Usernames are assigned based on GitHub username, which requires GitHub to be the only provider. If you proceed, each new user will choose their own username.",
  });
  expect(await s.platform.directory.config.get("usernames")).toBe("github");
  expect((await runTool(s, "set_sign_in", { ...google, proceed: true })).result.providersOn).toEqual({ github: true, google: true });
  expect(await s.platform.directory.config.get("usernames")).toBe("choose");
});

test("usernames: email. The server refuses the rule until one Google Workspace is the only way in; then a new account is its address's prefix", async () => {
  const s = server();
  const dir = s.platform.directory;
  const set = (value: string) => runTool(s, "set_setting", { key: "usernames", value });
  const signIn = (q: string) => s.fetch(`/auth/dev?provider=google&${q}&next=/documents`);
  const of = (sub: string, email: string, group = "example.org") =>
    `subject=${sub}&handle=${email}&email=${email}${group ? `&group=${group}` : ""}`;
  // GitHub alone is on, and no group has a rule: refused, with what the rule needs and what fails now.
  const refused = await set("email");
  expect(refused.status).toBe(400);
  expect(refused.error).toBe(`usernames can't be "email" now: Google is off; GitHub is on; no group rule gives access. Nothing changed.`);
  expect(await dir.config.get("usernames")).toBe("choose");
  await s.platform.own.put("auth:providers", { github: false, google: true });
  await dir.rules.add(ADMIN, { kind: "workspace", value: "example.org", access: "write" });
  await dir.setAnyone(ADMIN, "none");
  expect((await set("email")).status).toBe(200);
  // A member of the Workspace: her address's prefix, at once.
  expect((await signIn(of("g1", "Erin.Smith@example.org"))).headers.get("location")).toBe("/documents");
  expect((await dir.identities.find("google", "g1"))?.login).toBe("erin-smith");
  // Another address that gives the same name: its person chooses, and the page says that the name is taken.
  expect(await step(s, await signIn(of("g2", "erin_smith@example.org")))).toEqual({
    hint: "The Erga account <b>erin-smith</b> is already taken.",
    offered: "erin-smith2",
  });
  // Someone an admin added from outside the Workspace (a personal account): they choose.
  await dir.addUser(ADMIN, { provider: "google", handle: "erin.smith@example.net" }, "read");
  expect((await step(s, await signIn(of("g3", "erin.smith@example.net", "")))).offered).toBe("erin-smith2");
  // A second group rule would stop the rule: the server asks first, with what will happen, and nothing changed. The
  // same for Anyone's level, by either operation, and for the one rule's removal. A change that stops nothing is made.
  const ENDS =
    "Usernames are assigned based on email prefix, which requires access limited to a single Google Workspace. If you proceed, each new user will choose their own username.";
  const second = { action: "add", kind: "workspace", value: "Example.net", access: "read" };
  const [{ id }] = await dir.rules.all();
  for (const [tool, args] of [
    ["set_access", second],
    ["set_access", { action: "anyone", level: "read" }],
    ["set_setting", { key: "anyone_access", value: "write" }],
    ["set_access", { action: "remove", id }],
  ] as const)
    expect(await runTool(s, tool, args)).toMatchObject({ status: 428, error: ENDS });
  expect([(await dir.rules.all()).length, await dir.anyone(), await dir.config.get("usernames")]).toEqual([1, "none", "email"]);
  expect((await runTool(s, "set_access", { action: "add", kind: "workspace", value: "example.org", access: "read" })).status).toBe(200);
  expect((await runTool(s, "set_access", { action: "anyone", level: "public" })).status).toBe(200);
  expect(await dir.config.get("usernames")).toBe("email");
  // To proceed makes the change, and each new person chooses from then on. No rule is set now: the next change asks nothing.
  expect((await runTool(s, "set_access", { ...second, proceed: true })).status).toBe(200);
  expect([(await dir.rules.all()).length, await dir.config.get("usernames")]).toEqual([2, "choose"]);
  expect((await step(s, await signIn(of("g4", "flo@example.org")))).offered).toBe("flo");
  expect((await runTool(s, "set_access", { action: "anyone", level: "read" })).status).toBe(200);
  // An agent may not set a rule that can't apply; a value that is no rule is refused as any setting's.
  expect((await set("github")).error).toContain("now: GitHub is off; Google is on.");
  expect((await set("login")).error).toBe("usernames must be one of: github, email, choose.");
});
