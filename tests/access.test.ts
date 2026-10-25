// The access rules (server/directory/directory.ts, "the access rules"): read (who may sign in) and write (who may
// make and edit documents), each anyone or only some: listed accounts, Google accounts with a verified email on given
// domains, GitHub accounts in given organizations. Admins always pass. On an in-memory database with D1's migrations.

import { expect, test } from "bun:test";
import { accessRule, ConfigError, Directory, type Vouched } from "../server/directory/index.ts";
import { resolve } from "../server/identity/accounts.ts";
import { memory } from "./memory-sql.ts";

const ADMIN = { login: "koomen", admin: true };
const google = (sub: string, email: string, verified = true): Vouched => ({ provider: "google", subject: sub, handle: email, name: null, emails: [{ email, verified }] });
const github = (id: number, login: string, orgs: string[] | null = null): Vouched => ({ provider: "github", subject: String(id), handle: login, name: null, emails: [], orgs });
const fresh = () => new Directory(memory(), { admins: ["koomen"] });
/** An account someone made themselves (unlisted), as the username step makes it when a rule let them in. */
const joined = (dir: Directory, name: string, v: Vouched) => dir.identities.createAccount(name, v, { listed: false });
const setRule = (dir: Directory, which: "read" | "write", rule: unknown) => dir.config.set(ADMIN, which == "read" ? "access_read" : "access_write", rule);

test("a rule as given: anyone, or some with domains and organizations, each checked", () => {
  expect(accessRule("anyone")).toEqual({ mode: "anyone", domains: [], orgs: [] });
  expect(accessRule({ mode: "some", domains: "Example.com, @example.org", orgs: ["My-Org"] })).toEqual({ mode: "some", domains: ["example.com", "example.org"], orgs: ["my-org"] });
  expect(accessRule("listed")).toEqual({ mode: "some", domains: [], orgs: [] });
  expect(() => accessRule({ mode: "some", domains: ["not a domain"] })).toThrow(ConfigError);
  expect(() => accessRule({ mode: "some", orgs: ["-bad"] })).toThrow(ConfigError);
  expect(() => accessRule("everyone")).toThrow(ConfigError);
});

test("by default only listed accounts sign in (as before), and anyone of them may write; admins always pass", async () => {
  const dir = fresh();
  await dir.users.add(ADMIN, "ada");
  await joined(dir, "bo", google("g-bo", "bo@example.com"));
  expect(await dir.users.allowed("ada")).toBe(true);
  expect(await dir.users.allowed("bo")).toBe(false);
  expect(await dir.users.allowed("koomen")).toBe(true);
  expect(await dir.mayJoin(google("g-new", "x@example.com"))).toBe(false);
  // An admin lists bo: in.
  await dir.users.setListed(ADMIN, "bo", true);
  expect(await dir.users.allowed("bo")).toBe(true);
});

test("read anyone: every account, and anyone may make one", async () => {
  const dir = fresh();
  await setRule(dir, "read", "anyone");
  await joined(dir, "bo", google("g-bo", "bo@example.com"));
  expect(await dir.users.allowed("bo")).toBe(true);
  expect(await dir.mayJoin(google("g-new", "x@elsewhere.example", false))).toBe(true);
  expect(await dir.mayJoin(github(9, "someone"))).toBe(true);
});

test("domains: a Google account's verified email on one of them (exactly); never a GitHub account's", async () => {
  const dir = fresh();
  await setRule(dir, "read", { mode: "some", domains: ["example.com"] });
  expect(await dir.mayJoin(google("g1", "a@example.com"))).toBe(true);
  expect(await dir.mayJoin(google("g2", "a@example.com", false))).toBe(false);
  expect(await dir.mayJoin(google("g3", "a@sub.example.com"))).toBe(false);
  expect(await dir.mayJoin({ ...github(1, "gh"), emails: [{ email: "gh@example.com", verified: true }] })).toBe(false);
  await joined(dir, "cy", google("g1", "cy@example.com"));
  expect(await dir.users.allowed("cy")).toBe(true);
  // Google says another email at the next sign-in: the rule reads that one now.
  expect((await resolve(dir, google("g1", "cy@other.example"), { join: false })).kind).toBe("refused");
  expect(await dir.users.allowed("cy")).toBe(false);
});

test("organizations: a GitHub account in one of them, as GitHub answered at its last sign-in, recorded", async () => {
  const dir = fresh();
  await setRule(dir, "read", { mode: "some", orgs: ["acme"] });
  expect(await dir.mayJoin(github(1, "dee", ["acme", "other"]))).toBe(true);
  expect(await dir.mayJoin(github(2, "eve", ["other"]))).toBe(false);
  expect(await dir.mayJoin(github(3, "fay", null))).toBe(false);
  await joined(dir, "dee", github(1, "dee", ["acme"]));
  expect((await dir.identities.find("github", "1"))?.orgs).toEqual(["acme"]);
  expect(await resolve(dir, github(1, "dee", ["acme"]), { join: false })).toEqual({ kind: "in", login: "dee" });
  // She left acme: her next sign-in records it, and she's refused.
  expect((await resolve(dir, github(1, "dee", []), { join: false })).kind).toBe("refused");
  expect((await dir.identities.find("github", "1"))?.orgs).toEqual([]);
  // A Google account never passes an organization.
  await joined(dir, "gus", google("g-gus", "gus@acme.example"));
  expect(await dir.users.allowed("gus")).toBe(false);
});

test("write: someone it leaves out opens their documents and those shared with them as a viewer, and may not make one", async () => {
  const dir = fresh();
  await setRule(dir, "read", "anyone");
  await setRule(dir, "write", { mode: "some", domains: ["example.com"] });
  await joined(dir, "hal", google("g-hal", "hal@elsewhere.example"));
  await joined(dir, "ida", google("g-ida", "ida@example.com"));
  for (const [id, owner] of [["aaaaaaaa", "hal"], ["bbbbbbbb", "ida"]]) await dir.add({ id, owner, title: "Plan", created: 1, expires: null });
  expect(await dir.access({ login: "hal" }, (await dir.get("aaaaaaaa"))!)).toBe("viewer");
  expect(await dir.access({ login: "ida" }, (await dir.get("bbbbbbbb"))!)).toBe("owner");
  expect(await dir.mayWrite("hal")).toBe(false);
  expect(await dir.mayWrite("ida")).toBe(true);
  // An admin always may; listing hal lets him write.
  expect(await dir.mayWrite("koomen")).toBe(true);
  await dir.users.setListed(ADMIN, "hal", true);
  expect(await dir.access({ login: "hal" }, (await dir.get("aaaaaaaa"))!)).toBe("owner");
});

test("an invitation by email lets that Google address make an account, under any rule; it can't name a noreply address", async () => {
  const dir = fresh();
  await dir.users.invite(ADMIN, "Jo@Example.com", "admin");
  expect(await dir.mayJoin(google("g-jo", "jo@example.com"))).toBe(true);
  expect(await dir.mayJoin(google("g-jo", "jo@example.com", false))).toBe(false);
  expect((await dir.users.invites(ADMIN)).map((i) => [i.email, i.role])).toEqual([["jo@example.com", "admin"]]);
  await expect(dir.users.invite(ADMIN, "1+x@users.noreply.github.com")).rejects.toThrow("noreply");
  await expect(dir.users.invite({ login: "bo" }, "x@example.com")).rejects.toThrow("Only an admin");
  await dir.users.uninvite(ADMIN, "jo@example.com");
  expect(await dir.mayJoin(google("g-jo", "jo@example.com"))).toBe(false);
});

test("only admins change the rules and the list; an admin can't be taken off the list", async () => {
  const dir = fresh();
  await expect(dir.config.set({ login: "bo" }, "access_read", "anyone")).rejects.toThrow();
  await dir.users.add(ADMIN, "kit", { role: "admin" });
  await expect(dir.users.setListed(ADMIN, "kit", false)).rejects.toThrow("is an admin");
});

test("a GitHub sign-in's organizations: active memberships only, as the pretend GitHub answers the person's token; none when it can't", async () => {
  const { mockGithub } = await import("../dev/github-mock");
  const { memberships } = await import("../server/identity/sign-in");
  const gh = mockGithub({ app: { slug: "erga-editor", clientId: "Iv1.x", clientSecret: "s" }, origin: "https://gh.test", callback: "https://erga.test/auth/github/callback", orgs: ["Acme", "other"] });
  gh.state.tokens.push({ token: "ghu_ada", kind: "user", login: "ada" });
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => gh.fetch(new Request(new URL(String(input instanceof Request ? input.url : input).replace("https://gh.test/api", "https://gh.test/__github/api")), init)).then((r) => r ?? new Response("", { status: 404 }))) as typeof fetch;
  try {
    expect(await memberships("https://gh.test/api", "ghu_ada")).toEqual(["acme", "other"]);
    expect(await memberships("https://gh.test/api", "ghu_unknown")).toEqual([]);
  } finally { globalThis.fetch = real; }
});
